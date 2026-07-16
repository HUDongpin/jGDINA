#!/usr/bin/env Rscript

# Optional parity check against GDINA 2.12.3's Rcpp fast EM kernel.  This does
# not install or load the GDINA package and therefore avoids its full runtime
# dependency set.  It requires Rcpp, RcppArmadillo, and a working compiler.

main <- function() {
  required <- c("Rcpp", "RcppArmadillo")
  missing <- required[!vapply(required, requireNamespace, logical(1L), quietly = TRUE)]
  if (length(missing)) stop("Missing optional build dependencies: ", paste(missing, collapse = ", "), call. = FALSE)

  script_arg <- grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
  script <- if (length(script_arg)) sub("^--file=", "", script_arg[[1L]]) else "validation/compare-fast-kernel.R"
  root <- normalizePath(file.path(dirname(normalizePath(script)), ".."))

  Sys.setenv(JGDINA_FIXTURE_LIBRARY = "1")
  source(file.path(root, "validation", "generate-fixtures.R"), local = globalenv())

  # The provided macOS R build can advertise an absent /opt/gfortran.  Reuse a
  # local conda Fortran runtime when that exact mismatch is present.  Other
  # platforms retain their normal R build configuration.
  old_makevars <- Sys.getenv("R_MAKEVARS_USER", unset = NA_character_)
  on.exit({
    if (is.na(old_makevars)) Sys.unsetenv("R_MAKEVARS_USER") else Sys.setenv(R_MAKEVARS_USER = old_makevars)
  }, add = TRUE)
  flibs <- tryCatch(system2(file.path(R.home("bin"), "R"), c("CMD", "config", "FLIBS"), stdout = TRUE), error = function(e) "")
  if (Sys.info()[["sysname"]] == "Darwin" && any(grepl("/opt/gfortran", flibs)) &&
      !dir.exists("/opt/gfortran") && file.exists("/opt/anaconda3/lib/libgfortran.dylib")) {
    makevars <- tempfile("jgdina-Makevars-")
    writeLines("FLIBS = -L/opt/anaconda3/lib -Wl,-rpath,/opt/anaconda3/lib -lgfortran -lquadmath", makevars)
    Sys.setenv(R_MAKEVARS_USER = makevars)
    on.exit(unlink(makevars), add = TRUE)
  }

  Rcpp::sourceCpp(file.path(root, "GDINA-master", "src", "Lik2.cpp"), rebuild = TRUE,
                  showOutput = FALSE, verbose = FALSE)

  results <- list()
  for (model in c("GDINA", "DINA", "DINO")) {
    observed <- deterministic_observed_data(
      common_q, model_item_probabilities(model), c(.12, .23, .27, .38), 512L
    )
    raw <- observed$responses[rep(seq_len(nrow(observed$responses)), observed$weights), , drop = FALSE]
    initial <- initial_item_probabilities(model, 1L)
    max_groups <- max(lengths(initial))
    parameter_matrix <- matrix(0, nrow(common_q), max_groups)
    for (j in seq_along(initial)) parameter_matrix[j, seq_along(initial[[j]])] <- initial[[j]]
    model_number <- match(model, c("GDINA", "DINA", "DINO")) - 1L

    cpp <- fast_GDINA_EM(
      eta_matrix(common_q) + 1L, parameter_matrix, raw, log(rep(.25, 4L)),
      rep(model_number, nrow(common_q)), rep(5000L, nrow(common_q)),
      rep(1e-4, nrow(common_q)), rep(1 - 1e-4, nrow(common_q)),
      c(.0005, .001), c(1, 1), FALSE, 1e-10
    )
    reference <- fit_em(
      observed$responses, observed$weights, common_q, rep(model, nrow(common_q)),
      initial, rep(.25, 4L), "saturated", convergence_tolerance = 1e-10,
      max_iterations = 5000L
    )
    cpp_probability <- unlist(lapply(seq_along(initial), function(j) {
      cpp$ip[j, seq_along(initial[[j]])]
    }))
    item_difference <- max(abs(cpp_probability - unlist(reference$item_group_probabilities)))
    prior_difference <- max(abs(exp(cpp$logprior) - reference$class_prior))
    if (cpp$itr != reference$iterations || item_difference > 1e-12 || prior_difference > 1e-12) {
      stop(model, " fast-kernel parity failed", call. = FALSE)
    }
    results[[model]] <- c(iterations = cpp$itr, max_item_difference = item_difference,
                          max_prior_difference = prior_difference)
  }

  for (model in names(results)) {
    result <- results[[model]]
    cat(sprintf("%-5s iterations=%d maxItemDifference=%.3g maxPriorDifference=%.3g\n",
                model, as.integer(result[["iterations"]]), result[["max_item_difference"]],
                result[["max_prior_difference"]]))
  }
  cat("Independent base-R oracle matches GDINA 2.12.3 src/Lik2.cpp within 1e-12.\n")
}

main()
