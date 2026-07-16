#!/usr/bin/env Rscript

if (!requireNamespace("jsonlite", quietly = TRUE)) {
  stop("jsonlite is required to validate the golden fixtures", call. = FALSE)
}

script_arg <- grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
script <- if (length(script_arg)) sub("^--file=", "", script_arg[[1L]]) else "validation/validate-fixtures.R"
root <- normalizePath(file.path(dirname(normalizePath(script)), ".."))
fixture_dir <- file.path(root, "fixtures", "v1")
generator <- file.path(root, "validation", "generate-fixtures.R")

fail <- function(...) stop(..., call. = FALSE)
assert <- function(condition, ...) if (!isTRUE(condition)) fail(...)
read_fixture <- function(path) jsonlite::fromJSON(path, simplifyVector = FALSE)
numbers <- function(x) as.numeric(unlist(x, recursive = TRUE, use.names = FALSE))

temp_dir <- tempfile("jgdina-fixtures-")
dir.create(temp_dir)
on.exit(unlink(temp_dir, recursive = TRUE, force = TRUE), add = TRUE)

status <- system2(file.path(R.home("bin"), "Rscript"), c(generator, temp_dir), stdout = TRUE, stderr = TRUE)
exit_status <- attr(status, "status")
if (!is.null(exit_status) && exit_status != 0L) fail("Fixture regeneration failed:\n", paste(status, collapse = "\n"))

committed <- sort(list.files(fixture_dir, pattern = "\\.json$"))
regenerated <- sort(list.files(temp_dir, pattern = "\\.json$"))
assert(identical(committed, regenerated), "Committed and regenerated fixture file sets differ")
committed_md5 <- unname(tools::md5sum(file.path(fixture_dir, committed)))
regenerated_md5 <- unname(tools::md5sum(file.path(temp_dir, regenerated)))
if (!identical(committed_md5, regenerated_md5)) {
  changed <- committed[committed_md5 != regenerated_md5]
  fail("Fixtures are stale or non-deterministic: ", paste(changed, collapse = ", "))
}

case_files <- setdiff(committed, c("manifest.json", "benchmark-cases.json"))
for (name in case_files) {
  fixture <- read_fixture(file.path(fixture_dir, name))
  expected <- fixture$expected
  fit <- if (!is.null(expected$fit)) expected$fit else expected

  if (!is.null(fit$posterior)) {
    posterior <- do.call(rbind, lapply(fit$posterior, numbers))
    assert(max(abs(rowSums(posterior) - 1)) < 5e-13, name, ": posterior rows do not sum to one")
    assert(all(posterior >= 0 & posterior <= 1), name, ": posterior lies outside [0,1]")
  }
  if (!is.null(fit$class_prior)) {
    prior <- numbers(fit$class_prior)
    assert(abs(sum(prior) - 1) < 5e-13, name, ": class prior does not sum to one")
    assert(all(prior > 0), name, ": class prior is not strictly positive")
  }
  if (!is.null(fit$item_group_probabilities)) {
    item_probability <- numbers(fit$item_group_probabilities)
    bounds <- numbers(fixture$input$options$probability_bounds)
    assert(all(item_probability >= bounds[[1L]] & item_probability <= bounds[[2L]]),
           name, ": item probabilities violate configured bounds")
  }
  if (!is.null(fit$iterations)) {
    history <- numbers(fit$log_likelihood_history)
    changes <- numbers(fit$max_change_history)
    tolerance <- numbers(fixture$input$options$convergence_tolerance)[[1L]]
    max_iterations <- numbers(fixture$input$options$max_iterations)[[1L]]
    assert(isTRUE(fit$converged), name, ": fit did not converge")
    assert(length(history) == fit$iterations + 1L, name, ": likelihood history length is inconsistent")
    assert(length(changes) == fit$iterations, name, ": change history length is inconsistent")
    assert(tail(changes, 1L) < tolerance, name, ": terminal parameter change does not meet tolerance")
    assert(fit$iterations <= max_iterations, name, ": iteration limit exceeded")
    assert(min(diff(history)) > -1e-9, name, ": material likelihood decrease detected")
    assert(abs(tail(history, 1L) - fit$log_likelihood) < 1e-12,
           name, ": terminal likelihood disagrees with history")
    assert(fit$parameter_count == fit$item_parameter_count + fit$prior_parameter_count,
           name, ": parameter-count components disagree")
    assert(abs(fit$aic - (fit$deviance + 2 * fit$parameter_count)) < 1e-10,
           name, ": AIC formula is inconsistent")
    assert(abs(fit$bic - (fit$deviance + fit$parameter_count * log(fit$observation_count))) < 1e-10,
           name, ": BIC formula is inconsistent")
  }
}

missing <- read_fixture(file.path(fixture_dir, "fixed-missing-likelihood-posterior.json"))
responses <- missing$input$responses
conditional <- missing$expected$conditional_log_likelihood
for (i in seq_along(responses)) {
  observed <- !vapply(responses[[i]], is.null, logical(1L))
  assert(sum(observed) >= 2L, "Missing-data fixture contains a row outside the v1 calibration policy")
}
assert(length(conditional) == length(responses), "Missing-data conditional likelihood row count is wrong")

aggregation <- read_fixture(file.path(fixture_dir, "row-aggregation-equivalence.json"))
assert(abs(aggregation$expected$absolute_log_likelihood_difference) < 1e-12,
       "Raw and aggregated log likelihoods differ")
assert(abs(aggregation$expected$max_absolute_item_probability_difference) < 1e-12,
       "Raw and aggregated item estimates differ")
assert(abs(aggregation$expected$max_absolute_expanded_posterior_difference) < 1e-12,
       "Raw and expanded aggregated posteriors differ")
assert(sum(numbers(aggregation$expected$frequencies)) == length(aggregation$input$raw_responses),
       "Aggregation frequencies do not recover the raw row count")

multistart <- read_fixture(file.path(fixture_dir, "deterministic-multistart-dina.json"))
initial_ll <- numbers(multistart$expected$candidate_initial_log_likelihoods)
assert(multistart$expected$selected_candidate == which.max(initial_ll) - 1L,
       "Multi-start selection does not match highest initial likelihood")

benchmark <- read_fixture(file.path(fixture_dir, "benchmark-cases.json"))
for (case in benchmark$cases) {
  assert(case$class_count == 2^case$k, case$id, ": benchmark class count is wrong")
  assert(case$posterior_float64_bytes == as.double(case$n) * case$class_count * 8,
         case$id, ": benchmark posterior memory is wrong")
  assert(case$e_step_bernoulli_terms == as.double(case$n) * case$j * case$class_count,
         case$id, ": benchmark operation count is wrong")
}

cat("Validated", length(case_files), "golden cases plus benchmark definitions.\n")
cat("All JSON files reproduce byte-for-byte from validation/generate-fixtures.R.\n")
