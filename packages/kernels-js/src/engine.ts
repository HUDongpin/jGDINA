import {
  throwIfAborted,
  type BinaryValue,
  type ConvergenceReason,
  type FitBackend,
  type FitOptions,
  type FitResult,
  type StartSummary,
  type ValidatedFitInput,
} from "@jgdina/core";
import { aggregateRowsInternal } from "./aggregate.js";
import { expectationStep } from "./expectation.js";
import { probabilitiesToDelta } from "./helpers.js";
import { initialState } from "./initialization.js";
import { compileModel, type AggregatedRows, type CompiledModel, type ParameterState } from "./internal.js";
import { maximizationStep } from "./maximization.js";

export const JS_BACKEND_ID = "js";

interface StartRun {
  readonly state: ParameterState;
  readonly summary: SelectedStartSummary;
}

interface SelectedStartSummary extends StartSummary {
  readonly reason: ConvergenceReason;
}

interface StartCandidateSummary {
  readonly initialLogLikelihood: number;
  readonly startIndex: number;
}

interface SelectedStartCandidate extends StartCandidateSummary {
  readonly state: ParameterState;
}

/** Fits already validated data with the pure TypeScript EM implementation. */
export function fitValidated(
  input: ValidatedFitInput,
  options?: FitOptions,
  backendId = JS_BACKEND_ID,
): FitResult {
  throwIfAborted(options);
  const model = compileModel(input);
  const rows = aggregateRowsInternal(input.responses, input.estimation.aggregateRows);
  const totalStarts = input.estimation.initialization.starts;
  const candidates: StartCandidateSummary[] = [];
  let selectedCandidate: SelectedStartCandidate | null = null;

  for (let startIndex = 0; startIndex < totalStarts; startIndex += 1) {
    throwIfAborted(options);
    options?.onProgress?.({
      fraction: 0.02 + (0.12 * startIndex) / totalStarts,
      phase: "initialization",
      startIndex,
      totalStarts,
    });
    const state = initialState(input, model, startIndex);
    const initialLogLikelihood = expectationStep(model, rows, state, {
      blockSize: input.estimation.blockSize,
      collectSufficientStatistics: false,
      ...(options === undefined ? {} : { execution: options }),
    }).logLikelihood;
    const candidate = { initialLogLikelihood, startIndex };
    candidates.push(candidate);
    if (
      selectedCandidate === null ||
      candidate.initialLogLikelihood > selectedCandidate.initialLogLikelihood
    ) {
      selectedCandidate = { ...candidate, state };
    }
  }
  if (selectedCandidate === null) throw new Error("at least one start is required");
  const selected = runStart(
    input,
    model,
    rows,
    selectedCandidate,
    totalStarts,
    options,
  );
  const starts: StartSummary[] = candidates.map((candidate) =>
    candidate.startIndex === selectedCandidate.startIndex
      ? selected.summary
      : {
          converged: false,
          finalChange: 0,
          initialLogLikelihood: candidate.initialLogLikelihood,
          iterations: 0,
          logLikelihood: candidate.initialLogLikelihood,
          reason: "not-selected",
          selectedForEstimation: false,
          startIndex: candidate.startIndex,
        },
  );

  options?.onProgress?.({ fraction: 0.95, phase: "scoring" });
  const scores = scoreRespondents(input, model, rows, selected.state, options);
  const estimatedParameterCount = countEstimatedParameters(input, model);
  const statistics = fitStatistics(
    selected.summary.logLikelihood,
    estimatedParameterCount,
    model.respondents,
  );

  const items = Array.from({ length: model.items }, (_, item) => {
    const offset = model.categoryOffsets[item] ?? 0;
    const end = model.categoryOffsets[item + 1] ?? offset;
    const reduced = Array.from(selected.state.itemProbabilities.subarray(offset, end));
    const itemModel = model.models[item] ?? "GDINA";
    const successProbabilities = Array.from({ length: model.classes }, (_, latentClass) => {
      const location = model.locations[item * model.classes + latentClass] ?? 0;
      return selected.state.itemProbabilities[offset + location] ?? 0;
    });
    return {
      deltaParameters: probabilitiesToDelta(reduced, itemModel),
      groupSuccessProbabilities: reduced,
      itemIndex: item,
      model: itemModel,
      requiredAttributes: Array.from(model.requiredAttributes[item] ?? []),
      successProbabilities,
    };
  });

  return {
    attributePatterns: model.patterns.map((row) => Array.from(row)),
    backendId,
    convergence: {
      converged: selected.summary.converged,
      finalChange: selected.summary.finalChange,
      iterations: selected.summary.iterations,
      reason: selected.summary.reason,
      selectedStartIndex: selected.summary.startIndex,
      starts,
    },
    diagnostics: {
      memoryEstimate: input.memoryEstimate,
      missingResponseCount: input.missingResponseCount,
      rowsAggregated: input.estimation.aggregateRows,
      uniqueResponsePatterns: rows.uniqueRowCount,
    },
    dimensions: input.dimensions,
    estimates: {
      classProbabilities: Array.from(selected.state.classProbabilities),
      items,
    },
    models: Array.from(input.models),
    priorType: input.prior.type,
    schemaVersion: "1.0",
    scores,
    statistics,
  };
}

export function createJsBackend(): FitBackend {
  return Object.freeze({
    fit: (input: ValidatedFitInput, options?: FitOptions) =>
      fitValidated(input, options, JS_BACKEND_ID),
    id: JS_BACKEND_ID,
  });
}

export const jsBackend: FitBackend = createJsBackend();

function runStart(
  input: ValidatedFitInput,
  model: CompiledModel,
  rows: AggregatedRows,
  candidate: SelectedStartCandidate,
  totalStarts: number,
  options?: FitOptions,
): StartRun {
  const { state, startIndex, initialLogLikelihood } = candidate;
  let iterations = 0;
  let finalChange = 0;
  let converged = false;

  while (iterations < input.estimation.maxIterations) {
    const expectation = expectationStep(model, rows, state, {
      blockSize: input.estimation.blockSize,
      collectSufficientStatistics: true,
      ...(options === undefined ? {} : { execution: options }),
    });
    finalChange = maximizationStep(input, model, state, expectation);
    iterations += 1;
    options?.onProgress?.({
      fraction: 0.15 + (0.75 * iterations) / input.estimation.maxIterations,
      iteration: iterations,
      logLikelihood: expectation.logLikelihood,
      maxIterations: input.estimation.maxIterations,
      phase: "estimation",
      startIndex,
      totalStarts,
    });
    if (finalChange < input.estimation.convergenceTolerance) {
      converged = true;
      break;
    }
  }
  const finalExpectation = expectationStep(model, rows, state, {
    blockSize: input.estimation.blockSize,
    collectSufficientStatistics: false,
    ...(options === undefined ? {} : { execution: options }),
  });
  const reason: ConvergenceReason = converged ? "tolerance" : "maximum-iterations";
  return {
    state,
    summary: {
      converged,
      finalChange,
      initialLogLikelihood,
      iterations,
      logLikelihood: finalExpectation.logLikelihood,
      reason,
      selectedForEstimation: true,
      startIndex,
    },
  };
}

function scoreRespondents(
  input: ValidatedFitInput,
  model: CompiledModel,
  rows: AggregatedRows,
  state: ParameterState,
  options?: FitOptions,
): FitResult["scores"] {
  const uniqueMap = new Int32Array(rows.uniqueRowCount);
  const uniqueMle = new Int32Array(rows.uniqueRowCount);
  const uniqueMapTies = Array<boolean>(rows.uniqueRowCount).fill(false);
  const uniqueMleTies = Array<boolean>(rows.uniqueRowCount).fill(false);
  const uniqueEap = new Float64Array(rows.uniqueRowCount * model.attributes);
  const retainPosterior = input.estimation.posteriorStorage === "full";
  const posteriorProbabilities: number[][] | null = retainPosterior
    ? Array.from({ length: model.respondents }, () => [])
    : null;
  const originalsByUnique: number[][] | null = retainPosterior
    ? Array.from({ length: rows.uniqueRowCount }, () => [])
    : null;
  if (originalsByUnique !== null) {
    for (let original = 0; original < model.respondents; original += 1) {
      originalsByUnique[rows.originalToUnique[original] ?? 0]?.push(original);
    }
  }

  expectationStep(model, rows, state, {
    blockSize: input.estimation.blockSize,
    collectSufficientStatistics: false,
    ...(options === undefined ? {} : { execution: options }),
    onRow: (row, logLikelihood, posterior) => {
      const map = argmaxWithTie(posterior);
      const mle = argmaxWithTie(logLikelihood);
      uniqueMap[row] = map.index;
      uniqueMle[row] = mle.index;
      uniqueMapTies[row] = map.hasTie;
      uniqueMleTies[row] = mle.hasTie;
      if (posteriorProbabilities !== null && originalsByUnique !== null) {
        const plainPosterior = Array.from(posterior);
        for (const original of originalsByUnique[row] ?? []) {
          posteriorProbabilities[original] = Array.from(plainPosterior);
        }
      }
      for (let latentClass = 0; latentClass < model.classes; latentClass += 1) {
        const mass = posterior[latentClass] ?? 0;
        for (let attribute = 0; attribute < model.attributes; attribute += 1) {
          if (model.flatPatterns[latentClass * model.attributes + attribute] === 1) {
            const index = row * model.attributes + attribute;
            uniqueEap[index] = (uniqueEap[index] ?? 0) + mass;
          }
        }
      }
    },
  });

  const mapClassIndices: number[] = [];
  const mleClassIndices: number[] = [];
  const mapHasTies: boolean[] = [];
  const mleHasTies: boolean[] = [];
  const eapAttributeProbabilities: number[][] = [];
  const eapAttributeClassifications: BinaryValue[][] = [];

  for (let row = 0; row < model.respondents; row += 1) {
    const unique = rows.originalToUnique[row] ?? 0;
    mapClassIndices.push(uniqueMap[unique] ?? 0);
    mleClassIndices.push(uniqueMle[unique] ?? 0);
    mapHasTies.push(uniqueMapTies[unique] ?? false);
    mleHasTies.push(uniqueMleTies[unique] ?? false);
    const probabilities: number[] = [];
    const classifications: BinaryValue[] = [];
    for (let attribute = 0; attribute < model.attributes; attribute += 1) {
      const raw = uniqueEap[unique * model.attributes + attribute] ?? 0;
      const probability = Math.max(0, Math.min(1, raw));
      probabilities.push(probability);
      classifications.push(probability > 0.5 ? 1 : 0);
    }
    eapAttributeProbabilities.push(probabilities);
    eapAttributeClassifications.push(classifications);
  }
  return {
    eapAttributeClassifications,
    eapAttributeProbabilities,
    mapClassIndices,
    mapHasTies,
    mleClassIndices,
    mleHasTies,
    posteriorProbabilities,
  };
}

function argmaxWithTie(values: Float64Array): { index: number; hasTie: boolean } {
  let index = 0;
  let maximum = values[0] ?? Number.NEGATIVE_INFINITY;
  let ties = 1;
  for (let candidate = 1; candidate < values.length; candidate += 1) {
    const value = values[candidate] ?? Number.NEGATIVE_INFINITY;
    if (value > maximum) {
      maximum = value;
      index = candidate;
      ties = 1;
    } else if (value === maximum) {
      ties += 1;
    }
  }
  return { hasTie: ties > 1, index };
}

function countEstimatedParameters(input: ValidatedFitInput, model: CompiledModel): number {
  let count = input.prior.type === "saturated" ? model.classes - 1 : 0;
  for (let item = 0; item < model.items; item += 1) {
    count +=
      model.models[item] === "GDINA"
        ? (model.reducedClassCounts[item] ?? 0)
        : 2;
  }
  return count;
}

function fitStatistics(
  logLikelihood: number,
  parameterCount: number,
  respondents: number,
): FitResult["statistics"] {
  const deviance = -2 * logLikelihood;
  const aic = deviance + 2 * parameterCount;
  return {
    aic,
    aicc:
      respondents > parameterCount + 1
        ? aic +
          (2 * parameterCount * (parameterCount + 1)) /
            (respondents - parameterCount - 1)
        : null,
    bic: deviance + parameterCount * Math.log(respondents),
    caic: deviance + parameterCount * (Math.log(respondents) + 1),
    deviance,
    estimatedParameterCount: parameterCount,
    logLikelihood,
    sabic: deviance + parameterCount * Math.log((respondents + 2) / 24),
  };
}
