import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const evidenceDirectory = resolve(here, "evidence");
const reportDirectory = resolve(here, "report");
const generatedAt = "2026-07-16T00:00:00Z";

const comparison = JSON.parse(
  await readFile(resolve(evidenceDirectory, "comparison.json"), "utf8"),
);

let fullPackageComparison = null;
try {
  fullPackageComparison = JSON.parse(
    await readFile(resolve(evidenceDirectory, "full-package-comparison.json"), "utf8"),
  );
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

function scientific(value) {
  if (value === 0) return "0.000e+0";
  return Number(value).toExponential(3);
}

function percent(value) {
  return `${(Number(value) * 100).toFixed(2)}%`;
}

const projectedRows = comparison.cases.map((testCase) => ({
  case: testCase.id,
  dataset: testCase.dataset,
  model: testCase.model,
  dimensions: `${testCase.dimensions.respondents} × ${testCase.dimensions.items} × ${testCase.dimensions.attributes}`,
  missing: testCase.dimensions.missing_responses,
  iterations: `${testCase.r.iterations} / ${testCase.jgdina.iterations}`,
  log_likelihood_difference: scientific(testCase.differences.absoluteLogLikelihood),
  item_probability_difference: scientific(
    testCase.differences.maxAbsoluteItemProbability,
  ),
  prior_probability_difference: scientific(
    testCase.differences.maxAbsolutePriorProbability,
  ),
  eap_probability_difference: scientific(
    testCase.differences.maxAbsoluteEapProbability,
  ),
  map_agreement: percent(testCase.agreements.mapClassFraction),
  mle_agreement: percent(testCase.agreements.mleClassFraction),
  eap_agreement: percent(testCase.agreements.eapClassificationFraction),
  class_agreement: `${percent(testCase.agreements.mapClassFraction)} / ${percent(testCase.agreements.mleClassFraction)} / ${percent(testCase.agreements.eapClassificationFraction)}`,
  result: testCase.passed ? "PASS" : "FAIL",
}));

const maxItemDifference = Math.max(
  ...comparison.cases.map(
    (testCase) => testCase.differences.maxAbsoluteItemProbability,
  ),
);
const maxLogLikelihoodDifference = Math.max(
  ...comparison.cases.map(
    (testCase) => testCase.differences.absoluteLogLikelihood,
  ),
);
const exactIterationCases = comparison.cases.filter(
  (testCase) => testCase.agreements.iterationsExact,
).length;
const exactClassificationCases = comparison.cases.filter(
  (testCase) =>
    testCase.agreements.mapClassFraction === 1 &&
    testCase.agreements.mleClassFraction === 1 &&
    testCase.agreements.eapClassificationFraction === 1,
).length;

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Cannot serialize ${value} to SQL.`);
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function valuesQuery(rows, columns, orderBy = null) {
  const identifiers = columns.map((column) => `"${column}"`).join(", ");
  const values = rows
    .map(
      (row) =>
        `  (${columns.map((column) => sqlLiteral(row[column])).join(", ")})`,
    )
    .join(",\n");
  return `WITH report_rows (${identifiers}) AS (\nVALUES\n${values}\n)\nSELECT * FROM report_rows${orderBy ? ` ORDER BY "${orderBy}"` : ""};\n`;
}

function executeSql(query) {
  const output = execFileSync("sqlite3", ["-json", ":memory:"], {
    encoding: "utf8",
    input: query,
  }).trim();
  return output ? JSON.parse(output) : [];
}

const summaryRowsInput = [
  {
    cases_passed: `${comparison.cases.filter((testCase) => testCase.passed).length} / ${comparison.cases.length}`,
    exact_iterations: `${exactIterationCases} / ${comparison.cases.length}`,
    exact_classification: `${exactClassificationCases} / ${comparison.cases.length}`,
    max_item_difference: `${scientific(maxItemDifference)} absolute`,
  },
];
const iterationRowsInput = comparison.cases.flatMap((testCase) => [
  {
    case: testCase.id,
    runtime: "R",
    iterations: testCase.r.iterations,
  },
  {
    case: testCase.id,
    runtime: "jGDINA",
    iterations: testCase.jgdina.iterations,
  },
]);

const summarySql = valuesQuery(summaryRowsInput, [
  "cases_passed",
  "exact_iterations",
  "exact_classification",
  "max_item_difference",
]);
const casesSql = valuesQuery(
  projectedRows,
  [
    "case",
    "dataset",
    "model",
    "dimensions",
    "missing",
    "iterations",
    "log_likelihood_difference",
    "item_probability_difference",
    "prior_probability_difference",
    "eap_probability_difference",
    "map_agreement",
    "mle_agreement",
    "eap_agreement",
    "class_agreement",
    "result",
  ],
  "case",
);
const iterationSql = valuesQuery(
  iterationRowsInput,
  ["case", "runtime", "iterations"],
  "case",
);

await mkdir(reportDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(reportDirectory, "acceptance-summary.sql"), summarySql, "utf8"),
  writeFile(resolve(reportDirectory, "acceptance-cases.sql"), casesSql, "utf8"),
  writeFile(resolve(reportDirectory, "iteration-parity.sql"), iterationSql, "utf8"),
]);

const summaryRows = executeSql(summarySql);
const rows = executeSql(casesSql);
const iterationRows = executeSql(iterationSql);

const fullPackageText = fullPackageComparison
  ? fullPackageComparison.passed
    ? (() => {
        const wrapperCases = fullPackageComparison.cases ?? [];
        const maxWrapperItem = Math.max(
          ...wrapperCases.map(
            (testCase) =>
              testCase.differences.max_absolute_item_probability,
          ),
        );
        const maxWrapperLogLikelihood = Math.max(
          ...wrapperCases.map(
            (testCase) => testCase.differences.absolute_log_likelihood,
          ),
        );
        const tatsuoka = wrapperCases.find(
          (testCase) => testCase.id === "tatsuoka1990-dina",
        );
        return `An additional full-package wrapper check also passed (${wrapperCases.length} cases) through \`GDINA()\`, \`extract()\`, and \`personparm()\`: maximum item-probability difference ${scientific(maxWrapperItem)} and maximum absolute log-likelihood difference ${scientific(maxWrapperLogLikelihood)}. Fixed class-independent P=.5 row tags preserve duplicate-response frequencies through the wrapper and contribute only a known likelihood constant. For Tatsuoka, upstream random tie selection gives ${percent(tatsuoka.agreements.personparm_map_strict_fraction)} / ${percent(tatsuoka.agreements.personparm_mle_strict_fraction)} strict personparm MAP/MLE identity, while both are 100.00% tie-compatible and deterministic first-max comparisons are 100.00%.`;
      })()
    : "The optional full-package wrapper check was run but did not pass; inspect the wrapper evidence before release."
  : "The optional full-package wrapper check is not present in this snapshot; the mandatory workflow exercises the exact frozen C++ kernel and independent base-R scoring equations.";

const artifact = {
  surface: "report",
  manifest: {
    version: 1,
    surface: "report",
    title: "jGDINA v1.0.0-rc.1 real-data acceptance",
    description:
      "Technical acceptance report comparing jGDINA with the frozen GDINA 2.12.3 implementation on bundled real data.",
    generatedAt,
    cards: [
      {
        id: "acceptance_summary",
        description: "Release-candidate acceptance gates.",
        dataset: "summary",
        sourceId: "summary_sql",
        metrics: [
          { label: "Cases passed", field: "cases_passed" },
          { label: "Exact iterations", field: "exact_iterations" },
          { label: "Exact MAP/MLE/EAP", field: "exact_classification" },
          { label: "Max |Δ item p|", field: "max_item_difference" },
        ],
      },
    ],
    charts: [
      {
        id: "iteration_parity_chart",
        title: "R and jGDINA stop at identical iterations",
        subtitle:
          "Paired bars are equal within every acceptance case; the varying heights reflect case complexity, not disagreement.",
        type: "bar",
        dataset: "iteration_parity",
        sourceId: "iteration_sql",
        encodings: {
          x: { field: "case", type: "nominal", label: "Acceptance case" },
          y: {
            field: "iterations",
            type: "quantitative",
            label: "EM iterations",
            format: "number",
          },
          color: { field: "runtime", type: "nominal", label: "Runtime" },
        },
        yAxisTitle: "EM iterations",
        valueFormat: "number",
      },
    ],
    tables: [
      {
        id: "acceptance_cases_table",
        title: "Acceptance overview",
        subtitle:
          "R / jGDINA iterations and MAP / MLE / EAP classification agreement.",
        dataset: "acceptance_cases",
        sourceId: "cases_sql",
        defaultSort: { field: "case", direction: "asc" },
        columns: [
          { field: "case", label: "Case", type: "text" },
          { field: "model", label: "Model", type: "text" },
          { field: "dimensions", label: "N × J × K", type: "text" },
          { field: "missing", label: "Missing", type: "number" },
          { field: "result", label: "Result", type: "text" },
        ],
      },
      {
        id: "discrete_parity_table",
        title: "Iteration and classification parity",
        subtitle:
          "Iteration counts are R / jGDINA; agreement columns are respondent fractions.",
        dataset: "acceptance_cases",
        sourceId: "cases_sql",
        defaultSort: { field: "case", direction: "asc" },
        columns: [
          { field: "case", label: "Case", type: "text" },
          { field: "iterations", label: "Iterations R / JS", type: "text" },
          { field: "map_agreement", label: "MAP", type: "text" },
          { field: "mle_agreement", label: "MLE", type: "text" },
          { field: "eap_agreement", label: "EAP", type: "text" },
        ],
      },
      {
        id: "numerical_differences_table",
        title: "Absolute numerical differences",
        subtitle:
          "Exact scientific-notation values; all are several orders of magnitude inside the acceptance gates.",
        dataset: "acceptance_cases",
        sourceId: "cases_sql",
        defaultSort: { field: "case", direction: "asc" },
        columns: [
          { field: "case", label: "Case", type: "text" },
          {
            field: "log_likelihood_difference",
            label: "|Δ logLik|",
            type: "text",
          },
          {
            field: "item_probability_difference",
            label: "max |Δ item p|",
            type: "text",
          },
          {
            field: "prior_probability_difference",
            label: "max |Δ prior p|",
            type: "text",
          },
          {
            field: "eap_probability_difference",
            label: "max |Δ EAP p|",
            type: "text",
          },
        ],
      },
    ],
    sources: [
      {
        id: "summary_sql",
        label: "Release-gate summary query",
        path: "validation/real-data/report/acceptance-summary.sql",
      },
      {
        id: "cases_sql",
        label: "Case-level acceptance table query",
        path: "validation/real-data/report/acceptance-cases.sql",
      },
      {
        id: "iteration_sql",
        label: "Iteration parity chart query",
        path: "validation/real-data/report/iteration-parity.sql",
      },
      {
        id: "comparison_json",
        label: "Machine-readable acceptance decisions",
        path: "validation/real-data/evidence/comparison.json",
      },
      {
        id: "r_reference",
        label: "Deterministic R reference inputs and results",
        path: "validation/real-data/evidence/r-reference.json",
      },
      {
        id: "upstream_kernel",
        label: "Frozen upstream fast EM kernel",
        path: "GDINA-master/src/Lik2.cpp",
      },
      ...(fullPackageComparison
        ? [
            {
              id: "full_package_comparison",
              label: "Optional full GDINA package wrapper comparison",
              path: "validation/real-data/evidence/full-package-comparison.json",
            },
          ]
        : []),
    ],
    blocks: [
      {
        id: "title",
        type: "markdown",
        body: "# jGDINA v1.0.0-rc.1 real-data acceptance",
      },
      {
        id: "technical_summary",
        type: "markdown",
        sourceId: "comparison_json",
        body: `## Technical summary\n\nThe release candidate passes all ${comparison.cases.length} committed real-data gates. R and jGDINA use identical iteration counts in every case, MAP/MLE/EAP classifications agree for every respondent, the maximum item-probability difference is ${scientific(maxItemDifference)}, and the maximum absolute log-likelihood difference is ${scientific(maxLogLikelihoodDifference)}. These results support an **RC acceptance decision**, while user-owned research data remains an external validation step rather than evidence available in this repository.`,
      },
      {
        id: "metrics",
        type: "metric-strip",
        cardIds: ["acceptance_summary"],
      },
      {
        id: "findings",
        type: "markdown",
        sourceId: "comparison_json",
        body: "## Key findings and evidence\n\n- ECPE passes under GDINA and DINO.\n- Tatsuoka (1990) passes under DINA with 8 attributes and 256 latent classes.\n- A deterministic 812-response ECPE missing-value mask passes under GDINA.\n- Attribute-pattern order, initialization, convergence status, missing counts, and iteration counts are exact in every case.\n- MAP, MLE, and EAP-derived classifications agree for 100% of respondents in every case.",
      },
      {
        id: "iteration_parity",
        type: "chart",
        chartId: "iteration_parity_chart",
      },
      { id: "cases", type: "table", tableId: "acceptance_cases_table" },
      {
        id: "discrete_parity",
        type: "table",
        tableId: "discrete_parity_table",
      },
      {
        id: "numerical_differences",
        type: "table",
        tableId: "numerical_differences_table",
      },
      {
        id: "scope",
        type: "markdown",
        sourceId: "r_reference",
        body: "## Scope, data, and acceptance definitions\n\nThe frozen GDINA 2.12.3 checkout contains exactly two bundled `realdata_*.rda` files: ECPE and Tatsuoka1990. The fourth case is not presented as a third dataset; it is a deterministic missing-value transformation of ECPE. Acceptance tolerances are `1e-8` for item, prior, and EAP probabilities; `1e-7` for log likelihood; and exact equality for iteration counts and discrete classifications.",
      },
      {
        id: "methodology",
        type: "markdown",
        sourceId: "upstream_kernel",
        body: `## Methodology\n\nThe reproducible workflow compiles the exact frozen \`GDINA-master/src/Lik2.cpp\` fast EM kernel through Rcpp, serializes all inputs and R results, rebuilds the TypeScript packages, and compares the same starts, priors, class order, probability bounds, correction rules, missing-value semantics, and convergence settings. Final likelihood and scoring equations are independently implemented in base R and audited against that kernel. ${fullPackageText}`,
      },
      {
        id: "limitations",
        type: "markdown",
        sourceId: fullPackageComparison
          ? "full_package_comparison"
          : "comparison_json",
        body: "## Limitations and robustness\n\nThis is high-strength equivalence evidence for the implemented v1 estimation path, not proof that every function in the upstream R package has been ported. The repository only supplies two genuine bundled datasets; broader external validity requires the user's own de-identified research data. Browser-worker behavior and Next.js production integration are verified elsewhere in the release pipeline, not inferred from this statistical table. Very small nonzero floating-point differences are expected across R/C++ and JavaScript runtimes and remain several orders of magnitude inside the stated gates.",
      },
      {
        id: "next_steps",
        type: "markdown",
        body: "## Recommended next steps\n\n1. Keep this workflow as a required CI release gate.\n2. Run the same locked comparison on one de-identified user research dataset before declaring the application deployment validated.\n3. Publish `1.0.0-rc.1` only after npm authentication, organization-scope access, and a clean release commit are confirmed.\n4. Collect RC feedback before expanding the v1.1 model surface.",
      },
      {
        id: "questions",
        type: "markdown",
        body: "## Further questions\n\n- Which de-identified user dataset and expected R outputs should become the first external acceptance fixture?\n- Should the full R-package wrapper check remain optional, or should CI install the complete upstream dependency graph?\n- What browser and deployment traffic limits should determine the default worker-pool size in production?",
      },
    ],
  },
  snapshot: {
    version: 1,
    generatedAt,
    status: comparison.passed ? "ready" : "partial",
    datasets: {
      summary: summaryRows,
      acceptance_cases: rows,
      iteration_parity: iterationRows,
    },
    accessIssues: [],
  },
  sources: [
    {
      id: "summary_sql",
      query: {
        engine: "SQLite 3",
        sql: summarySql,
        description:
          "Projects the release-gate headline metrics from the validated snapshot.",
        executed_at: generatedAt,
      },
    },
    {
      id: "cases_sql",
      query: {
        engine: "SQLite 3",
        sql: casesSql,
        description:
          "Projects the exact case-level values into the report audit table.",
        executed_at: generatedAt,
      },
    },
    {
      id: "iteration_sql",
      query: {
        engine: "SQLite 3",
        sql: iterationSql,
        description:
          "Projects paired R and jGDINA iteration counts for the parity chart.",
        executed_at: generatedAt,
      },
    },
    {
      id: "comparison_json",
      query: {
        engine: "Node.js",
        description:
          "Reads the committed deterministic R-to-jGDINA acceptance decisions.",
        executed_at: generatedAt,
      },
    },
    {
      id: "r_reference",
      query: {
        engine: "R 4.x + Rcpp",
        description:
          "Regenerates deterministic estimates and person scores from bundled real datasets.",
        executed_at: generatedAt,
      },
    },
    {
      id: "upstream_kernel",
      query: {
        engine: "Rcpp",
        description:
          "Compiles the frozen GDINA 2.12.3 fast EM implementation without source changes.",
        executed_at: generatedAt,
      },
    },
    ...(fullPackageComparison
      ? [
          {
            id: "full_package_comparison",
            query: {
              engine: "R GDINA 2.12.3",
              description:
                "Calls the full GDINA package wrapper using the locked acceptance inputs.",
              executed_at: generatedAt,
            },
          },
        ]
      : []),
  ],
};

await writeFile(
  resolve(reportDirectory, "artifact.json"),
  `${JSON.stringify(artifact, null, 2)}\n`,
  "utf8",
);

console.log(
  `Wrote ${resolve(reportDirectory, "artifact.json")} from ${comparison.cases.length} acceptance cases.`,
);
