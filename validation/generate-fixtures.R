#!/usr/bin/env Rscript

# Deterministic, dependency-light golden-fixture generator for jGDINA v1.
#
# The numerical oracle below is an independent base-R implementation of the
# single-group, binary-attribute GDINA/DINA/DINO equations.  jsonlite is used
# only for serialization; the downloaded GDINA package is not loaded.

if (!requireNamespace("jsonlite", quietly = TRUE)) {
  stop("jsonlite is required to serialize the golden fixtures", call. = FALSE)
}

script_path <- function() {
  arg <- grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
  candidate <- if (length(arg)) sub("^--file=", "", arg[[1L]]) else ""
  if (!nzchar(candidate) || candidate == "-" || !file.exists(candidate)) {
    candidate <- "validation/generate-fixtures.R"
  }
  normalizePath(candidate)
}

repo_root <- normalizePath(file.path(dirname(script_path()), ".."))

attribute_patterns <- function(k) {
  stopifnot(length(k) == 1L, k >= 1L, k == as.integer(k))
  out <- matrix(0L, nrow = 1L, ncol = k)
  for (order in seq_len(k)) {
    combinations <- utils::combn(k, order)
    for (column in seq_len(ncol(combinations))) {
      row <- integer(k)
      row[combinations[, column]] <- 1L
      out <- rbind(out, row)
    }
  }
  out
}

design_matrix <- function(kj, model) {
  local <- attribute_patterns(kj)
  model <- toupper(model)
  if (model == "DINA") {
    return(cbind(1L, as.integer(rowSums(local) == kj)))
  }
  if (model == "DINO") {
    return(cbind(1L, as.integer(rowSums(local) > 0L)))
  }
  if (model != "GDINA") stop("Unsupported v1 model: ", model, call. = FALSE)

  out <- cbind(1L, local)
  if (kj >= 2L) {
    for (order in 2:kj) {
      combinations <- utils::combn(kj, order)
      for (column in seq_len(ncol(combinations))) {
        out <- cbind(out, apply(local[, combinations[, column], drop = FALSE], 1L, prod))
      }
    }
  }
  unname(out)
}

eta_matrix <- function(q_matrix, patterns = attribute_patterns(ncol(q_matrix))) {
  q_matrix <- as.matrix(q_matrix)
  eta <- matrix(0L, nrow = nrow(q_matrix), ncol = nrow(patterns))
  for (j in seq_len(nrow(q_matrix))) {
    required <- which(q_matrix[j, ] == 1L)
    if (length(required) == 0L) stop("Every v1 item must require at least one attribute", call. = FALSE)
    local <- attribute_patterns(length(required))
    keys <- apply(local, 1L, paste0, collapse = "")
    observed_keys <- apply(patterns[, required, drop = FALSE], 1L, paste0, collapse = "")
    eta[j, ] <- match(observed_keys, keys) - 1L
  }
  eta
}

latent_class_probabilities <- function(item_probabilities, eta) {
  out <- matrix(NA_real_, nrow = nrow(eta), ncol = ncol(eta))
  for (j in seq_len(nrow(eta))) out[j, ] <- item_probabilities[[j]][eta[j, ] + 1L]
  out
}

log_sum_exp_rows <- function(x) {
  maxima <- apply(x, 1L, max)
  maxima + log(rowSums(exp(x - maxima)))
}

e_step <- function(responses, weights, item_probabilities, prior, eta) {
  responses <- as.matrix(responses)
  storage.mode(responses) <- "double"
  n <- nrow(responses)
  class_probability <- latent_class_probabilities(item_probabilities, eta)
  conditional_log_likelihood <- matrix(0, nrow = n, ncol = ncol(eta))

  for (j in seq_len(ncol(responses))) {
    observed <- which(!is.na(responses[, j]))
    if (length(observed) == 0L) next
    x <- responses[observed, j]
    p <- class_probability[j, ]
    conditional_log_likelihood[observed, ] <-
      conditional_log_likelihood[observed, , drop = FALSE] +
      outer(x, log(p)) + outer(1 - x, log1p(-p))
  }

  log_joint <- sweep(conditional_log_likelihood, 2L, log(prior), "+")
  marginal_log_likelihood <- log_sum_exp_rows(log_joint)
  posterior <- exp(log_joint - marginal_log_likelihood)

  list(
    class_probability = class_probability,
    conditional_log_likelihood = conditional_log_likelihood,
    marginal_log_likelihood = marginal_log_likelihood,
    posterior = posterior,
    log_likelihood = sum(weights * marginal_log_likelihood)
  )
}

expected_counts <- function(responses, weights, posterior, eta) {
  responses <- as.matrix(responses)
  j_count <- ncol(responses)
  totals <- correct <- vector("list", j_count)
  weighted_posterior <- posterior * weights

  for (j in seq_len(j_count)) {
    observed <- !is.na(responses[, j])
    group_count <- max(eta[j, ]) + 1L
    totals[[j]] <- correct[[j]] <- numeric(group_count)
    for (group in 0:(group_count - 1L)) {
      class_in_group <- eta[j, ] == group
      mass <- rowSums(weighted_posterior[, class_in_group, drop = FALSE])
      totals[[j]][group + 1L] <- sum(mass[observed])
      correct[[j]][group + 1L] <- sum(mass[observed] * responses[observed, j])
    }
  }
  list(total = totals, correct = correct)
}

clamp <- function(x, lower, upper) pmin(upper, pmax(lower, x))

m_step_items <- function(counts, models, correction, lower, upper) {
  out <- vector("list", length(models))
  for (j in seq_along(models)) {
    total <- counts$total[[j]]
    correct <- counts$correct[[j]]
    model <- toupper(models[[j]])
    if (model == "GDINA") {
      estimate <- (correct + correction[[1L]]) / (total + correction[[2L]])
    } else if (model == "DINA") {
      last <- length(total)
      nonmaster <- (sum(correct[-last]) + correction[[1L]]) /
        (sum(total[-last]) + correction[[2L]])
      master <- (correct[[last]] + correction[[1L]]) /
        (total[[last]] + correction[[2L]])
      estimate <- c(rep(nonmaster, last - 1L), master)
    } else if (model == "DINO") {
      nonmaster <- (correct[[1L]] + correction[[1L]]) /
        (total[[1L]] + correction[[2L]])
      master <- (sum(correct[-1L]) + correction[[1L]]) /
        (sum(total[-1L]) + correction[[2L]])
      estimate <- c(nonmaster, rep(master, length(total) - 1L))
    } else {
      stop("Unsupported v1 model: ", model, call. = FALSE)
    }
    out[[j]] <- clamp(estimate, lower[[j]], upper[[j]])
  }
  out
}

delta_parameters <- function(item_probabilities, models, q_matrix) {
  Map(function(probability, model, kj) {
    model <- toupper(model)
    if (model == "GDINA") {
      return(as.numeric(solve(design_matrix(kj, model), probability)))
    }
    if (model == "DINA") return(c(probability[[1L]], probability[[length(probability)]] - probability[[1L]]))
    c(probability[[1L]], probability[[2L]] - probability[[1L]])
  }, item_probabilities, models, rowSums(q_matrix))
}

classification <- function(step, patterns) {
  first_max <- function(x) which.max(x) - 1L
  list(
    map_class = apply(step$posterior, 1L, first_max),
    mle_class = apply(step$conditional_log_likelihood, 1L, first_max),
    eap_attributes = step$posterior %*% patterns
  )
}

fit_em <- function(responses, weights, q_matrix, models, initial_item_probabilities,
                   initial_prior, prior_mode = c("saturated", "fixed"),
                   correction = c(0.0005, 0.001), lower = 1e-4,
                   upper = 1 - 1e-4, lower_prior = 4.9406564584124654e-324,
                   convergence_tolerance = 1e-10, max_iterations = 5000L) {
  prior_mode <- match.arg(prior_mode)
  q_matrix <- as.matrix(q_matrix)
  models <- toupper(models)
  weights <- as.numeric(weights)
  lower <- rep_len(lower, nrow(q_matrix))
  upper <- rep_len(upper, nrow(q_matrix))
  patterns <- attribute_patterns(ncol(q_matrix))
  eta <- eta_matrix(q_matrix, patterns)
  item_probability <- lapply(initial_item_probabilities, as.numeric)
  prior <- as.numeric(initial_prior / sum(initial_prior))
  initial_step <- e_step(responses, weights, item_probability, prior, eta)
  history <- initial_step$log_likelihood
  max_change_history <- numeric()
  converged <- FALSE

  for (iteration in seq_len(max_iterations)) {
    step <- e_step(responses, weights, item_probability, prior, eta)
    counts <- expected_counts(responses, weights, step$posterior, eta)
    next_item_probability <- m_step_items(counts, models, correction, lower, upper)
    next_prior <- prior
    if (prior_mode == "saturated") {
      next_prior <- colSums(step$posterior * weights) / sum(weights)
      next_prior <- pmax(lower_prior, next_prior)
      next_prior <- next_prior / sum(next_prior)
    }

    item_change <- max(abs(unlist(next_item_probability) - unlist(item_probability)))
    prior_change <- max(abs(next_prior - prior))
    max_change <- max(item_change, prior_change)
    max_change_history <- c(max_change_history, max_change)
    item_probability <- next_item_probability
    prior <- next_prior
    next_step <- e_step(responses, weights, item_probability, prior, eta)
    history <- c(history, next_step$log_likelihood)

    if (max_change < convergence_tolerance) {
      converged <- TRUE
      break
    }
  }

  final_step <- e_step(responses, weights, item_probability, prior, eta)
  final_counts <- expected_counts(responses, weights, final_step$posterior, eta)
  classes <- classification(final_step, patterns)
  item_parameter_count <- sum(ifelse(models == "GDINA", 2^rowSums(q_matrix), 2L))
  prior_parameter_count <- if (prior_mode == "saturated") length(prior) - 1L else 0L
  parameter_count <- item_parameter_count + prior_parameter_count
  deviance <- -2 * final_step$log_likelihood
  observation_count <- sum(weights)

  list(
    converged = converged,
    iterations = length(max_change_history),
    max_change = if (length(max_change_history)) tail(max_change_history, 1L) else 0,
    item_group_probabilities = item_probability,
    delta_parameters = delta_parameters(item_probability, models, q_matrix),
    class_prior = prior,
    latent_class_probabilities = final_step$class_probability,
    conditional_log_likelihood = final_step$conditional_log_likelihood,
    posterior = final_step$posterior,
    individual_marginal_log_likelihood = final_step$marginal_log_likelihood,
    log_likelihood = final_step$log_likelihood,
    deviance = deviance,
    observation_count = observation_count,
    item_parameter_count = item_parameter_count,
    prior_parameter_count = prior_parameter_count,
    parameter_count = parameter_count,
    aic = deviance + 2 * parameter_count,
    bic = deviance + parameter_count * log(observation_count),
    expected_total = final_counts$total,
    expected_correct = final_counts$correct,
    map_class = classes$map_class,
    mle_class = classes$mle_class,
    eap_attributes = classes$eap_attributes,
    log_likelihood_history = history,
    max_change_history = max_change_history
  )
}

largest_remainder_counts <- function(probability, n) {
  expected <- probability / sum(probability) * n
  out <- floor(expected)
  remaining <- n - sum(out)
  if (remaining > 0L) {
    order_fraction <- order(expected - out, decreasing = TRUE, method = "radix")
    out[order_fraction[seq_len(remaining)]] <- out[order_fraction[seq_len(remaining)]] + 1L
  }
  as.integer(out)
}

deterministic_observed_data <- function(q_matrix, item_probabilities, prior, n = 512L) {
  eta <- eta_matrix(q_matrix)
  class_probability <- latent_class_probabilities(item_probabilities, eta)
  response_patterns <- attribute_patterns(nrow(q_matrix))
  probability <- numeric(nrow(response_patterns))
  for (row in seq_len(nrow(response_patterns))) {
    conditional <- rep(1, ncol(eta))
    for (j in seq_len(nrow(q_matrix))) {
      p <- class_probability[j, ]
      conditional <- conditional * if (response_patterns[row, j] == 1L) p else (1 - p)
    }
    probability[[row]] <- sum(prior * conditional)
  }
  counts <- largest_remainder_counts(probability, n)
  keep <- counts > 0L
  list(responses = response_patterns[keep, , drop = FALSE], weights = counts[keep])
}

aggregate_rows <- function(responses, weights = rep(1, nrow(responses))) {
  row_key <- apply(responses, 1L, function(row) paste(ifelse(is.na(row), "NA", row), collapse = "|"))
  unique_key <- unique(row_key)
  raw_to_unique <- match(row_key, unique_key)
  first <- match(unique_key, row_key)
  list(
    responses = responses[first, , drop = FALSE],
    weights = as.numeric(rowsum(weights, raw_to_unique, reorder = FALSE)),
    raw_to_unique = raw_to_unique - 1L
  )
}

model_item_probabilities <- function(model) {
  model <- toupper(model)
  if (model == "GDINA") {
    return(list(c(.12, .82), c(.18, .76), c(.08, .28, .43, .86),
                c(.15, .31, .55, .90), c(.20, .75), c(.10, .80)))
  }
  if (model == "DINA") {
    return(list(c(.14, .84), c(.19, .78), c(.11, .11, .11, .87),
                c(.16, .16, .16, .90), c(.21, .76), c(.12, .82)))
  }
  list(c(.14, .84), c(.19, .78), c(.11, .87, .87, .87),
       c(.16, .90, .90, .90), c(.21, .76), c(.12, .82))
}

initial_item_probabilities <- function(model, variant = 1L) {
  model <- toupper(model)
  if (model == "GDINA") {
    starts <- list(
      list(c(.25, .68), c(.27, .70), c(.18, .36, .49, .76), c(.20, .38, .52, .79), c(.28, .69), c(.24, .72)),
      list(c(.38, .62), c(.40, .60), c(.32, .44, .54, .67), c(.30, .43, .56, .69), c(.37, .64), c(.35, .65)),
      list(c(.15, .82), c(.20, .78), c(.12, .30, .48, .85), c(.14, .35, .58, .88), c(.22, .77), c(.13, .83))
    )
  } else if (model == "DINA") {
    starts <- list(
      list(c(.24, .72), c(.26, .70), c(.20, .20, .20, .76), c(.22, .22, .22, .78), c(.27, .71), c(.23, .73)),
      list(c(.40, .60), c(.42, .58), c(.38, .38, .38, .62), c(.36, .36, .36, .64), c(.39, .61), c(.41, .59)),
      list(c(.13, .84), c(.18, .79), c(.11, .11, .11, .86), c(.15, .15, .15, .89), c(.20, .76), c(.12, .82))
    )
  } else {
    starts <- list(
      list(c(.24, .72), c(.26, .70), c(.20, .76, .76, .76), c(.22, .78, .78, .78), c(.27, .71), c(.23, .73)),
      list(c(.40, .60), c(.42, .58), c(.38, .62, .62, .62), c(.36, .64, .64, .64), c(.39, .61), c(.41, .59)),
      list(c(.13, .84), c(.18, .79), c(.11, .86, .86, .86), c(.15, .89, .89, .89), c(.20, .76), c(.12, .82))
    )
  }
  starts[[variant]]
}

common_q <- matrix(c(
  1, 0,
  0, 1,
  1, 1,
  1, 1,
  1, 0,
  0, 1
), byrow = TRUE, ncol = 2L)

common_options <- list(
  correction = c(0.0005, 0.001),
  probability_bounds = c(0.0001, 0.9999),
  lower_prior = 4.9406564584124654e-324,
  convergence_tolerance = 1e-10,
  max_iterations = 5000L,
  convergence_metric = "maxAbsoluteChange(itemGroupProbabilities,classPrior)"
)

oracle_metadata <- function(case_id, purpose) list(
  schema_version = "1.0.0",
  case_id = case_id,
  purpose = purpose,
  oracle = "independent-base-r-mmle",
  gdina_reference = list(version = "2.12.3", date = "2026-07-10"),
  indexing = list(attribute_class = "zero-based", item_local_group = "zero-based"),
  tolerances = list(
    fixed_absolute = 1e-12,
    em_probability_absolute = 1e-8,
    em_log_likelihood_absolute = 1e-8,
    normalization_absolute = 5e-13
  )
)

fixed_fixture <- function(missing = FALSE) {
  q <- matrix(c(1, 0, 0, 1, 1, 1), byrow = TRUE, ncol = 2L)
  responses <- matrix(c(
    1, 0, 1,
    0, 1, 1,
    0, 0, 1,
    1, 1, 0,
    1, 0, 0
  ), byrow = TRUE, ncol = 3L)
  if (missing) {
    responses[1L, 2L] <- NA
    responses[2L, 3L] <- NA
  }
  item_probability <- list(c(.1, .9), c(.2, .8), c(.1, .2, .3, .8))
  prior <- c(.1, .2, .3, .4)
  patterns <- attribute_patterns(2L)
  eta <- eta_matrix(q, patterns)
  step <- e_step(responses, rep(1, nrow(responses)), item_probability, prior, eta)
  classes <- classification(step, patterns)
  id <- if (missing) "fixed-missing-likelihood-posterior" else "fixed-likelihood-posterior"
  purpose <- if (missing) "Missing responses contribute exactly zero conditional log-likelihood." else "Fixed-parameter likelihood, posterior, class ordering, eta, and scoring."
  c(oracle_metadata(id, purpose), list(
    input = list(
      mode = "evaluate",
      q_matrix = q,
      responses = responses,
      models = rep("GDINA", 3L),
      item_group_probabilities = item_probability,
      prior = list(mode = "fixed", probabilities = prior)
    ),
    expected = list(
      attribute_patterns = patterns,
      eta = eta,
      design_matrices = lapply(rowSums(q), design_matrix, model = "GDINA"),
      latent_class_probabilities = step$class_probability,
      conditional_log_likelihood = step$conditional_log_likelihood,
      posterior = step$posterior,
      individual_marginal_log_likelihood = step$marginal_log_likelihood,
      log_likelihood = step$log_likelihood,
      deviance = -2 * step$log_likelihood,
      map_class = classes$map_class,
      mle_class = classes$mle_class,
      eap_attributes = classes$eap_attributes
    )
  ))
}

em_fixture <- function(model, prior_mode = "saturated", missing = FALSE) {
  model <- toupper(model)
  true_item <- model_item_probabilities(model)
  generating_prior <- c(.12, .23, .27, .38)
  observed <- deterministic_observed_data(common_q, true_item, generating_prior, 512L)
  if (missing) {
    for (i in seq_len(nrow(observed$responses))) {
      j <- ((i * 3L) %% ncol(observed$responses)) + 1L
      if ((i %% 4L) == 0L) observed$responses[i, j] <- NA
    }
  }
  initial_prior <- c(.25, .25, .25, .25)
  if (prior_mode == "fixed") initial_prior <- c(.10, .20, .30, .40)
  initial_item <- initial_item_probabilities(model, 1L)
  fit <- fit_em(
    observed$responses, observed$weights, common_q, rep(model, nrow(common_q)),
    initial_item, initial_prior, prior_mode = prior_mode,
    correction = common_options$correction,
    lower = common_options$probability_bounds[[1L]],
    upper = common_options$probability_bounds[[2L]],
    lower_prior = common_options$lower_prior,
    convergence_tolerance = common_options$convergence_tolerance,
    max_iterations = common_options$max_iterations
  )
  suffix <- if (missing) "-missing" else ""
  id <- paste0("em-", tolower(model), "-", prior_mode, suffix)
  purpose <- paste(model, "EM with a", prior_mode, "latent-class prior",
                   if (missing) "and item-level missingness." else "using supplied initial values.")
  c(oracle_metadata(id, purpose), list(
    input = list(
      mode = "fit",
      q_matrix = common_q,
      responses = observed$responses,
      response_weights = observed$weights,
      models = rep(model, nrow(common_q)),
      initial_item_group_probabilities = initial_item,
      prior = list(mode = prior_mode, initial_probabilities = initial_prior),
      options = common_options
    ),
    expected = c(list(
      attribute_patterns = attribute_patterns(ncol(common_q)),
      eta = eta_matrix(common_q),
      design_matrices = Map(design_matrix, rowSums(common_q), rep(model, nrow(common_q)))
    ), fit)
  ))
}

row_aggregation_fixture <- function() {
  unique_response <- matrix(c(
    1, 0, 1, 1, 0, 1,
    0, 1, 1, 0, 1, 0,
    1, 1, 0, 1, 1, 0,
    0, 0, 1, 0, 0, 1,
    1, 0, 0, 1, 0, 0,
    0, 1, 0, 0, 1, 1,
    1, 1, 1, 1, 1, 1,
    0, 0, 0, 0, 0, 0
  ), byrow = TRUE, ncol = 6L)
  frequencies <- c(4L, 3L, 5L, 2L, 4L, 3L, 2L, 3L)
  raw <- unique_response[rep(seq_len(nrow(unique_response)), frequencies), , drop = FALSE]
  # Interleave rows so aggregation must preserve first-seen order rather than sorted order.
  permutation <- order((seq_len(nrow(raw)) * 11L) %% 29L, seq_len(nrow(raw)))
  raw <- raw[permutation, , drop = FALSE]
  aggregated <- aggregate_rows(raw)
  model <- rep("DINA", nrow(common_q))
  initial <- initial_item_probabilities("DINA", 1L)
  fixed_prior <- c(.10, .20, .30, .40)
  raw_fit <- fit_em(raw, rep(1, nrow(raw)), common_q, model, initial, fixed_prior,
                    prior_mode = "fixed", correction = common_options$correction,
                    lower = common_options$probability_bounds[[1L]], upper = common_options$probability_bounds[[2L]],
                    convergence_tolerance = common_options$convergence_tolerance,
                    max_iterations = common_options$max_iterations)
  aggregate_fit <- fit_em(aggregated$responses, aggregated$weights, common_q, model, initial, fixed_prior,
                          prior_mode = "fixed", correction = common_options$correction,
                          lower = common_options$probability_bounds[[1L]], upper = common_options$probability_bounds[[2L]],
                          convergence_tolerance = common_options$convergence_tolerance,
                          max_iterations = common_options$max_iterations)
  expanded_posterior <- aggregate_fit$posterior[aggregated$raw_to_unique + 1L, , drop = FALSE]
  c(oracle_metadata("row-aggregation-equivalence", "Raw rows and first-seen unique rows with frequency weights have identical fits."), list(
    input = list(
      mode = "fit-and-compare-aggregation",
      q_matrix = common_q,
      raw_responses = raw,
      models = model,
      initial_item_group_probabilities = initial,
      prior = list(mode = "fixed", initial_probabilities = fixed_prior),
      options = common_options
    ),
    expected = list(
      aggregated_responses = aggregated$responses,
      frequencies = aggregated$weights,
      raw_to_unique = aggregated$raw_to_unique,
      fit = raw_fit,
      max_absolute_item_probability_difference = max(abs(unlist(raw_fit$item_group_probabilities) - unlist(aggregate_fit$item_group_probabilities))),
      absolute_log_likelihood_difference = abs(raw_fit$log_likelihood - aggregate_fit$log_likelihood),
      max_absolute_expanded_posterior_difference = max(abs(raw_fit$posterior - expanded_posterior))
    )
  ))
}

multistart_fixture <- function() {
  model_name <- "DINA"
  models <- rep(model_name, nrow(common_q))
  observed <- deterministic_observed_data(common_q, model_item_probabilities(model_name), c(.12, .23, .27, .38), 512L)
  starts <- lapply(1:3, initial_item_probabilities, model = model_name)
  initial_prior <- rep(.25, 4L)
  eta <- eta_matrix(common_q)
  initial_log_likelihood <- vapply(starts, function(start) {
    e_step(observed$responses, observed$weights, start, initial_prior, eta)$log_likelihood
  }, numeric(1L))
  selected <- which.max(initial_log_likelihood)
  fit <- fit_em(observed$responses, observed$weights, common_q, models, starts[[selected]], initial_prior,
                prior_mode = "saturated", correction = common_options$correction,
                lower = common_options$probability_bounds[[1L]], upper = common_options$probability_bounds[[2L]],
                convergence_tolerance = common_options$convergence_tolerance,
                max_iterations = common_options$max_iterations)
  c(oracle_metadata("deterministic-multistart-dina", "GDINA-compatible selection of the supplied start with the highest initial observed-data likelihood."), list(
    input = list(
      mode = "fit",
      q_matrix = common_q,
      responses = observed$responses,
      response_weights = observed$weights,
      models = models,
      candidate_initial_item_group_probabilities = starts,
      prior = list(mode = "saturated", initial_probabilities = initial_prior),
      options = c(common_options, list(multistart_selection = "highestInitialLogLikelihood", tie_break = "lowestCandidateIndex"))
    ),
    expected = list(
      candidate_initial_log_likelihoods = initial_log_likelihood,
      selected_candidate = selected - 1L,
      fit = fit
    )
  ))
}

benchmark_fixture <- function() {
  cases <- list(
    list(id = "local-sim10gdina", source = "GDINA-master/data/sim10GDINA.rda", n = 1000L, j = 10L, k = 3L),
    list(id = "local-sim30gdina", source = "GDINA-master/data/sim30GDINA.rda", n = 1000L, j = 30L, k = 5L),
    list(id = "local-real-ecpe", source = "GDINA-master/data/realdata_ECPE.rda", n = 2922L, j = 28L, k = 3L),
    list(id = "local-real-tatsuoka", source = "GDINA-master/data/realdata_Tatsuoka1990.rda", n = 536L, j = 20L, k = 8L),
    list(id = "browser-stress", source = "synthetic-definition", n = 3000L, j = 30L, k = 10L),
    list(id = "node-stress", source = "synthetic-definition", n = 10000L, j = 50L, k = 12L),
    list(id = "browser-memory-preflight-k15", source = "synthetic-definition", n = 3000L, j = 30L, k = 15L,
         execution = "preflight-only", expected = "reject-dense-fit-or-use-blockwise-posterior")
  )
  cases <- lapply(cases, function(case) {
    case$class_count <- 2^case$k
    case$posterior_float64_bytes <- as.double(case$n) * case$class_count * 8
    case$e_step_bernoulli_terms <- as.double(case$n) * case$j * case$class_count
    case
  })
  list(
    schema_version = "1.0.0",
    case_id = "benchmark-case-definitions",
    purpose = "Stable workload definitions; no timing threshold is encoded because hardware and runtime differ.",
    measurement = list(
      warmup_fits = 1L,
      measured_fits = 5L,
      report = c("medianWallMilliseconds", "p95WallMilliseconds", "peakResidentBytes", "iterations", "finalLogLikelihood"),
      correctness_gate = "Run the matching golden-fixture suite before accepting benchmark numbers."
    ),
    cases = cases
  )
}

assert_fixture <- function(fixture) {
  if (!is.null(fixture$expected$posterior)) {
    stopifnot(max(abs(rowSums(fixture$expected$posterior) - 1)) < 5e-13)
  }
  if (!is.null(fixture$expected$class_prior)) {
    stopifnot(abs(sum(fixture$expected$class_prior) - 1) < 5e-13)
  }
  history <- fixture$expected$log_likelihood_history
  if (!is.null(history)) {
    stopifnot(all(is.finite(history)))
    # The 0.0005/0.001 correction is a tiny symmetric pseudo-count.  Permit
    # floating noise, but reject material downward movement.
    stopifnot(min(diff(history)) > -1e-9)
  }
  invisible(TRUE)
}

write_json <- function(object, path) {
  json <- jsonlite::toJSON(object, pretty = TRUE, auto_unbox = TRUE, digits = 16,
                           na = "null", null = "null", matrix = "rowmajor")
  writeLines(json, path, useBytes = TRUE)
}

main <- function() {
  args <- commandArgs(trailingOnly = TRUE)
  output_dir <- if (length(args)) normalizePath(args[[1L]], mustWork = FALSE) else file.path(repo_root, "fixtures", "v1")
  dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)

  fixtures <- list(
    "fixed-likelihood-posterior.json" = fixed_fixture(FALSE),
    "fixed-missing-likelihood-posterior.json" = fixed_fixture(TRUE),
    "em-gdina-saturated.json" = em_fixture("GDINA", "saturated"),
    "em-dina-saturated.json" = em_fixture("DINA", "saturated"),
    "em-dino-saturated.json" = em_fixture("DINO", "saturated"),
    "em-gdina-fixed-prior.json" = em_fixture("GDINA", "fixed"),
    "em-gdina-saturated-missing.json" = em_fixture("GDINA", "saturated", missing = TRUE),
    "row-aggregation-equivalence.json" = row_aggregation_fixture(),
    "deterministic-multistart-dina.json" = multistart_fixture(),
    "benchmark-cases.json" = benchmark_fixture()
  )

  invisible(lapply(fixtures[setdiff(names(fixtures), "benchmark-cases.json")], assert_fixture))
  for (name in names(fixtures)) write_json(fixtures[[name]], file.path(output_dir, name))

  source_paths <- c(
    "GDINA-master/DESCRIPTION",
    "GDINA-master/R/Mstep.R",
    "GDINA-master/R/SingleGroup_Estimation.R",
    "GDINA-master/src/Lik.cpp",
    "GDINA-master/src/Lik2.cpp",
    "GDINA-master/src/util.cpp",
    "validation/generate-fixtures.R",
    "validation/validate-fixtures.R",
    "validation/compare-fast-kernel.R",
    "validation/README.md"
  )
  source_md5 <- as.list(unname(tools::md5sum(file.path(repo_root, source_paths))))
  names(source_md5) <- source_paths
  fixture_names <- names(fixtures)
  fixture_md5 <- as.list(unname(tools::md5sum(file.path(output_dir, fixture_names))))
  names(fixture_md5) <- fixture_names
  manifest <- list(
    schema_version = "1.0.0",
    generated_by = "validation/generate-fixtures.R",
    deterministic = TRUE,
    source_package = list(name = "GDINA", version = "2.12.3", date = "2026-07-10"),
    method = "Independent base-R implementation derived from the documented model equations and audited local source; GDINA is not loaded.",
    source_md5 = source_md5,
    fixture_md5 = fixture_md5
  )
  write_json(manifest, file.path(output_dir, "manifest.json"))
  message("Wrote ", length(fixtures), " fixtures plus manifest to ", output_dir)
}

if (Sys.getenv("JGDINA_FIXTURE_LIBRARY") != "1") main()
