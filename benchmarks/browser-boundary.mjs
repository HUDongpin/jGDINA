import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";

import {
  assertValidBackendResult,
  fit,
  validateFitInput,
} from "../packages/jgdina/dist/index.js";
import {
  packFitResult,
  packValidatedInput,
  unpackFitResult,
} from "../packages/worker-protocol/dist/index.js";

const localData = JSON.parse(
  await readFile(new URL("./data/local-cases.json", import.meta.url), "utf8"),
);
const cases = new Map(localData.cases.map((testCase) => [testCase.id, testCase]));
const options = parseArguments(process.argv.slice(2));
const testCase = cases.get(options.caseId);
if (testCase === undefined) {
  throw new Error(
    `Unknown local case '${options.caseId}'. Choose: ${[...cases.keys()].join(", ")}`,
  );
}

const input = {
  responses: testCase.responses,
  qMatrix: testCase.q_matrix,
  model: testCase.model,
  estimation: {
    maxIterations: 2_000,
    convergenceTolerance: 1e-5,
    posteriorStorage: options.posteriorStorage,
    initialization: { starts: 1, seed: 123_456 },
  },
};

for (let index = 0; index < options.warmups; index += 1) {
  const validated = validateFitInput(input);
  packValidatedInput(validated);
}

const inputSamples = [];
let validated;
for (let index = 0; index < options.runs; index += 1) {
  const validationStarted = performance.now();
  validated = validateFitInput(input);
  const validationMilliseconds = performance.now() - validationStarted;
  const packingStarted = performance.now();
  const packed = packValidatedInput(validated);
  const packingMilliseconds = performance.now() - packingStarted;
  inputSamples.push({
    validationMilliseconds,
    packingMilliseconds,
    packedInputBytes: packed.responses.byteLength + packed.qMatrix.byteLength,
  });
}

const fitStarted = performance.now();
const result = await fit(input);
const directFitMilliseconds = performance.now() - fitStarted;
const payload = packFitResult(result);

const resultSamples = [];
for (let index = 0; index < options.runs; index += 1) {
  const decodingStarted = performance.now();
  const decoded = unpackFitResult(payload);
  const decodingMilliseconds = performance.now() - decodingStarted;
  const validationStarted = performance.now();
  assertValidBackendResult(decoded, validated, result.backendId);
  const resultValidationMilliseconds = performance.now() - validationStarted;
  resultSamples.push({ decodingMilliseconds, resultValidationMilliseconds });
}

process.stdout.write(
  `${JSON.stringify({
    caseId: options.caseId,
    dimensions: validated.dimensions,
    posteriorStorage: options.posteriorStorage,
    execution:
      "Node.js proxy for synchronous browser main-thread boundary work; measure again on every supported device class.",
    warmups: options.warmups,
    runs: options.runs,
    directFitMilliseconds,
    fitConverged: result.convergence.converged,
    fitIterations: result.convergence.iterations,
    resultPayloadBytes: payload.byteLength,
    medianValidationMilliseconds: median(
      inputSamples.map((sample) => sample.validationMilliseconds),
    ),
    medianPackingMilliseconds: median(
      inputSamples.map((sample) => sample.packingMilliseconds),
    ),
    medianResultDecodingMilliseconds: median(
      resultSamples.map((sample) => sample.decodingMilliseconds),
    ),
    medianResultValidationMilliseconds: median(
      resultSamples.map((sample) => sample.resultValidationMilliseconds),
    ),
    inputSamples,
    resultSamples,
  }, null, 2)}\n`,
);

function parseArguments(arguments_) {
  const read = (name, fallback) => {
    const index = arguments_.indexOf(name);
    return index < 0 ? fallback : arguments_[index + 1];
  };
  const caseId = read("--case", "local-real-ecpe");
  const posteriorStorage = read("--posterior", "scores-only");
  const warmups = Number(read("--warmups", "1"));
  const runs = Number(read("--runs", "5"));
  if (posteriorStorage !== "full" && posteriorStorage !== "scores-only") {
    throw new Error('--posterior must be "full" or "scores-only"');
  }
  if (!Number.isSafeInteger(warmups) || warmups < 0) {
    throw new Error("--warmups must be a non-negative integer");
  }
  if (!Number.isSafeInteger(runs) || runs < 1) {
    throw new Error("--runs must be a positive integer");
  }
  return { caseId, posteriorStorage, runs, warmups };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle];
}
