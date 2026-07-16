#!/usr/bin/env Rscript

# Generate deterministic real-data acceptance references with the exact
# GDINA 2.12.3 fast EM kernel frozen in GDINA-master/src/Lik2.cpp.
#
# The complete GDINA package is intentionally not installed by this script.
# The two real datasets are loaded directly from the package's .rda files;
# likelihoods and person classifications are evaluated from the final kernel
# estimates using the independently audited base-R equations already used by
# validation/generate-fixtures.R.

required <- c("jsonlite", "Rcpp", "RcppArmadillo")
missing_packages <- required[!vapply(required, requireNamespace, logical(1L), quietly = TRUE)]
if (length(missing_packages)) {
  stop("Missing required R packages: ", paste(missing_packages, collapse = ", "), call. = FALSE)
}

script_path <- function() {
  arg <- grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
  candidate <- if (length(arg)) sub("^--file=", "", arg[[1L]]) else "validation/real-data/generate-reference.R"
  normalizePath(candidate)
}

root <- normalizePath(file.path(dirname(script_path()), "..", ".."))
output_dir <- file.path(root, "validation", "real-data", "evidence")
dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)

# Load the independent equations as a function library without regenerating
# the synthetic fixtures. Restore root because that script derives its own
# path from the outer Rscript invocation when sourced.
Sys.setenv(JGDINA_FIXTURE_LIBRARY = "1")
source(file.path(root, "validation", "generate-fixtures.R"), local = globalenv())
repo_root <- root

# Some macOS R distributions advertise /opt/gfortran even when it is absent.
# Match the existing fast-kernel validator and reuse the available conda
# runtime only for this exact local configuration.
old_makevars <- Sys.getenv("R_MAKEVARS_USER", unset = NA_character_)
on.exit({
  if (is.na(old_makevars)) Sys.unsetenv("R_MAKEVARS_USER") else Sys.setenv(R_MAKEVARS_USER = old_makevars)
}, add = TRUE)
flibs <- tryCatch(
  system2(file.path(R.home("bin"), "R"), c("CMD", "config", "FLIBS"), stdout = TRUE),
  error = function(e) ""
)
if (Sys.info()[["sysname"]] == "Darwin" && any(grepl("/opt/gfortran", flibs)) &&
    !dir.exists("/opt/gfortran") && file.exists("/opt/anaconda3/lib/libgfortran.dylib")) {
  makevars <- tempfile("jgdina-real-data-Makevars-")
  writeLines("FLIBS = -L/opt/anaconda3/lib -Wl,-rpath,/opt/anaconda3/lib -lgfortran -lquadmath", makevars)
  Sys.setenv(R_MAKEVARS_USER = makevars)
  on.exit(unlink(makevars), add = TRUE)
}

Rcpp::sourceCpp(
  file.path(root, "GDINA-master", "src", "Lik2.cpp"),
  rebuild = TRUE,
  showOutput = FALSE,
  verbose = FALSE
)

initial_item_probabilities_real <- function(q_matrix, model) {
  model <- toupper(model)
  unname(lapply(unname(rowSums(q_matrix)), function(kj) {
    group_count <- 2^kj
    if (model == "GDINA") return(seq(0.20, 0.80, length.out = group_count))
    if (model == "DINA") return(c(rep(0.20, group_count - 1L), 0.80))
    if (model == "DINO") return(c(0.20, rep(0.80, group_count - 1L)))
    stop("Unsupported model: ", model, call. = FALSE)
  }))
}

with_deterministic_missing <- function(responses) {
  responses <- as.matrix(responses)
  positions <- outer(
    seq_len(nrow(responses)),
    seq_len(ncol(responses)),
    function(row, item) ((row * 17L + item * 7L) %% 101L) == 0L
  )
  responses[positions] <- NA_real_
  responses
}

load_dataset <- function(name) {
  if (name == "ECPE") {
    environment <- new.env(parent = emptyenv())
    load(file.path(root, "GDINA-master", "data", "realdata_ECPE.rda"), envir = environment)
    object <- environment$realdata_ECPE
    return(list(responses = as.matrix(object$dat), q_matrix = as.matrix(object$Q)))
  }
  if (name == "Tatsuoka1990") {
    environment <- new.env(parent = emptyenv())
    load(file.path(root, "GDINA-master", "data", "realdata_Tatsuoka1990.rda"), envir = environment)
    object <- environment$realdata_Tatsuoka1990
    return(list(responses = as.matrix(object$dat), q_matrix = as.matrix(object$Q)))
  }
  stop("Unknown dataset: ", name, call. = FALSE)
}

fit_case <- function(id, dataset_name, model, inject_missing = FALSE) {
  dataset <- load_dataset(dataset_name)
  responses <- dataset$responses
  q_matrix <- dataset$q_matrix
  storage.mode(responses) <- "double"
  storage.mode(q_matrix) <- "integer"
  if (inject_missing) responses <- with_deterministic_missing(responses)

  item_initial <- initial_item_probabilities_real(q_matrix, model)
  max_groups <- max(lengths(item_initial))
  parameter_matrix <- matrix(0, nrow(q_matrix), max_groups)
  for (item in seq_along(item_initial)) {
    parameter_matrix[item, seq_along(item_initial[[item]])] <- item_initial[[item]]
  }
  class_count <- 2^ncol(q_matrix)
  initial_prior <- rep(1 / class_count, class_count)
  model_number <- match(model, c("GDINA", "DINA", "DINO")) - 1L
  tolerance <- 1e-8
  max_iterations <- 5000L
  correction <- c(0.0005, 0.001)
  bounds <- c(0.0001, 0.9999)

  initial_step <- e_step(
    responses,
    rep(1, nrow(responses)),
    item_initial,
    initial_prior,
    eta_matrix(q_matrix)
  )
  cpp <- fast_GDINA_EM(
    eta_matrix(q_matrix) + 1L,
    parameter_matrix,
    responses,
    log(initial_prior),
    rep(model_number, nrow(q_matrix)),
    rep(max_iterations, nrow(q_matrix)),
    rep(bounds[[1L]], nrow(q_matrix)),
    rep(bounds[[2L]], nrow(q_matrix)),
    correction,
    c(1, 1),
    FALSE,
    tolerance
  )

  fitted_items <- lapply(seq_along(item_initial), function(item) {
    as.numeric(cpp$ip[item, seq_along(item_initial[[item]])])
  })
  fitted_prior <- as.numeric(exp(cpp$logprior))
  fitted_prior <- fitted_prior / sum(fitted_prior)
  patterns <- attribute_patterns(ncol(q_matrix))
  final_step <- e_step(
    responses,
    rep(1, nrow(responses)),
    fitted_items,
    fitted_prior,
    eta_matrix(q_matrix, patterns)
  )
  classes <- classification(final_step, patterns)

  list(
    id = id,
    dataset = dataset_name,
    derivation = if (inject_missing) "deterministic-missing-mask-over-original-responses" else "original",
    model = model,
    dimensions = list(
      respondents = nrow(responses),
      items = ncol(responses),
      attributes = ncol(q_matrix),
      latent_classes = class_count,
      missing_responses = sum(is.na(responses))
    ),
    input = list(
      responses = responses,
      q_matrix = q_matrix,
      initial_item_group_probabilities = item_initial,
      initial_prior = initial_prior,
      estimation = list(
        starts = 1L,
        max_iterations = max_iterations,
        convergence_tolerance = tolerance,
        probability_bounds = bounds,
        small_sample_correction = correction,
        aggregate_rows = FALSE,
        posterior_storage = "full"
      )
    ),
    expected = list(
      attribute_patterns = unname(patterns),
      converged = cpp$itr < max_iterations,
      iterations = as.integer(cpp$itr),
      initial_log_likelihood = initial_step$log_likelihood,
      log_likelihood = final_step$log_likelihood,
      item_group_probabilities = fitted_items,
      class_prior = fitted_prior,
      map_class_indices = as.integer(classes$map_class),
      mle_class_indices = as.integer(classes$mle_class),
      eap_attribute_probabilities = unname(classes$eap_attributes),
      eap_attribute_classifications = unname((classes$eap_attributes > 0.5) * 1L)
    )
  )
}

cases <- list(
  fit_case("ecpe-gdina", "ECPE", "GDINA"),
  fit_case("ecpe-dino", "ECPE", "DINO"),
  fit_case("tatsuoka1990-dina", "Tatsuoka1990", "DINA"),
  fit_case("ecpe-gdina-missing", "ECPE", "GDINA", inject_missing = TRUE)
)

data_paths <- c(
  "GDINA-master/data/realdata_ECPE.rda",
  "GDINA-master/data/realdata_Tatsuoka1990.rda",
  "GDINA-master/src/Lik2.cpp",
  "validation/generate-fixtures.R",
  "validation/real-data/generate-reference.R"
)
source_md5 <- as.list(unname(tools::md5sum(file.path(root, data_paths))))
names(source_md5) <- data_paths

reference <- list(
  schema_version = "1.0.0",
  generated_by = "validation/real-data/generate-reference.R",
  deterministic = TRUE,
  upstream = list(
    package = "GDINA",
    version = "2.12.3",
    frozen_commit = "ac5eca223a1ee32b6c2f595cfeaef9b330451425",
    estimator = "exact-fast-kernel-src/Lik2.cpp",
    full_package_loaded = requireNamespace("GDINA", quietly = TRUE),
    scoring_surface = "independent-base-R-equations-audited-against-the-fast-kernel"
  ),
  class_order = "zero profile, then increasing-cardinality combinations in utils::combn order",
  item_group_order = "GDINA alpha2 local-pattern order",
  tolerances = list(
    item_probability_absolute = 1e-8,
    prior_probability_absolute = 1e-8,
    log_likelihood_absolute = 1e-7,
    eap_probability_absolute = 1e-8,
    iterations = "exact",
    discrete_classifications = "exact"
  ),
  source_md5 = source_md5,
  cases = cases
)

json <- jsonlite::toJSON(
  reference,
  pretty = TRUE,
  auto_unbox = TRUE,
  digits = 16,
  na = "null",
  null = "null",
  matrix = "rowmajor"
)
writeLines(json, file.path(output_dir, "r-reference.json"), useBytes = TRUE)
message("Wrote ", length(cases), " real-data references to ", output_dir)
