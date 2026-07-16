#!/usr/bin/env Rscript

# Optional independent audit through the complete installed GDINA() wrapper.
#
# This is deliberately separate from the dependency-light acceptance gate.
# It requires an already-installed GDINA 2.12.3 package and never installs or
# modifies anything. The default temporary library can be overridden with
# JGDINA_R_LIB or the usual R_LIBS_USER environment variable.

if (!requireNamespace("jsonlite", quietly = TRUE)) {
  stop("jsonlite is required", call. = FALSE)
}

script_path <- function() {
  arg <- grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
  candidate <- if (length(arg)) sub("^--file=", "", arg[[1L]]) else "validation/real-data/compare-full-package.R"
  normalizePath(candidate)
}

root <- normalizePath(file.path(dirname(script_path()), "..", ".."))
temporary_library <- Sys.getenv("JGDINA_R_LIB", unset = "/tmp/jgdina-r-lib")
if (dir.exists(temporary_library)) .libPaths(c(temporary_library, .libPaths()))

if (!requireNamespace("GDINA", quietly = TRUE)) {
  stop(
    "GDINA is not installed in the configured R libraries. Set JGDINA_R_LIB or R_LIBS_USER to a library containing GDINA 2.12.3.",
    call. = FALSE
  )
}
installed_version <- as.character(utils::packageVersion("GDINA"))
if (installed_version != "2.12.3") {
  stop("Expected GDINA 2.12.3, found ", installed_version, call. = FALSE)
}

dependency_names <- function(description) {
  fields <- unname(unlist(description[c("Depends", "Imports", "LinkingTo")]))
  entries <- trimws(unlist(strsplit(paste(fields, collapse = ","), ",", fixed = TRUE)))
  package_names <- trimws(sub("\\s*\\(.*$", "", entries))
  sort(unique(setdiff(package_names[nzchar(package_names)], "R")))
}

installed_dependency_versions <- function(package_names) {
  versions <- vapply(package_names, function(name) {
    if (!requireNamespace(name, quietly = TRUE)) return(NA_character_)
    as.character(utils::packageVersion(name))
  }, character(1L))
  if (anyNA(versions)) {
    stop(
      "The installed GDINA dependency graph is incomplete: ",
      paste(names(versions)[is.na(versions)], collapse = ", "),
      call. = FALSE
    )
  }
  as.list(versions)
}

r_config <- function(variable) {
  output <- suppressWarnings(system2(
    file.path(R.home("bin"), "R"),
    c("CMD", "config", variable),
    stdout = TRUE,
    stderr = TRUE
  ))
  status <- attr(output, "status")
  if (is.null(status)) status <- 0L
  list(
    available = identical(as.integer(status), 0L),
    value = paste(output, collapse = " "),
    exit_status = as.integer(status)
  )
}

configured_makevars <- Sys.getenv("R_MAKEVARS_USER", unset = "")
makevars_metadata <- if (nzchar(configured_makevars) && file.exists(configured_makevars)) {
  list(
    configured = TRUE,
    file_name = basename(configured_makevars),
    md5 = unname(tools::md5sum(configured_makevars)),
    content = paste(readLines(configured_makevars, warn = FALSE), collapse = "\n")
  )
} else {
  list(configured = FALSE)
}

gdina_description <- utils::packageDescription("GDINA")
dependency_versions <- installed_dependency_versions(
  dependency_names(gdina_description)
)

evidence_directory <- file.path(root, "validation", "real-data", "evidence")
reference_path <- file.path(evidence_directory, "r-reference.json")
if (!file.exists(reference_path)) {
  stop("Missing r-reference.json; run npm run accept:real-data first", call. = FALSE)
}
reference <- jsonlite::fromJSON(reference_path, simplifyVector = FALSE)

matrix_from_json <- function(rows, missing = FALSE) {
  converter <- function(row) {
    vapply(row, function(value) {
      if (is.null(value)) {
        if (!missing) stop("Unexpected JSON null", call. = FALSE)
        return(NA_real_)
      }
      as.numeric(value)
    }, numeric(1L))
  }
  result <- do.call(rbind, lapply(rows, converter))
  unname(result)
}

vector_from_json <- function(values) as.numeric(unlist(values, recursive = TRUE, use.names = FALSE))
list_of_vectors_from_json <- function(values) unname(lapply(values, vector_from_json))

max_absolute_difference <- function(actual, expected) {
  actual <- as.numeric(unlist(actual, recursive = TRUE, use.names = FALSE))
  expected <- as.numeric(unlist(expected, recursive = TRUE, use.names = FALSE))
  if (length(actual) != length(expected)) return(Inf)
  if (!length(actual)) return(0)
  max(abs(actual - expected))
}

exact_fraction <- function(actual, expected) {
  actual <- as.numeric(unlist(actual, recursive = TRUE, use.names = FALSE))
  expected <- as.numeric(unlist(expected, recursive = TRUE, use.names = FALSE))
  if (length(actual) != length(expected) || !length(expected)) return(0)
  mean(actual == expected)
}

profile_indices <- function(profiles, patterns) {
  profile_keys <- apply(as.matrix(profiles), 1L, paste0, collapse = "")
  pattern_keys <- apply(as.matrix(patterns), 1L, paste0, collapse = "")
  match(profile_keys, pattern_keys) - 1L
}

tie_compatible_fraction <- function(selected_indices, log_surface) {
  selected_indices <- as.integer(selected_indices) + 1L
  maxima <- apply(log_surface, 1L, max)
  selected <- log_surface[cbind(seq_len(nrow(log_surface)), selected_indices)]
  mean(abs(selected - maxima) <= 1e-12)
}

case_results <- vector("list", length(reference$cases))
for (case_index in seq_along(reference$cases)) {
  oracle_case <- reference$cases[[case_index]]
  responses <- matrix_from_json(oracle_case$input$responses, missing = TRUE)
  q_matrix <- matrix_from_json(oracle_case$input$q_matrix, missing = FALSE)
  storage.mode(q_matrix) <- "integer"
  initial_items <- list_of_vectors_from_json(oracle_case$input$initial_item_group_probabilities)
  initial_prior <- vector_from_json(oracle_case$input$initial_prior)
  options <- oracle_case$input$estimation
  expected <- oracle_case$expected
  warnings <- character()

  # GDINA() always aggregates identical response patterns before calling its
  # optional C++ estimator, but that fast call has no frequency argument. Add
  # the minimum number of deterministic binary row tags so every row remains
  # unique. Each tag is a fixed, class-independent P=.5 item, so it changes no
  # posterior, M-step sufficient statistic, parameter estimate or person score;
  # it adds only N * tag_count * log(.5) to the reported log-likelihood.
  respondent_count <- nrow(responses)
  real_item_count <- ncol(responses)
  tag_count <- ceiling(log(respondent_count, base = 2))
  row_numbers <- seq_len(respondent_count) - 1L
  row_tags <- vapply(
    0:(tag_count - 1L),
    function(bit) as.integer(bitwAnd(row_numbers, bitwShiftL(1L, bit)) != 0L),
    integer(respondent_count)
  )
  tag_q <- matrix(0L, nrow = tag_count, ncol = ncol(q_matrix))
  tag_q[, 1L] <- 1L
  fit_responses <- cbind(responses, row_tags)
  fit_q_matrix <- rbind(q_matrix, tag_q)
  fit_initial_items <- c(initial_items, rep(list(c(0.5, 0.5)), tag_count))
  fit_models <- c(rep(oracle_case$model, real_item_count), rep("GDINA", tag_count))
  maximum_iterations <- c(
    rep(as.integer(options$max_iterations), real_item_count),
    rep(0L, tag_count)
  )
  neutral_log_likelihood_constant <- respondent_count * tag_count * log(0.5)
  stopifnot(nrow(unique(fit_responses)) == respondent_count)

  elapsed <- system.time({
    fitted <- withCallingHandlers(
      GDINA::GDINA(
        dat = fit_responses,
        Q = fit_q_matrix,
        model = fit_models,
        att.dist = "saturated",
        att.prior = initial_prior,
        catprob.parm = fit_initial_items,
        mono.constraint = FALSE,
        verbose = 0,
        control = list(
          maxitr = maximum_iterations,
          conv.crit = as.numeric(options$convergence_tolerance),
          conv.type = c("ip", "mp"),
          lower.p = as.numeric(options$probability_bounds[[1L]]),
          upper.p = as.numeric(options$probability_bounds[[2L]]),
          smallNcorrection = vector_from_json(options$small_sample_correction),
          Cpp = TRUE,
          randomseed = 123456
        )
      ),
      warning = function(condition) {
        warnings <<- c(warnings, conditionMessage(condition))
        invokeRestart("muffleWarning")
      }
    )
  })

  all_fitted_items <- GDINA::extract(fitted, "catprob.parm")
  actual_items <- unname(lapply(
    all_fitted_items[seq_len(real_item_count)],
    as.numeric
  ))
  neutral_item_difference <- max_absolute_difference(
    all_fitted_items[real_item_count + seq_len(tag_count)],
    rep(list(c(0.5, 0.5)), tag_count)
  )
  actual_prior <- as.numeric(GDINA::extract(fitted, "att.prior"))
  raw_wrapper_log_likelihood <- as.numeric(GDINA::extract(fitted, "logLik"))
  actual_log_likelihood <- raw_wrapper_log_likelihood - neutral_log_likelihood_constant
  actual_iterations <- as.integer(GDINA::extract(fitted, "nitr"))
  actual_patterns <- unname(as.matrix(GDINA::extract(fitted, "attributepattern")))
  expected_patterns <- matrix_from_json(expected$attribute_patterns, missing = FALSE)
  log_posterior <- unname(as.matrix(GDINA::extract(fitted, "logposterior.i")))
  log_likelihood_by_class <- unname(as.matrix(GDINA::extract(fitted, "loglikelihood.i")))

  # Direct class indices use deterministic first-maximum semantics, matching
  # jGDINA and the independent reference. personparm() profiles are also
  # checked below, with ties accepted only when the selected class is truly a
  # maximum of the corresponding installed-package surface.
  direct_map <- apply(log_posterior, 1L, which.max) - 1L
  direct_mle <- apply(log_likelihood_by_class, 1L, which.max) - 1L
  set.seed(123456)
  person_map <- GDINA::personparm(fitted, what = "MAP")
  set.seed(123456)
  person_mle <- GDINA::personparm(fitted, what = "MLE")
  person_eap_probabilities <- unname(as.matrix(GDINA::personparm(fitted, what = "mp", digits = 15)))
  person_eap_classifications <- unname(as.matrix(GDINA::personparm(fitted, what = "EAP")))
  person_map_indices <- profile_indices(person_map[, seq_len(ncol(q_matrix)), drop = FALSE], actual_patterns)
  person_mle_indices <- profile_indices(person_mle[, seq_len(ncol(q_matrix)), drop = FALSE], actual_patterns)

  item_difference <- max_absolute_difference(actual_items, expected$item_group_probabilities)
  prior_difference <- max_absolute_difference(actual_prior, expected$class_prior)
  log_likelihood_difference <- abs(actual_log_likelihood - as.numeric(expected$log_likelihood))
  expected_eap_probabilities <- matrix_from_json(expected$eap_attribute_probabilities, missing = FALSE)
  expected_eap_classifications <- matrix_from_json(expected$eap_attribute_classifications, missing = FALSE)
  eap_difference <- max_absolute_difference(person_eap_probabilities, expected_eap_probabilities)
  iterations_exact <- identical(actual_iterations, as.integer(expected$iterations))
  pattern_order_exact <- identical(as.numeric(actual_patterns), as.numeric(expected_patterns)) &&
    identical(dim(actual_patterns), dim(expected_patterns))
  direct_map_fraction <- exact_fraction(direct_map, expected$map_class_indices)
  direct_mle_fraction <- exact_fraction(direct_mle, expected$mle_class_indices)
  person_map_fraction <- exact_fraction(person_map_indices, expected$map_class_indices)
  person_mle_fraction <- exact_fraction(person_mle_indices, expected$mle_class_indices)
  person_map_tie_compatible <- tie_compatible_fraction(person_map_indices, log_posterior)
  person_mle_tie_compatible <- tie_compatible_fraction(person_mle_indices, log_likelihood_by_class)
  eap_class_fraction <- exact_fraction(person_eap_classifications, expected_eap_classifications)
  tolerances <- reference$tolerances
  passed <-
    item_difference <= as.numeric(tolerances$item_probability_absolute) &&
    prior_difference <= as.numeric(tolerances$prior_probability_absolute) &&
    log_likelihood_difference <= as.numeric(tolerances$log_likelihood_absolute) &&
    eap_difference <= as.numeric(tolerances$eap_probability_absolute) &&
    iterations_exact && pattern_order_exact &&
    direct_map_fraction == 1 && direct_mle_fraction == 1 &&
    person_map_tie_compatible == 1 && person_mle_tie_compatible == 1 &&
    eap_class_fraction == 1 && neutral_item_difference == 0

  case_results[[case_index]] <- list(
    id = oracle_case$id,
    dataset = oracle_case$dataset,
    derivation = oracle_case$derivation,
    model = oracle_case$model,
    passed = passed,
    dimensions = oracle_case$dimensions,
    reference = list(
      iterations = as.integer(expected$iterations),
      log_likelihood = as.numeric(expected$log_likelihood)
    ),
    full_package = list(
      iterations = actual_iterations,
      log_likelihood = actual_log_likelihood,
      raw_log_likelihood_with_neutral_row_tags = raw_wrapper_log_likelihood,
      neutral_row_tag_log_likelihood_constant = neutral_log_likelihood_constant,
      neutral_row_tag_items = tag_count,
      neutral_row_tags_preserved_all_rows = nrow(unique(fit_responses)) == respondent_count,
      max_absolute_neutral_item_probability_difference = neutral_item_difference,
      warnings = unname(warnings)
    ),
    differences = list(
      max_absolute_item_probability = item_difference,
      max_absolute_prior_probability = prior_difference,
      absolute_log_likelihood = log_likelihood_difference,
      max_absolute_eap_probability = eap_difference
    ),
    agreements = list(
      iterations_exact = iterations_exact,
      attribute_pattern_order_exact = pattern_order_exact,
      direct_map_class_fraction = direct_map_fraction,
      direct_mle_class_fraction = direct_mle_fraction,
      personparm_map_strict_fraction = person_map_fraction,
      personparm_mle_strict_fraction = person_mle_fraction,
      personparm_map_tie_compatible_fraction = person_map_tie_compatible,
      personparm_mle_tie_compatible_fraction = person_mle_tie_compatible,
      personparm_eap_classification_fraction = eap_class_fraction
    )
  )

  cat(sprintf(
    "%s %-24s iterations=%d/%d item=%.3g prior=%.3g logLik=%.3g EAP=%.3g elapsed=%.2fs\n",
    if (passed) "PASS" else "FAIL", oracle_case$id,
    as.integer(expected$iterations), actual_iterations, item_difference,
    prior_difference, log_likelihood_difference, eap_difference,
    as.numeric(elapsed[["elapsed"]])
  ))
}

report <- list(
  schema_version = "1.0.0",
  generated_by = "validation/real-data/compare-full-package.R",
  deterministic = TRUE,
  passed = all(vapply(case_results, function(result) isTRUE(result$passed), logical(1L))),
  package = list(
    name = "GDINA",
    version = installed_version,
    built = unname(gdina_description$Built),
    library_source = "preinstalled library configured through JGDINA_R_LIB or R_LIBS_USER; absolute host path intentionally omitted",
    interface = "GDINA::GDINA(), GDINA::extract(), and GDINA::personparm()",
    estimator = "complete single-group R wrapper with control$Cpp=TRUE",
    rationale = paste(
      "Deterministic fixed-P=.5 row-tag items preserve duplicate-row frequencies through the wrapper's unconditional aggregation.",
      "They are class-independent and therefore change only the reported likelihood by a known constant; all compared real-item estimates and person scores retain their original semantics.",
      "CI separately checks the exact C++ fast kernel without requiring the installed package."
    )
  ),
  environment = list(
    r_version = R.version.string,
    platform = R.version$platform,
    operating_system = list(
      system = unname(Sys.info()[["sysname"]]),
      release = unname(Sys.info()[["release"]]),
      machine = unname(Sys.info()[["machine"]])
    ),
    compiler = list(
      cxx17 = r_config("CXX17"),
      f77 = r_config("F77")
    ),
    external_software = as.list(extSoftVersion()),
    dependency_versions = dependency_versions,
    makevars_user = makevars_metadata
  ),
  reference = list(
    file = "validation/real-data/evidence/r-reference.json",
    md5 = unname(tools::md5sum(reference_path))
  ),
  tolerances = reference$tolerances,
  cases = case_results
)

output_path <- file.path(evidence_directory, "full-package-comparison.json")
jsonlite::write_json(
  report,
  output_path,
  pretty = TRUE,
  auto_unbox = TRUE,
  digits = 16,
  na = "null",
  null = "null"
)
cat("Overall full-package wrapper result: ", if (report$passed) "PASS" else "FAIL", "\n", sep = "")
cat("Wrote ", output_path, "\n", sep = "")
if (!report$passed) quit(status = 1L)
