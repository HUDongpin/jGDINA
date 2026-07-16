#!/usr/bin/env Rscript

# Sensitive intermediate bridge for the private user-data acceptance CLI.
# Input and output live in a caller-owned mode-0700 private work directory and
# are deleted by the Node orchestrator. This script never writes to the repo.

if (!requireNamespace("jsonlite", quietly = TRUE)) {
  stop("jsonlite is required for the user-data R oracle", call. = FALSE)
}

script_path <- function() {
  argument <- grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
  candidate <- if (length(argument)) {
    sub("^--file=", "", argument[[1L]])
  } else {
    "validation/user-data/oracle.R"
  }
  normalizePath(candidate)
}

arguments <- commandArgs(trailingOnly = TRUE)
if (length(arguments) != 3L) {
  stop("Usage: oracle.R <kernel|base-r> <private-request.json> <private-reference.json>", call. = FALSE)
}

mode <- arguments[[1L]]
if (!mode %in% c("kernel", "base-r")) {
  stop("Oracle mode must be kernel or base-r", call. = FALSE)
}

if (.Platform$OS.type == "windows") {
  stop("The private oracle requires POSIX file-permission semantics", call. = FALSE)
}
configured_root <- Sys.getenv("JGDINA_WORKSPACE_ROOT", unset = "")
root <- if (nzchar(configured_root)) {
  normalizePath(configured_root)
} else {
  normalizePath(file.path(dirname(script_path()), "..", ".."))
}
input_path <- normalizePath(arguments[[2L]])
output_path <- normalizePath(arguments[[3L]], mustWork = FALSE)
private_directory <- normalizePath(dirname(input_path))

path_within <- function(parent, candidate) {
  if (.Platform$OS.type == "windows") {
    parent <- tolower(parent)
    candidate <- tolower(candidate)
  }
  identical(parent, candidate) || startsWith(candidate, paste0(parent, .Platform$file.sep))
}

if (path_within(root, input_path) || path_within(root, output_path)) {
  stop("Private oracle input/output must remain outside the jGDINA workspace", call. = FALSE)
}
if (!identical(private_directory, normalizePath(dirname(output_path)))) {
  stop("Private oracle input and output must share one private directory", call. = FALSE)
}
output_link <- Sys.readlink(output_path)
output_is_link <- !is.na(output_link) && nzchar(output_link)
if (file.exists(output_path) || output_is_link) {
  stop("Private oracle output must not already exist", call. = FALSE)
}
input_info <- file.info(input_path)
directory_info <- file.info(private_directory)
if (!file_test("-f", input_path) || !isTRUE(directory_info$isdir)) {
  stop("Private oracle paths are not regular input/private-directory paths", call. = FALSE)
}
if (!is.finite(input_info$size) || input_info$size <= 0 || input_info$size > 64 * 1024^2) {
  stop("Private oracle input exceeds the 64 MiB acceptance limit", call. = FALSE)
}
if (.Platform$OS.type != "windows") {
  group_world_mask <- strtoi("077", base = 8L)
  if (
    bitwAnd(as.integer(input_info$mode), group_world_mask) != 0L ||
      bitwAnd(as.integer(directory_info$mode), group_world_mask) != 0L
  ) {
    stop("Private oracle input/directory must not be group/world accessible", call. = FALSE)
  }
}
old_umask <- Sys.umask("0077")
on.exit(Sys.umask(old_umask), add = TRUE)

request <- jsonlite::fromJSON(input_path, simplifyVector = FALSE)
if (
  !identical(
    request$upstream_tree_sha256,
    "22c560cd3d1839ee2803a74923af9e34154cd2f6bc2294a2482392aa90247008"
  )
) {
  stop("Frozen upstream tree identity is inconsistent", call. = FALSE)
}
if (
  length(request$equations_source_path) != 1L ||
    !is.character(request$equations_source_path) ||
    !identical(
      request$equations_sha256,
      "ad7a59752f75852a03e988f38a6ac05ae67a56fe284923907110d12ff3a884b9"
    )
) {
  stop("Independent-equations source metadata is inconsistent", call. = FALSE)
}
equations_path <- normalizePath(request$equations_source_path)
if (
  !identical(normalizePath(dirname(equations_path)), private_directory) ||
    !file_test("-f", equations_path)
) {
  stop("Independent equations must use the verified private source copy", call. = FALSE)
}
if (.Platform$OS.type != "windows") {
  equations_mode <- as.integer(file.info(equations_path)$mode)
  if (bitwAnd(equations_mode, strtoi("077", base = 8L)) != 0L) {
    stop("Independent-equations private copy must not be group/world accessible", call. = FALSE)
  }
}
Sys.setenv(JGDINA_FIXTURE_LIBRARY = "1")
source(equations_path, local = globalenv())
kernel_path <- NULL
if (mode == "kernel") {
  if (
    length(request$kernel_source_path) != 1L ||
      !is.character(request$kernel_source_path) ||
      length(request$kernel_sha256) != 1L ||
      !is.character(request$kernel_sha256) ||
      !identical(
        request$kernel_sha256,
        "d798410e134db64882666d997344130a6eb43fe3918e2b92ccd4c5f4681f2788"
      )
  ) {
    stop("Frozen kernel request metadata is missing", call. = FALSE)
  }
  kernel_path <- normalizePath(request$kernel_source_path)
  if (
    !identical(normalizePath(dirname(kernel_path)), private_directory) ||
      !file_test("-f", kernel_path)
  ) {
    stop("Frozen kernel source must be the verified private copy", call. = FALSE)
  }
  if (.Platform$OS.type != "windows") {
    kernel_mode <- as.integer(file.info(kernel_path)$mode)
    if (bitwAnd(kernel_mode, strtoi("077", base = 8L)) != 0L) {
      stop("Frozen kernel private copy must not be group/world accessible", call. = FALSE)
    }
  }
}

matrix_from_json <- function(rows, missing = FALSE) {
  converter <- function(row) {
    vapply(row, function(value) {
      if (is.null(value)) {
        if (!missing) stop("Unexpected null in a non-missing matrix", call. = FALSE)
        return(NA_real_)
      }
      as.numeric(value)
    }, numeric(1L))
  }
  unname(do.call(rbind, lapply(rows, converter)))
}

vector_from_json <- function(values) {
  as.numeric(unlist(values, recursive = TRUE, use.names = FALSE))
}

list_of_vectors_from_json <- function(values) {
  unname(lapply(values, vector_from_json))
}

tie_sets <- function(surface, tolerance = 1e-12) {
  unname(lapply(seq_len(nrow(surface)), function(row) {
    values <- surface[row, ]
    I(as.integer(which(abs(values - max(values)) <= tolerance) - 1L))
  }))
}

responses <- matrix_from_json(request$responses, missing = TRUE)
q_matrix <- matrix_from_json(request$q_matrix, missing = FALSE)
storage.mode(q_matrix) <- "integer"
models <- toupper(unlist(request$models, recursive = TRUE, use.names = FALSE))
initial_items <- list_of_vectors_from_json(request$initial_item_group_probabilities)
initial_prior <- vector_from_json(request$initial_prior)
options <- request$estimation
probability_bounds <- vector_from_json(options$probability_bounds)
small_sample_correction <- vector_from_json(options$small_sample_correction)
max_iterations <- as.integer(options$max_iterations)
convergence_tolerance <- as.numeric(options$convergence_tolerance)
prior_mode <- request$prior_mode
warnings_seen <- character()

package_version_or_null <- function(package) {
  if (!requireNamespace(package, quietly = TRUE)) return(NULL)
  list(
    version = as.character(utils::packageVersion(package)),
    path = normalizePath(find.package(package))
  )
}

r_config <- function(key) {
  value <- tryCatch(
    system2(
      file.path(R.home("bin"), "R"),
      c("CMD", "config", key),
      stdout = TRUE,
      stderr = FALSE
    ),
    error = function(error) character()
  )
  paste(value, collapse = " ")
}

compiler_config <- function() {
  makevars_path <- Sys.getenv("R_MAKEVARS_USER", unset = "")
  makevars_contents <- if (nzchar(makevars_path) && file.exists(makevars_path)) {
    paste(readLines(makevars_path, warn = FALSE), collapse = "\\n")
  } else {
    ""
  }
  list(
    CXX = r_config("CXX"),
    CXXFLAGS = r_config("CXXFLAGS"),
    CPPFLAGS = r_config("CPPFLAGS"),
    LDFLAGS = r_config("LDFLAGS"),
    FLIBS = r_config("FLIBS"),
    MAKEVARS_USER = makevars_contents
  )
}

toolchain <- list(
  packages = list(
    jsonlite = package_version_or_null("jsonlite"),
    Rcpp = if (mode == "kernel") package_version_or_null("Rcpp") else NULL,
    RcppArmadillo = if (mode == "kernel") package_version_or_null("RcppArmadillo") else NULL
  ),
  compiler = NULL
)

expected_group_lengths <- 2^rowSums(q_matrix)
if (
  !is.matrix(responses) || !is.matrix(q_matrix) ||
    nrow(responses) < 1L || ncol(responses) != nrow(q_matrix) ||
    ncol(q_matrix) < 1L ||
    any(!is.na(responses) & !responses %in% c(0, 1)) ||
    any(!q_matrix %in% c(0L, 1L)) ||
    any(rowSums(q_matrix) < 1L) || any(colSums(q_matrix) < 1L)
) {
  stop("Oracle response/Q matrices violate the binary v1 shape", call. = FALSE)
}
if (length(models) != nrow(q_matrix) || any(!models %in% c("GDINA", "DINA", "DINO"))) {
  stop("Oracle models violate the v1 model vector", call. = FALSE)
}
if (
  !prior_mode %in% c("saturated", "fixed") ||
    length(initial_prior) != 2^ncol(q_matrix) ||
    any(!is.finite(initial_prior)) || any(initial_prior < 0) || any(initial_prior > 1) ||
    !is.finite(sum(initial_prior)) || abs(sum(initial_prior) - 1) > 1e-8
) {
  stop("Oracle prior violates the v1 class distribution", call. = FALSE)
}
initial_prior <- initial_prior / sum(initial_prior)
if (
  length(probability_bounds) != 2L ||
    any(!is.finite(probability_bounds)) ||
    probability_bounds[[1L]] <= 0 ||
    probability_bounds[[2L]] >= 1 ||
    probability_bounds[[1L]] >= probability_bounds[[2L]] ||
    length(small_sample_correction) != 2L ||
    any(!is.finite(small_sample_correction)) ||
    small_sample_correction[[1L]] < 0 || small_sample_correction[[2L]] <= 0 ||
    !is.finite(convergence_tolerance) || convergence_tolerance <= 0 ||
    length(max_iterations) != 1L || is.na(max_iterations) || max_iterations < 1L
) {
  stop("Oracle estimation controls violate the v1 acceptance contract", call. = FALSE)
}
if (
  length(initial_items) != nrow(q_matrix) ||
    any(lengths(initial_items) != expected_group_lengths) ||
    any(!is.finite(unlist(initial_items, recursive = TRUE, use.names = FALSE))) ||
    any(unlist(initial_items, recursive = TRUE, use.names = FALSE) < probability_bounds[[1L]]) ||
    any(unlist(initial_items, recursive = TRUE, use.names = FALSE) > probability_bounds[[2L]])
) {
  stop("Every oracle initial item vector must use its full Q-derived group length", call. = FALSE)
}
for (item in seq_along(initial_items)) {
  if (models[[item]] == "DINA" && length(initial_items[[item]]) > 2L) {
    if (length(unique(initial_items[[item]][-length(initial_items[[item]])])) != 1L) {
      stop("Full DINA oracle starts must tie every nonmaster group", call. = FALSE)
    }
  }
  if (models[[item]] == "DINO" && length(initial_items[[item]]) > 2L) {
    if (length(unique(initial_items[[item]][-1L])) != 1L) {
      stop("Full DINO oracle starts must tie every mastered group", call. = FALSE)
    }
  }
}

run_base_r <- function() {
  fit_em(
    responses = responses,
    weights = rep(1, nrow(responses)),
    q_matrix = q_matrix,
    models = models,
    initial_item_probabilities = initial_items,
    initial_prior = initial_prior,
    prior_mode = prior_mode,
    correction = small_sample_correction,
    lower = probability_bounds[[1L]],
    upper = probability_bounds[[2L]],
    convergence_tolerance = convergence_tolerance,
    max_iterations = max_iterations
  )
}

run_kernel <- function() {
  if (prior_mode != "saturated") {
    stop("The frozen fast kernel supports only an estimated saturated prior", call. = FALSE)
  }
  required <- c("Rcpp", "RcppArmadillo")
  missing_packages <- required[!vapply(required, requireNamespace, logical(1L), quietly = TRUE)]
  if (length(missing_packages)) {
    stop("Missing R packages for frozen fast kernel: ", paste(missing_packages, collapse = ", "), call. = FALSE)
  }

  old_makevars <- Sys.getenv("R_MAKEVARS_USER", unset = NA_character_)
  on.exit({
    if (is.na(old_makevars)) {
      Sys.unsetenv("R_MAKEVARS_USER")
    } else {
      Sys.setenv(R_MAKEVARS_USER = old_makevars)
    }
  }, add = TRUE)
  flibs <- tryCatch(
    system2(file.path(R.home("bin"), "R"), c("CMD", "config", "FLIBS"), stdout = TRUE),
    error = function(error) ""
  )
  if (
    Sys.info()[["sysname"]] == "Darwin" &&
      any(grepl("/opt/gfortran", flibs)) &&
      !dir.exists("/opt/gfortran") &&
      file.exists("/opt/anaconda3/lib/libgfortran.dylib")
  ) {
    makevars <- tempfile("jgdina-user-data-Makevars-")
    writeLines(
      "FLIBS = -L/opt/anaconda3/lib -Wl,-rpath,/opt/anaconda3/lib -lgfortran -lquadmath",
      makevars
    )
    Sys.setenv(R_MAKEVARS_USER = makevars)
    on.exit(unlink(makevars), add = TRUE)
  }

  toolchain$compiler <<- compiler_config()

  Rcpp::sourceCpp(
    kernel_path,
    rebuild = TRUE,
    showOutput = FALSE,
    verbose = FALSE
  )

  eta <- eta_matrix(q_matrix)
  maximum_groups <- max(lengths(initial_items))
  model_numbers <- match(models, c("GDINA", "DINA", "DINO")) - 1L
  initial_step <- e_step(
    responses,
    rep(1, nrow(responses)),
    initial_items,
    initial_prior,
    eta
  )
  run_cpp <- function(iteration_limit) {
    candidate_matrix <- matrix(0, nrow(q_matrix), maximum_groups)
    for (item in seq_along(initial_items)) {
      candidate_matrix[item, seq_along(initial_items[[item]])] <- initial_items[[item]]
    }
    fast_GDINA_EM(
      eta + 1L,
      candidate_matrix,
      responses,
      log(initial_prior),
      model_numbers,
      rep(iteration_limit, nrow(q_matrix)),
      rep(probability_bounds[[1L]], nrow(q_matrix)),
      rep(probability_bounds[[2L]], nrow(q_matrix)),
      small_sample_correction,
      c(1, 1),
      FALSE,
      convergence_tolerance
    )
  }
  cpp <- run_cpp(max_iterations)
  convergence_probe_iterations <- NULL
  converged <- as.integer(cpp$itr) < max_iterations
  if (!converged) {
    convergence_probe <- run_cpp(max_iterations + 1L)
    convergence_probe_iterations <- as.integer(convergence_probe$itr)
    converged <- convergence_probe_iterations <= max_iterations
  }
  fitted_items <- unname(lapply(seq_along(initial_items), function(item) {
    as.numeric(cpp$ip[item, seq_along(initial_items[[item]])])
  }))
  fitted_prior <- as.numeric(exp(cpp$logprior))
  fitted_prior <- fitted_prior / sum(fitted_prior)
  final_step <- e_step(
    responses,
    rep(1, nrow(responses)),
    fitted_items,
    fitted_prior,
    eta
  )
  classes <- classification(final_step, attribute_patterns(ncol(q_matrix)))
  list(
    converged = converged,
    iterations = as.integer(cpp$itr),
    convergence_probe_iterations = convergence_probe_iterations,
    max_change = NULL,
    item_group_probabilities = fitted_items,
    class_prior = fitted_prior,
    posterior = final_step$posterior,
    conditional_log_likelihood = final_step$conditional_log_likelihood,
    log_likelihood = final_step$log_likelihood,
    initial_log_likelihood = initial_step$log_likelihood,
    map_class = classes$map_class,
    mle_class = classes$mle_class,
    eap_attributes = classes$eap_attributes
  )
}

elapsed <- system.time({
  fitted <- withCallingHandlers(
    if (mode == "kernel") run_kernel() else run_base_r(),
    warning = function(condition) {
      warnings_seen <<- c(warnings_seen, conditionMessage(condition))
      invokeRestart("muffleWarning")
    }
  )
})

patterns <- attribute_patterns(ncol(q_matrix))
if (mode == "base-r") {
  initial_step <- e_step(
    responses,
    rep(1, nrow(responses)),
    initial_items,
    initial_prior,
    eta_matrix(q_matrix, patterns)
  )
  fitted$initial_log_likelihood <- initial_step$log_likelihood
}

reference <- list(
  schema_version = "jgdina-user-oracle/1",
  oracle = list(
    mode = mode,
    implementation = if (mode == "kernel") {
      "frozen-GDINA-2.12.3-fast_GDINA_EM-plus-independent-base-R-scoring"
    } else {
      "independent-base-R-closed-form-equations"
    },
    upstream_version = "2.12.3",
    upstream_commit = "ac5eca223a1ee32b6c2f595cfeaef9b330451425",
    warning_count = length(warnings_seen),
    r_version = R.version.string,
    platform = R.version$platform,
    toolchain = toolchain,
    elapsed_seconds = as.numeric(elapsed[["elapsed"]]),
    oracle_sha256 = request$oracle_sha256,
    equations_sha256 = request$equations_sha256,
    kernel_sha256 = if (mode == "kernel") request$kernel_sha256 else NULL,
    upstream_tree_sha256 = request$upstream_tree_sha256
  ),
  configuration = list(
    models = I(models),
    prior_mode = prior_mode,
    max_iterations = max_iterations,
    convergence_tolerance = convergence_tolerance,
    probability_bounds = I(probability_bounds),
    small_sample_correction = I(small_sample_correction)
  ),
  dimensions = list(
    respondents = nrow(responses),
    items = ncol(responses),
    attributes = ncol(q_matrix),
    latent_classes = nrow(patterns),
    missing_responses = sum(is.na(responses))
  ),
  expected = list(
    attribute_patterns = unname(patterns),
    converged = isTRUE(fitted$converged),
    iterations = as.integer(fitted$iterations),
    convergence_probe_iterations = if (is.null(fitted$convergence_probe_iterations)) {
      NULL
    } else {
      as.integer(fitted$convergence_probe_iterations)
    },
    final_change = if (is.null(fitted$max_change)) NULL else as.numeric(fitted$max_change),
    initial_log_likelihood = as.numeric(fitted$initial_log_likelihood),
    log_likelihood = as.numeric(fitted$log_likelihood),
    item_group_probabilities = unname(fitted$item_group_probabilities),
    class_prior = as.numeric(fitted$class_prior),
    map_class_indices = I(as.integer(fitted$map_class)),
    mle_class_indices = I(as.integer(fitted$mle_class)),
    map_tie_sets = tie_sets(fitted$posterior),
    mle_tie_sets = tie_sets(fitted$conditional_log_likelihood),
    eap_attribute_probabilities = unname(fitted$eap_attributes),
    eap_attribute_classifications = unname((fitted$eap_attributes > 0.5) * 1L)
  )
)

temporary_output <- tempfile(".jgdina-oracle-reference-", tmpdir = private_directory)
on.exit(unlink(temporary_output, force = TRUE), add = TRUE)
jsonlite::write_json(
  reference,
  temporary_output,
  pretty = FALSE,
  auto_unbox = TRUE,
  digits = 16,
  na = "null",
  null = "null",
  matrix = "rowmajor"
)
Sys.chmod(temporary_output, mode = "0600")
if (!file.rename(temporary_output, output_path)) {
  stop("Could not atomically install the private oracle reference", call. = FALSE)
}
Sys.chmod(output_path, mode = "0600")
