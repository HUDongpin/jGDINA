#!/usr/bin/env Rscript

if (!requireNamespace("jsonlite", quietly = TRUE)) {
  stop("jsonlite is required to generate local benchmark inputs", call. = FALSE)
}

script_path <- function() {
  argument <- grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
  candidate <- if (length(argument)) {
    sub("^--file=", "", argument[[1L]])
  } else {
    "benchmarks/generate-local-data.R"
  }
  normalizePath(candidate)
}

root <- normalizePath(file.path(dirname(script_path()), ".."))
arguments <- commandArgs(trailingOnly = TRUE)
output_path <- if (length(arguments)) {
  normalizePath(arguments[[1L]], mustWork = FALSE)
} else {
  file.path(root, "benchmarks", "data", "local-cases.json")
}

matrix_rows <- function(value, integer = FALSE) {
  value <- as.matrix(value)
  unname(lapply(seq_len(nrow(value)), function(row) {
    result <- unname(as.numeric(value[row, ]))
    if (integer) as.integer(result) else result
  }))
}

load_object <- function(relative_path, object_name) {
  environment <- new.env(parent = emptyenv())
  loaded <- load(file.path(root, relative_path), envir = environment)
  if (!identical(loaded, object_name)) {
    stop(
      relative_path,
      " must contain exactly ",
      object_name,
      "; found ",
      paste(loaded, collapse = ", "),
      call. = FALSE
    )
  }
  environment[[object_name]]
}

definitions <- list(
  list(
    id = "local-sim10gdina",
    source = "GDINA-master/data/sim10GDINA.rda",
    object = "sim10GDINA",
    model = "GDINA",
    responses = "simdat",
    q_matrix = "simQ"
  ),
  list(
    id = "local-sim30gdina",
    source = "GDINA-master/data/sim30GDINA.rda",
    object = "sim30GDINA",
    model = "GDINA",
    responses = "simdat",
    q_matrix = "simQ"
  ),
  list(
    id = "local-real-ecpe",
    source = "GDINA-master/data/realdata_ECPE.rda",
    object = "realdata_ECPE",
    model = "GDINA",
    responses = "dat",
    q_matrix = "Q"
  ),
  list(
    id = "local-real-tatsuoka",
    source = "GDINA-master/data/realdata_Tatsuoka1990.rda",
    object = "realdata_Tatsuoka1990",
    model = "DINA",
    responses = "dat",
    q_matrix = "Q"
  )
)

cases <- lapply(definitions, function(definition) {
  source_object <- load_object(definition$source, definition$object)
  responses <- matrix_rows(source_object[[definition$responses]], integer = TRUE)
  q_matrix <- matrix_rows(source_object[[definition$q_matrix]], integer = TRUE)
  list(
    id = definition$id,
    source = definition$source,
    source_object = definition$object,
    source_md5 = unname(tools::md5sum(file.path(root, definition$source))),
    model = definition$model,
    dimensions = list(
      respondents = length(responses),
      items = length(q_matrix),
      attributes = length(q_matrix[[1L]])
    ),
    responses = responses,
    q_matrix = q_matrix
  )
})

payload <- list(
  schema_version = "1.0.0",
  generated_by = "benchmarks/generate-local-data.R",
  deterministic = TRUE,
  purpose = paste(
    "Exact response and Q matrices for local benchmark cases.",
    "Timing values are intentionally not committed because they depend on hardware and runtime."
  ),
  cases = cases
)

dir.create(dirname(output_path), recursive = TRUE, showWarnings = FALSE)
jsonlite::write_json(
  payload,
  output_path,
  auto_unbox = TRUE,
  digits = 16,
  na = "null",
  null = "null",
  pretty = FALSE
)
cat("Wrote ", length(cases), " local benchmark inputs to ", output_path, "\n", sep = "")
