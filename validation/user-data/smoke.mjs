#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const cli = join(here, "accept.mjs");
const fixturePath = join(root, "fixtures/v1/em-gdina-saturated.json");
const fixedFixturePath = join(root, "fixtures/v1/em-gdina-fixed-prior.json");
const examplePath = join(here, "case.example.json");
const schemaPath = join(here, "case.schema.json");
const expectedFiles = ["SUMMARY.md", "provenance.private.json", "summary.json"];
const expectedProgress =
  "[1/3] Running the local jGDINA worker fit...\n" +
  "[2/3] Running the private local R numerical oracle...\n" +
  "[3/3] Writing aggregate-only private evidence...\n";
const expectedFitOnlyProgress =
  "[1/3] Running the local jGDINA worker fit...\n" +
  "[3/3] Writing aggregate-only private evidence...\n";
const forbiddenKeys = new Set([
  "responses",
  "qMatrix",
  "q_matrix",
  "personScores",
  "person_scores",
  "posteriorProbabilities",
  "posterior_probabilities",
  "mapClassIndices",
  "map_class_indices",
  "mleClassIndices",
  "mle_class_indices",
  "eapAttributeProbabilities",
  "eap_attribute_probabilities",
  "eapAttributeClassifications",
  "eap_attribute_classifications",
  "respondentIds",
  "respondent_ids",
]);

function assertNoForbiddenKeys(value, path = "output") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenKeys(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    assert.ok(!forbiddenKeys.has(key), `${path} leaked forbidden field ${key}`);
    assertNoForbiddenKeys(nested, `${path}.${key}`);
  }
}

function assertNoRespondentLengthArrays(value, respondents, path = "output") {
  if (Array.isArray(value)) {
    const aggregateArray = new Set([
      "summary.configuration.probabilityBounds",
      "summary.configuration.smallSampleCorrection",
      "summary.review.warnings",
      "summary.limitations",
    ]).has(path);
    if (!aggregateArray) {
      assert.notEqual(value.length, respondents, `${path} contains a respondent-length array`);
    }
    value.forEach((entry, index) => {
      assertNoRespondentLengthArrays(entry, respondents, `${path}[${index}]`);
    });
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    assertNoRespondentLengthArrays(nested, respondents, `${path}.${key}`);
  }
}

function assertAggregateArrayPolicy(value, path = "summary") {
  const allowed = new Set([
    "summary.configuration.probabilityBounds",
    "summary.configuration.smallSampleCorrection",
    "summary.review.warnings",
    "summary.limitations",
  ]);
  if (Array.isArray(value)) {
    assert.ok(allowed.has(path), `${path} is not an approved aggregate array`);
    value.forEach((entry, index) => assertAggregateArrayPolicy(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    assertAggregateArrayPolicy(nested, `${path}.${key}`);
  }
}

async function runCli(arguments_, timeoutMilliseconds = 15 * 60_000) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cli, ...arguments_], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const maximumOutput = 2 * 1024 * 1024;
    const append = (current, chunk) => {
      const next = current + chunk;
      return next.length <= maximumOutput ? next : next.slice(-maximumOutput);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`Acceptance CLI exceeded ${timeoutMilliseconds} ms.`));
    }, timeoutMilliseconds);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

async function assertCliFailure(arguments_, expectedCode, expectedErrorCode) {
  const result = await runCli(arguments_);
  assert.equal(
    result.code,
    expectedCode,
    `Expected CLI failure ${expectedCode}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stderr, new RegExp(`^${expectedErrorCode}:`, "u"));
  return result;
}

function assertDecisionExit(result, status) {
  const expected = { PASS: 0, FAIL: 2, REVIEW: 3, FIT_ONLY: 3 }[status];
  assert.equal(result.code, expected, `status ${status} must map to exit ${expected}`);
}

function buildPrivateCase(fixture, caseId = "private-workflow-frozen-kernel-smoke") {
  const input = fixture.input;
  const responses = input.responses.flatMap((row, index) =>
    Array.from({ length: input.response_weights[index] }, () => [...row]));
  return {
    schemaVersion: "jgdina-user-case/1",
    caseId,
    privacy: {
      directIdentifiersRemoved: true,
      respondentIdsExcluded: true,
      freeTextExcluded: true,
    },
    fitInput: {
      responses,
      qMatrix: input.q_matrix,
      model: input.models,
      prior: input.prior.mode === "fixed"
        ? { type: "fixed", probabilities: input.prior.initial_probabilities }
        : { type: "saturated", initialProbabilities: input.prior.initial_probabilities },
      estimation: {
        maxIterations: input.options.max_iterations,
        convergenceTolerance: input.options.convergence_tolerance,
        probabilityBounds: input.options.probability_bounds,
        smallSampleCorrection: input.options.correction,
        aggregateRows: false,
        posteriorStorage: "scores-only",
        initialization: {
          strategy: "deterministic",
          starts: 1,
          seed: 123456,
          initialItemProbabilities: input.initial_item_group_probabilities,
        },
      },
    },
  };
}

function stableEvidence(summary) {
  const { elapsedMilliseconds, rssDeltaBytes, processPeakResidentBytes, ...stableJgdina } =
    summary.jgdina;
  const { elapsedSeconds, ...stableR } = summary.parity.r;
  return {
    schemaVersion: summary.schemaVersion,
    status: summary.status,
    caseId: summary.caseId,
    acceptanceScope: summary.acceptanceScope,
    finalInstrumentAcceptance: summary.finalInstrumentAcceptance,
    privacy: summary.privacy,
    dimensions: summary.dimensions,
    missingResponseCount: summary.missingResponseCount,
    modelCounts: summary.modelCounts,
    priorType: summary.priorType,
    rOracleMemoryEstimate: summary.rOracleMemoryEstimate,
    runtimeFingerprint: summary.runtimeFingerprint,
    configuration: summary.configuration,
    jgdina: stableJgdina,
    parity: {
      passed: summary.parity.passed,
      gates: summary.parity.gates,
      differences: summary.parity.differences,
      agreements: summary.parity.agreements,
      r: stableR,
    },
    tolerances: summary.tolerances,
    review: summary.review,
    limitations: summary.limitations,
  };
}

async function assertPrivateOutput(
  outputPath,
  privateCase,
  allowedStatuses = ["PASS"],
  expectedParityPassed = true,
) {
  const respondents = privateCase.fitInput.responses.length;
  const directoryStat = await stat(outputPath);
  assert.ok(directoryStat.isDirectory());
  if (process.platform !== "win32") {
    assert.equal(directoryStat.mode & 0o777, 0o700, "output directory must be mode 0700");
  }
  assert.deepEqual((await readdir(outputPath)).sort(), expectedFiles);

  for (const file of expectedFiles) {
    const fileStat = await stat(join(outputPath, file));
    assert.ok(fileStat.isFile(), `${file} must be a regular file`);
    if (process.platform !== "win32") {
      assert.equal(fileStat.mode & 0o777, 0o600, `${file} must be mode 0600`);
    }
  }

  const summary = JSON.parse(await readFile(join(outputPath, "summary.json"), "utf8"));
  const provenance = JSON.parse(
    await readFile(join(outputPath, "provenance.private.json"), "utf8"),
  );
  assertNoForbiddenKeys(summary, "summary");
  assertNoForbiddenKeys(provenance, "provenance");
  assertAggregateArrayPolicy(summary);
  assertNoRespondentLengthArrays(summary, respondents, "summary");
  assertNoRespondentLengthArrays(provenance, respondents, "provenance");
  assert.deepEqual(summary.privacy, {
    containsRawResponses: false,
    containsQMatrix: false,
    containsRespondentIdentifiers: false,
    containsPersonScores: false,
  });
  assert.ok(allowedStatuses.includes(summary.status), `unexpected status ${summary.status}`);
  assert.equal(
    summary.acceptanceScope,
    "technical-frozen-kernel-or-independent-equations-parity",
  );
  assert.equal(summary.finalInstrumentAcceptance, false);
  if (expectedParityPassed === null) {
    assert.equal(summary.parity, null);
  } else {
    assert.equal(summary.parity?.passed, expectedParityPassed);
    assert.equal(
      Object.values(summary.parity.gates).every((value) => value === true || value === null),
      expectedParityPassed,
    );
  }
  assert.equal(summary.configuration.posteriorStorage, "scores-only");
  assert.match(summary.runtimeFingerprint.treeSha256, /^[a-f0-9]{64}$/u);
  assert.match(summary.runtimeFingerprint.acceptCliSha256, /^[a-f0-9]{64}$/u);
  assert.equal(provenance.private, true);
  for (const field of [
    "caseFileSha256",
    "normalizedFitInputSha256",
    "initializationSha256",
  ]) {
    assert.match(provenance[field], /^[a-f0-9]{64}$/u);
  }

  const allOutput = await Promise.all(
    expectedFiles.map((file) => readFile(join(outputPath, file), "utf8")),
  );
  const serializedResponses = JSON.stringify(privateCase.fitInput.responses);
  const serializedQMatrix = JSON.stringify(privateCase.fitInput.qMatrix);
  for (const contents of allOutput) {
    assert.ok(!contents.includes(serializedResponses), "output leaked the response matrix");
    assert.ok(!contents.includes(serializedQMatrix), "output leaked the Q-matrix");
  }
  return { summary, provenance };
}

if (process.platform === "win32") {
  const failClosed = await runCli([
    "--case",
    "C:\\jgdina-private-case.json",
    "--oracle",
    "kernel",
    "--preflight",
  ]);
  assert.equal(failClosed.code, 69);
  assert.match(failClosed.stderr, /^PLATFORM_PRIVACY:/u);
  console.log("Private user-data smoke passed the Windows fail-closed ACL gate.");
  process.exit(0);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "jgdina-user-data-smoke-"));
await chmod(temporaryRoot, 0o700);
try {
  const [fixture, fixedFixture, example, schema] = await Promise.all(
    [fixturePath, fixedFixturePath, examplePath, schemaPath].map(async (path) =>
      JSON.parse(await readFile(path, "utf8"))),
  );
  assert.equal(example.schemaVersion, "jgdina-user-case/1");
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.properties.schemaVersion.const, "jgdina-user-case/1");
  assert.equal(schema.$defs.estimation.properties.posteriorStorage.const, "scores-only");
  assert.equal(schema.$defs.tolerances.properties.classificationAgreement.const, 1);

  const exampleCasePath = join(temporaryRoot, "example-case.json");
  await writeFile(exampleCasePath, `${JSON.stringify(example)}\n`, { mode: 0o600 });
  await chmod(exampleCasePath, 0o600);
  await assertCliFailure(
    ["--case", examplePath, "--oracle", "kernel", "--preflight"],
    65,
    "INPUT_INSIDE_WORKSPACE",
  );
  const looseTolerance = structuredClone(example);
  looseTolerance.acceptance.tolerances.probabilityAbsolute = 1;
  const looseTolerancePath = join(temporaryRoot, "loose-tolerance.json");
  await writeFile(looseTolerancePath, `${JSON.stringify(looseTolerance)}\n`, { mode: 0o600 });
  await chmod(looseTolerancePath, 0o600);
  await assertCliFailure(
    ["--case", looseTolerancePath, "--oracle", "kernel", "--preflight"],
    65,
    "SCHEMA",
  );
  const malformed = structuredClone(example);
  malformed.fitInput.estimation = "not-an-object";
  const malformedPath = join(temporaryRoot, "malformed.json");
  await writeFile(malformedPath, `${JSON.stringify(malformed)}\n`, { mode: 0o600 });
  await chmod(malformedPath, 0o600);
  await assertCliFailure(
    ["--case", malformedPath, "--oracle", "kernel", "--preflight"],
    65,
    "SCHEMA",
  );
  const nullControl = structuredClone(example);
  nullControl.fitInput.estimation.maxIterations = null;
  const nullControlPath = join(temporaryRoot, "null-control.json");
  await writeFile(nullControlPath, `${JSON.stringify(nullControl)}\n`, { mode: 0o600 });
  await chmod(nullControlPath, 0o600);
  await assertCliFailure(
    ["--case", nullControlPath, "--oracle", "kernel", "--preflight"],
    65,
    "FIT_INPUT_INVALID",
  );
  const lowercaseModel = structuredClone(example);
  lowercaseModel.fitInput.model[0] = "gdina";
  const lowercaseModelPath = join(temporaryRoot, "lowercase-model.json");
  await writeFile(lowercaseModelPath, `${JSON.stringify(lowercaseModel)}\n`, { mode: 0o600 });
  await chmod(lowercaseModelPath, 0o600);
  await assertCliFailure(
    ["--case", lowercaseModelPath, "--oracle", "kernel", "--preflight"],
    65,
    "SCHEMA",
  );
  const invalidStrategy = structuredClone(example);
  invalidStrategy.fitInput.estimation.initialization.strategy = "random";
  const invalidStrategyPath = join(temporaryRoot, "invalid-strategy.json");
  await writeFile(invalidStrategyPath, `${JSON.stringify(invalidStrategy)}\n`, { mode: 0o600 });
  await chmod(invalidStrategyPath, 0o600);
  await assertCliFailure(
    ["--case", invalidStrategyPath, "--oracle", "kernel", "--preflight"],
    65,
    "SCHEMA",
  );
  if (process.platform !== "win32") {
    const loosePermissionsPath = join(temporaryRoot, "loose-permissions.json");
    await writeFile(loosePermissionsPath, `${JSON.stringify(example)}\n`, { mode: 0o644 });
    await chmod(loosePermissionsPath, 0o644);
    await assertCliFailure(
      ["--case", loosePermissionsPath, "--oracle", "kernel", "--preflight"],
      65,
      "INPUT_PERMISSIONS",
    );
    const symlinkCasePath = join(temporaryRoot, "symlink-case.json");
    await symlink(exampleCasePath, symlinkCasePath);
    await assertCliFailure(
      ["--case", symlinkCasePath, "--oracle", "kernel", "--preflight"],
      65,
      "INPUT_TYPE",
    );
  }
  const oracleHeavyCase = {
    schemaVersion: "jgdina-user-case/1",
    caseId: "oracle-memory-gate-smoke",
    privacy: {
      directIdentifiersRemoved: true,
      respondentIdsExcluded: true,
      freeTextExcluded: true,
    },
    fitInput: {
      responses: Array.from({ length: 5000 }, (_, index) => [index % 2]),
      qMatrix: [Array(12).fill(1)],
      model: "GDINA",
      prior: { type: "saturated" },
      estimation: {
        maxIterations: 10,
        aggregateRows: false,
        posteriorStorage: "scores-only",
        initialization: { starts: 1 },
      },
    },
  };
  const oracleHeavyPath = join(temporaryRoot, "oracle-heavy.json");
  await writeFile(oracleHeavyPath, `${JSON.stringify(oracleHeavyCase)}\n`, { mode: 0o600 });
  await chmod(oracleHeavyPath, 0o600);
  await assertCliFailure(
    ["--case", oracleHeavyPath, "--oracle", "kernel", "--preflight"],
    65,
    "ORACLE_RESOURCE_LIMIT",
  );
  const fitOnlyHeavyResult = await runCli([
    "--case",
    oracleHeavyPath,
    "--oracle",
    "none",
    "--preflight",
  ]);
  assert.equal(fitOnlyHeavyResult.code, 0, fitOnlyHeavyResult.stderr);
  assert.equal(JSON.parse(fitOnlyHeavyResult.stdout).rOracleMemoryEstimate, null);
  const preflightResult = await runCli([
    "--case",
    exampleCasePath,
    "--oracle",
    "kernel",
    "--preflight",
  ]);
  assert.equal(
    preflightResult.code,
    0,
    `Example preflight failed.\nstdout:\n${preflightResult.stdout}\nstderr:\n${preflightResult.stderr}`,
  );
  const preflight = JSON.parse(preflightResult.stdout);
  assert.equal(preflight.status, "PREFLIGHT");
  assert.equal(preflight.caseId, example.caseId);
  assert.equal(preflight.dimensions.respondents, example.fitInput.responses.length);
  assert.equal(preflight.estimation.aggregateRows, false);
  assert.equal(preflight.estimation.posteriorStorage, "scores-only");
  assert.equal(preflight.rOracleMemoryEstimate.method, "conservative-full-R-scoring-v1");
  assert.ok(
    preflight.rOracleMemoryEstimate.estimatedBytes <= preflight.rOracleMemoryEstimate.limitBytes,
  );
  assertNoForbiddenKeys(preflight, "preflight");
  assertNoRespondentLengthArrays(preflight, preflight.dimensions.respondents, "preflight");

  const existingOutputPath = join(temporaryRoot, "existing-output");
  await mkdir(existingOutputPath, { mode: 0o750 });
  await chmod(existingOutputPath, 0o750);
  const sentinelPath = join(existingOutputPath, "sentinel.txt");
  await writeFile(sentinelPath, "preserve-me\n", { mode: 0o600 });
  await assertCliFailure(
    ["--case", exampleCasePath, "--out", existingOutputPath, "--oracle", "kernel"],
    65,
    "OUTPUT_EXISTS",
  );
  assert.equal(await readFile(sentinelPath, "utf8"), "preserve-me\n");
  if (process.platform !== "win32") {
    assert.equal((await stat(existingOutputPath)).mode & 0o777, 0o750);
  }

  const exampleOutputPath = join(temporaryRoot, "example-output");
  const compactStartResult = await runCli([
    "--case",
    exampleCasePath,
    "--out",
    exampleOutputPath,
    "--oracle",
    "kernel",
  ]);
  assert.equal(
    compactStartResult.code,
    0,
    `Mixed compact-start run failed.\nstdout:\n${compactStartResult.stdout}\nstderr:\n${compactStartResult.stderr}`,
  );
  assert.equal(compactStartResult.stderr, expectedProgress);
  const compactStartEvidence = await assertPrivateOutput(exampleOutputPath, example);
  assertDecisionExit(compactStartResult, compactStartEvidence.summary.status);
  assert.equal(compactStartEvidence.summary.modelCounts.DINA, 1);
  assert.equal(compactStartEvidence.summary.modelCounts.DINO, 1);

  const kernelCapCase = (caseId, initialItemProbabilities, convergenceTolerance) => ({
    schemaVersion: "jgdina-user-case/1",
    caseId,
    privacy: {
      directIdentifiersRemoved: true,
      respondentIdsExcluded: true,
      freeTextExcluded: true,
    },
    fitInput: {
      responses: [[0], [1], [0], [1]],
      qMatrix: [[1]],
      model: "GDINA",
      prior: { type: "saturated", initialProbabilities: [0.5, 0.5] },
      estimation: {
        maxIterations: 1,
        convergenceTolerance,
        aggregateRows: false,
        posteriorStorage: "scores-only",
        initialization: { starts: 1, initialItemProbabilities: [initialItemProbabilities] },
      },
    },
  });
  const capProbeCases = [
    {
      case: kernelCapCase("kernel-cap-fixed-point-smoke", [0.5, 0.5], 1e-8),
      statuses: ["REVIEW"],
      parity: true,
      probeIterations: 1,
    },
    {
      case: kernelCapCase("kernel-cap-fresh-start-smoke", [0.2, 0.8], 0.0001499),
      statuses: ["FAIL"],
      parity: false,
      probeIterations: 2,
    },
  ];
  for (const [index, capProbe] of capProbeCases.entries()) {
    const capProbePath = join(temporaryRoot, `kernel-cap-${index}.json`);
    const capProbeOutput = join(temporaryRoot, `kernel-cap-output-${index}`);
    await writeFile(capProbePath, `${JSON.stringify(capProbe.case)}\n`, { mode: 0o600 });
    await chmod(capProbePath, 0o600);
    const capProbeResult = await runCli([
      "--case",
      capProbePath,
      "--out",
      capProbeOutput,
      "--oracle",
      "kernel",
    ]);
    assert.equal(capProbeResult.stderr, expectedProgress);
    const capProbeEvidence = await assertPrivateOutput(
      capProbeOutput,
      capProbe.case,
      capProbe.statuses,
      capProbe.parity,
    );
    assertDecisionExit(capProbeResult, capProbeEvidence.summary.status);
    assert.equal(
      capProbeEvidence.summary.parity.r.convergenceProbeIterations,
      capProbe.probeIterations,
    );
  }

  const fitOnlyOutputPath = join(temporaryRoot, "fit-only-output");
  const fitOnlyResult = await runCli([
    "--case",
    exampleCasePath,
    "--out",
    fitOnlyOutputPath,
    "--oracle",
    "none",
  ]);
  assert.equal(fitOnlyResult.stderr, expectedFitOnlyProgress);
  const fitOnlyEvidence = await assertPrivateOutput(
    fitOnlyOutputPath,
    example,
    ["FIT_ONLY"],
    null,
  );
  assertDecisionExit(fitOnlyResult, fitOnlyEvidence.summary.status);
  assert.equal(fitOnlyEvidence.summary.rOracleMemoryEstimate, null);

  const fixedCase = buildPrivateCase(
    fixedFixture,
    "private-workflow-fixed-prior-base-r-smoke",
  );
  const fixedCasePath = join(temporaryRoot, "fixed-case.json");
  await writeFile(fixedCasePath, `${JSON.stringify(fixedCase)}\n`, { mode: 0o600 });
  await chmod(fixedCasePath, 0o600);
  const fixedOutputPath = join(temporaryRoot, "fixed-output");
  const fixedResult = await runCli([
    "--case",
    fixedCasePath,
    "--out",
    fixedOutputPath,
    "--oracle",
    "base-r",
  ]);
  assert.ok(
    [0, 3].includes(fixedResult.code),
    `Fixed-prior base-R run failed.\nstdout:\n${fixedResult.stdout}\nstderr:\n${fixedResult.stderr}`,
  );
  assert.equal(fixedResult.stderr, expectedProgress);
  const fixedEvidence = await assertPrivateOutput(fixedOutputPath, fixedCase, ["PASS", "REVIEW"]);
  assertDecisionExit(fixedResult, fixedEvidence.summary.status);
  assert.equal(fixedEvidence.summary.priorType, "fixed");
  assert.equal(fixedEvidence.summary.parity.differences.finalChange.passed, true);

  const cappedCase = structuredClone(fixedCase);
  cappedCase.caseId = "private-workflow-iteration-cap-smoke";
  cappedCase.fitInput.estimation.maxIterations = 1;
  const cappedCasePath = join(temporaryRoot, "capped-case.json");
  await writeFile(cappedCasePath, `${JSON.stringify(cappedCase)}\n`, { mode: 0o600 });
  await chmod(cappedCasePath, 0o600);
  const cappedOutputPath = join(temporaryRoot, "capped-output");
  const cappedResult = await runCli([
    "--case",
    cappedCasePath,
    "--out",
    cappedOutputPath,
    "--oracle",
    "base-r",
  ]);
  assert.equal(
    cappedResult.code,
    2,
    `Iteration-cap failure run returned the wrong decision.\nstdout:\n${cappedResult.stdout}\nstderr:\n${cappedResult.stderr}`,
  );
  assert.equal(cappedResult.stderr, expectedProgress);
  const cappedEvidence = await assertPrivateOutput(
    cappedOutputPath,
    cappedCase,
    ["FAIL"],
    false,
  );
  assertDecisionExit(cappedResult, cappedEvidence.summary.status);
  assert.equal(cappedEvidence.summary.jgdina.reason, "maximum-iterations");

  const singleItemCase = {
    schemaVersion: "jgdina-user-case/1",
    caseId: "private-workflow-single-item-shape-smoke",
    privacy: {
      directIdentifiersRemoved: true,
      respondentIdsExcluded: true,
      freeTextExcluded: true,
    },
    fitInput: {
      responses: Array.from({ length: 20 }, (_, index) => [index % 2]),
      qMatrix: [[1]],
      model: "GDINA",
      prior: { type: "fixed", probabilities: [0.5, 0.5] },
      estimation: {
        maxIterations: 5000,
        convergenceTolerance: 1e-8,
        aggregateRows: false,
        posteriorStorage: "scores-only",
        initialization: {
          starts: 1,
          initialItemProbabilities: [[0.5, 0.5]],
        },
      },
    },
  };
  const singleItemCasePath = join(temporaryRoot, "single-item-case.json");
  await writeFile(singleItemCasePath, `${JSON.stringify(singleItemCase)}\n`, { mode: 0o600 });
  await chmod(singleItemCasePath, 0o600);
  const singleItemOutputPath = join(temporaryRoot, "single-item-output");
  const singleItemResult = await runCli([
    "--case",
    singleItemCasePath,
    "--out",
    singleItemOutputPath,
    "--oracle",
    "base-r",
  ]);
  assert.ok(
    [0, 3].includes(singleItemResult.code),
    `Single-item JSON-shape run failed.\nstdout:\n${singleItemResult.stdout}\nstderr:\n${singleItemResult.stderr}`,
  );
  assert.equal(singleItemResult.stderr, expectedProgress);
  const singleItemEvidence = await assertPrivateOutput(
    singleItemOutputPath,
    singleItemCase,
    ["PASS", "REVIEW"],
  );
  assertDecisionExit(singleItemResult, singleItemEvidence.summary.status);
  assert.equal(singleItemEvidence.summary.dimensions.items, 1);
  assert.equal(singleItemEvidence.summary.dimensions.attributes, 1);

  const privateCase = buildPrivateCase(fixture);
  const casePath = join(temporaryRoot, "case.json");
  await writeFile(casePath, `${JSON.stringify(privateCase)}\n`, { mode: 0o600 });
  await chmod(casePath, 0o600);
  if (process.platform !== "win32") {
    assert.equal((await stat(casePath)).mode & 0o777, 0o600, "private input must be mode 0600");
  }

  const summaries = [];
  const provenances = [];
  for (const run of [1, 2]) {
    const outputPath = join(temporaryRoot, `output-${run}`);
    const result = await runCli([
      "--case",
      casePath,
      "--out",
      outputPath,
      "--oracle",
      "kernel",
    ]);
    assert.equal(
      result.code,
      0,
      `Frozen-kernel run ${run} failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /^PASS private-workflow-frozen-kernel-smoke:/u);
    assert.equal(result.stderr, expectedProgress);
    const { summary, provenance } = await assertPrivateOutput(outputPath, privateCase);
    assertDecisionExit(result, summary.status);
    summaries.push(summary);
    provenances.push(provenance);
  }

  assert.deepEqual(stableEvidence(summaries[1]), stableEvidence(summaries[0]));
  assert.deepEqual(provenances[1], provenances[0]);
  console.log(
    "Private user-data smoke passed: negative privacy/schema gates, compact mixed starts, fixed-prior base-R, frozen-kernel parity, aggregate-only output, and deterministic evidence.",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
