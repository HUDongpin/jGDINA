#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fit } from "../../packages/jgdina/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const evidenceDirectory = join(here, "evidence");
const reference = JSON.parse(
  await readFile(join(evidenceDirectory, "r-reference.json"), "utf8"),
);

function maxAbsoluteVectorDifference(actual, expected) {
  if (actual.length !== expected.length) return Number.POSITIVE_INFINITY;
  let maximum = 0;
  for (let index = 0; index < actual.length; index += 1) {
    maximum = Math.max(maximum, Math.abs(actual[index] - expected[index]));
  }
  return maximum;
}

function flatten(matrix) {
  return matrix.flatMap((row) => row);
}

function exactAgreement(actual, expected) {
  if (actual.length !== expected.length) return 0;
  let equal = 0;
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] === expected[index]) equal += 1;
  }
  return equal / expected.length;
}

function finiteMetric(value) {
  return Number.isFinite(value) ? value : null;
}

const comparisons = [];
for (const oracleCase of reference.cases) {
  const options = oracleCase.input.estimation;
  const result = await fit({
    responses: oracleCase.input.responses,
    qMatrix: oracleCase.input.q_matrix,
    model: oracleCase.model,
    prior: {
      type: "saturated",
      initialProbabilities: oracleCase.input.initial_prior,
    },
    estimation: {
      aggregateRows: options.aggregate_rows,
      convergenceTolerance: options.convergence_tolerance,
      initialization: {
        starts: options.starts,
        initialItemProbabilities: oracleCase.input.initial_item_group_probabilities,
      },
      maxIterations: options.max_iterations,
      posteriorStorage: options.posterior_storage,
      probabilityBounds: options.probability_bounds,
      smallSampleCorrection: options.small_sample_correction,
    },
  });

  const actualItems = result.estimates.items.map((item) => item.groupSuccessProbabilities);
  const itemDifference = maxAbsoluteVectorDifference(
    flatten(actualItems),
    flatten(oracleCase.expected.item_group_probabilities),
  );
  const priorDifference = maxAbsoluteVectorDifference(
    result.estimates.classProbabilities,
    oracleCase.expected.class_prior,
  );
  const logLikelihoodDifference = Math.abs(
    result.statistics.logLikelihood - oracleCase.expected.log_likelihood,
  );
  const initialLogLikelihoodDifference = Math.abs(
    result.convergence.starts[0].initialLogLikelihood -
      oracleCase.expected.initial_log_likelihood,
  );
  const eapDifference = maxAbsoluteVectorDifference(
    flatten(result.scores.eapAttributeProbabilities),
    flatten(oracleCase.expected.eap_attribute_probabilities),
  );
  const mapAgreement = exactAgreement(
    result.scores.mapClassIndices,
    oracleCase.expected.map_class_indices,
  );
  const mleAgreement = exactAgreement(
    result.scores.mleClassIndices,
    oracleCase.expected.mle_class_indices,
  );
  const eapClassAgreement = exactAgreement(
    flatten(result.scores.eapAttributeClassifications),
    flatten(oracleCase.expected.eap_attribute_classifications),
  );
  const iterationsMatch = result.convergence.iterations === oracleCase.expected.iterations;
  const convergedMatch = result.convergence.converged === oracleCase.expected.converged;
  const attributePatternOrderMatch =
    JSON.stringify(result.attributePatterns) ===
    JSON.stringify(oracleCase.expected.attribute_patterns);
  const initializationMatch =
    result.convergence.selectedStartIndex === 0 &&
    result.convergence.starts.length === 1 &&
    result.convergence.starts[0].selectedForEstimation;
  const missingCountMatch =
    result.diagnostics.missingResponseCount === oracleCase.dimensions.missing_responses;
  const tolerances = reference.tolerances;
  const passed =
    itemDifference <= tolerances.item_probability_absolute &&
    priorDifference <= tolerances.prior_probability_absolute &&
    logLikelihoodDifference <= tolerances.log_likelihood_absolute &&
    initialLogLikelihoodDifference <= tolerances.log_likelihood_absolute &&
    eapDifference <= tolerances.eap_probability_absolute &&
    iterationsMatch &&
    convergedMatch &&
    attributePatternOrderMatch &&
    initializationMatch &&
    missingCountMatch &&
    mapAgreement === 1 &&
    mleAgreement === 1 &&
    eapClassAgreement === 1;

  comparisons.push({
    id: oracleCase.id,
    dataset: oracleCase.dataset,
    derivation: oracleCase.derivation,
    model: oracleCase.model,
    dimensions: oracleCase.dimensions,
    passed,
    r: {
      converged: oracleCase.expected.converged,
      iterations: oracleCase.expected.iterations,
      logLikelihood: oracleCase.expected.log_likelihood,
    },
    jgdina: {
      backendId: result.backendId,
      converged: result.convergence.converged,
      iterations: result.convergence.iterations,
      logLikelihood: result.statistics.logLikelihood,
      missingResponseCount: result.diagnostics.missingResponseCount,
    },
    differences: {
      maxAbsoluteItemProbability: finiteMetric(itemDifference),
      maxAbsolutePriorProbability: finiteMetric(priorDifference),
      absoluteInitialLogLikelihood: finiteMetric(initialLogLikelihoodDifference),
      absoluteLogLikelihood: finiteMetric(logLikelihoodDifference),
      maxAbsoluteEapProbability: finiteMetric(eapDifference),
    },
    agreements: {
      iterationsExact: iterationsMatch,
      convergedExact: convergedMatch,
      attributePatternOrderExact: attributePatternOrderMatch,
      initializationExact: initializationMatch,
      missingCountExact: missingCountMatch,
      mapClassFraction: mapAgreement,
      mleClassFraction: mleAgreement,
      eapClassificationFraction: eapClassAgreement,
    },
  });
}

const report = {
  schemaVersion: "1.0.0",
  generatedBy: "validation/real-data/compare.mjs",
  deterministic: true,
  passed: comparisons.every((comparison) => comparison.passed),
  upstream: reference.upstream,
  tolerances: reference.tolerances,
  cases: comparisons,
};

let fullPackageReport = null;
try {
  fullPackageReport = JSON.parse(
    await readFile(join(evidenceDirectory, "full-package-comparison.json"), "utf8"),
  );
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

await writeFile(
  join(evidenceDirectory, "comparison.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

const csvColumns = [
  "id",
  "dataset",
  "derivation",
  "model",
  "respondents",
  "items",
  "attributes",
  "missingResponses",
  "passed",
  "rIterations",
  "jgdinaIterations",
  "rLogLikelihood",
  "jgdinaLogLikelihood",
  "maxAbsoluteItemProbability",
  "maxAbsolutePriorProbability",
  "absoluteInitialLogLikelihood",
  "absoluteLogLikelihood",
  "maxAbsoluteEapProbability",
  "mapClassAgreement",
  "mleClassAgreement",
  "eapClassificationAgreement",
  "attributePatternOrderExact",
  "initializationExact",
];
const csvRows = comparisons.map((comparison) => [
  comparison.id,
  comparison.dataset,
  comparison.derivation,
  comparison.model,
  comparison.dimensions.respondents,
  comparison.dimensions.items,
  comparison.dimensions.attributes,
  comparison.dimensions.missing_responses,
  comparison.passed,
  comparison.r.iterations,
  comparison.jgdina.iterations,
  comparison.r.logLikelihood,
  comparison.jgdina.logLikelihood,
  comparison.differences.maxAbsoluteItemProbability,
  comparison.differences.maxAbsolutePriorProbability,
  comparison.differences.absoluteInitialLogLikelihood,
  comparison.differences.absoluteLogLikelihood,
  comparison.differences.maxAbsoluteEapProbability,
  comparison.agreements.mapClassFraction,
  comparison.agreements.mleClassFraction,
  comparison.agreements.eapClassificationFraction,
  comparison.agreements.attributePatternOrderExact,
  comparison.agreements.initializationExact,
]);
const csv = [csvColumns, ...csvRows]
  .map((row) => row.map((value) => JSON.stringify(value ?? "")).join(","))
  .join("\n");
await writeFile(join(evidenceDirectory, "comparison.csv"), `${csv}\n`);

const lines = [
  "# Real-data R–jGDINA acceptance summary",
  "",
  `Overall result: **${report.passed ? "PASS" : "FAIL"}**`,
  "",
  "| Case | Model | N × J × K | Missing | Iterations R / JS | |Δ logLik| | max |Δ item p| | MAP / MLE / EAP class agreement | Result |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...comparisons.map((comparison) =>
    `| ${comparison.id} | ${comparison.model} | ${comparison.dimensions.respondents} × ${comparison.dimensions.items} × ${comparison.dimensions.attributes} | ${comparison.dimensions.missing_responses} | ${comparison.r.iterations} / ${comparison.jgdina.iterations} | ${comparison.differences.absoluteLogLikelihood.toExponential(3)} | ${comparison.differences.maxAbsoluteItemProbability.toExponential(3)} | ${(100 * comparison.agreements.mapClassFraction).toFixed(2)}% / ${(100 * comparison.agreements.mleClassFraction).toFixed(2)}% / ${(100 * comparison.agreements.eapClassificationFraction).toFixed(2)}% | ${comparison.passed ? "PASS" : "FAIL"} |`,
  ),
  "",
  "## Scope and provenance",
  "",
  "- Inputs are the ECPE and Tatsuoka (1990) real datasets bundled in the frozen GDINA 2.12.3 source tree.",
  "- The source bundle contains exactly two `realdata_*.rda` files, so no third dataset was invented or relabeled as real data.",
  "- Item and prior estimates plus iteration counts come from the exact frozen `src/Lik2.cpp` fast EM kernel.",
  ...(fullPackageReport === null
    ? ["- The dependency-light reference does not load the full R package. Final log-likelihoods and person scores are evaluated with independent base-R equations already cross-checked against that kernel."]
    : ["- The dependency-light reference deliberately does not load the full R package. The separately installed-package audit below checks the complete public wrapper and person-parameter surfaces."]),
  "- `ecpe-gdina-missing` applies a deterministic mask to the original ECPE responses solely to verify identical item-level missing-value treatment.",
  "- All starts, priors, class ordering, probability bounds, corrections and convergence settings are serialized in `r-reference.json`.",
  "",
  "## Complete installed-package wrapper audit",
  "",
  ...(fullPackageReport === null
    ? [
        "Not run in this environment. This optional audit requires an installed GDINA 2.12.3 package; the exact-kernel CI gate above remains self-contained.",
      ]
    : [
        `Overall result: **${fullPackageReport.passed ? "PASS" : "FAIL"}** through \`${fullPackageReport.package.interface}\`.`,
        "",
        "| Case | Iterations reference / wrapper | |Δ logLik| | max |Δ item p| | extract first-max MAP / MLE / personparm EAP agreement | Result |",
        "|---|---:|---:|---:|---:|---:|",
        ...fullPackageReport.cases.map((fullCase) =>
          `| ${fullCase.id} | ${fullCase.reference.iterations} / ${fullCase.full_package.iterations} | ${fullCase.differences.absolute_log_likelihood.toExponential(3)} | ${fullCase.differences.max_absolute_item_probability.toExponential(3)} | ${(100 * fullCase.agreements.direct_map_class_fraction).toFixed(2)}% / ${(100 * fullCase.agreements.direct_mle_class_fraction).toFixed(2)}% / ${(100 * fullCase.agreements.personparm_eap_classification_fraction).toFixed(2)}% | ${fullCase.passed ? "PASS" : "FAIL"} |`,
        ),
        "",
        "The complete-wrapper audit uses fixed class-independent P=.5 row tags to preserve respondent frequencies through GDINA()'s unconditional response-pattern aggregation; their known constant likelihood contribution is removed. This optional audit is separate from the dependency-light exact-kernel CI gate.",
        "",
        ...fullPackageReport.cases
          .filter(
            (fullCase) =>
              fullCase.agreements.personparm_map_strict_fraction < 1 ||
              fullCase.agreements.personparm_mle_strict_fraction < 1,
          )
          .map(
            (fullCase) =>
              `For ${fullCase.id}, \`personparm()\`'s random tie selection yields ${(100 * fullCase.agreements.personparm_map_strict_fraction).toFixed(2)}% / ${(100 * fullCase.agreements.personparm_mle_strict_fraction).toFixed(2)}% strict MAP/MLE profile agreement, while both are ${(100 * Math.min(fullCase.agreements.personparm_map_tie_compatible_fraction, fullCase.agreements.personparm_mle_tie_compatible_fraction)).toFixed(2)}% tie-compatible; deterministic first-maximum indices from \`extract()\` agree 100%.`,
          ),
      ]),
  "",
  "## Reproduce",
  "",
  "From the repository root, run `npm run accept:real-data`. The command rebuilds jGDINA, recompiles the frozen R kernel, regenerates the reference, compares every field and exits nonzero on any failed gate.",
  "",
  "To repeat the optional installed-package audit, set `JGDINA_R_LIB=/tmp/jgdina-r-lib` and `R_MAKEVARS_USER=/tmp/jgdina-Makevars`, then run `npm run accept:full-package`. This audit is intentionally not part of the dependency-light CI gate.",
  "",
];
await writeFile(join(here, "SUMMARY.md"), `${lines.join("\n")}\n`);

for (const comparison of comparisons) {
  console.log(
    `${comparison.passed ? "PASS" : "FAIL"} ${comparison.id}: iterations=${comparison.r.iterations}/${comparison.jgdina.iterations} ` +
      `item=${comparison.differences.maxAbsoluteItemProbability.toExponential(3)} ` +
      `prior=${comparison.differences.maxAbsolutePriorProbability.toExponential(3)} ` +
      `logLik=${comparison.differences.absoluteLogLikelihood.toExponential(3)} ` +
      `EAP=${comparison.differences.maxAbsoluteEapProbability.toExponential(3)}`,
  );
}

if (!report.passed) process.exitCode = 1;
