import {
  InputValidationError,
  ResourceLimitError,
  type ValidationIssue,
} from "./errors.js";
import {
  DEFAULT_BLOCK_SIZE,
  DEFAULT_RESOURCE_LIMITS,
  assertFitDimensionsWithinResourceLimits,
  assertWithinResourceLimits,
  resolveResourceLimits,
} from "./limits.js";
import {
  ITEM_MODELS,
  type BinaryValue,
  type FitInput,
  type ItemModel,
  type ResolvedEstimationOptions,
  type ResourceLimits,
  type ResponseValue,
  type ValidatedAttributePrior,
  type ValidatedFitInput,
} from "./types.js";

export const DEFAULT_MAX_ITERATIONS = 2_000;
export const DEFAULT_CONVERGENCE_TOLERANCE = 1e-4;
export const DEFAULT_PROBABILITY_BOUNDS = [1e-4, 1 - 1e-4] as const;
export const DEFAULT_SMALL_SAMPLE_CORRECTION = [0.0005, 0.001] as const;
export const DEFAULT_STARTS = 3;
export const DEFAULT_SEED = 123_456;
export const PRIOR_SUM_TOLERANCE = 1e-8;

/**
 * Validates all v1 constraints, normalizes NaN responses to null, expands a
 * scalar model to J entries, defensively copies arrays, and runs memory guards.
 */
export function validateFitInput(input: FitInput): ValidatedFitInput {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) {
    throw new InputValidationError([
      { path: "input", code: "type", message: "must be an object" },
    ]);
  }

  // Reject plainly oversized shapes before normalization creates defensive
  // copies of every response and Q cell. Detailed type/shape issues are still
  // collected by the ordinary validators below.
  assertEarlyDimensions(input);

  const responsesResult = validateResponses(input["responses"], issues);
  const qResult = validateQMatrix(input["qMatrix"], issues);

  if (
    responsesResult !== null &&
    qResult !== null &&
    responsesResult.items !== qResult.items
  ) {
    issues.push({
      path: "qMatrix",
      code: "length",
      message: `must contain one row per response item (${responsesResult.items})`,
    });
  }

  const itemCount = responsesResult?.items ?? qResult?.items ?? null;
  const models = validateModels(input["model"], itemCount, issues);
  const attributes = qResult?.attributes ?? null;
  const latentClasses = attributes === null ? null : 2 ** attributes;
  const prior = validatePrior(input["prior"], latentClasses, issues);
  const estimation = validateEstimation(
    input["estimation"],
    qResult?.matrix ?? null,
    models,
    issues,
  );

  if (
    issues.length > 0 ||
    responsesResult === null ||
    qResult === null ||
    models === null ||
    prior === null ||
    estimation === null
  ) {
    throw new InputValidationError(issues);
  }

  const { respondents, items } = responsesResult;
  const dimensions = {
    respondents,
    items,
    attributes: qResult.attributes,
    latentClasses: 2 ** qResult.attributes,
  };

  if (estimation.initialization.starts > estimation.resourceLimits.maxStarts) {
    throw new ResourceLimitError(
      "starts",
      estimation.initialization.starts,
      estimation.resourceLimits.maxStarts,
    );
  }
  if (estimation.maxIterations > estimation.resourceLimits.maxIterations) {
    throw new ResourceLimitError(
      "iterations",
      estimation.maxIterations,
      estimation.resourceLimits.maxIterations,
    );
  }

  const memoryEstimate = assertWithinResourceLimits(
    {
      respondents,
      items,
      attributes: qResult.attributes,
      blockSize: estimation.blockSize,
      posteriorStorage: estimation.posteriorStorage,
      reducedClassCounts: qResult.matrix.map(
        (row) => 2 ** row.reduce<number>((sum, value) => sum + value, 0),
      ),
      starts: estimation.initialization.starts,
      suppliedCandidateCount:
        estimation.initialization.initialItemProbabilityCandidates?.length ??
        (estimation.initialization.initialItemProbabilities === null ? 0 : 1),
    },
    estimation.resourceLimits,
  );

  return {
    responses: responsesResult.matrix,
    qMatrix: qResult.matrix,
    models,
    prior,
    estimation,
    dimensions,
    missingResponseCount: responsesResult.missingResponseCount,
    memoryEstimate,
  };
}

function assertEarlyDimensions(input: Record<string, unknown>): void {
  const responses = input["responses"];
  const qMatrix = input["qMatrix"];
  const responseRows = Array.isArray(responses) ? responses.length : 0;
  const responseItems =
    Array.isArray(responses) && Array.isArray(responses[0]) ? responses[0].length : 0;
  const qItems = Array.isArray(qMatrix) ? qMatrix.length : 0;
  const attributes =
    Array.isArray(qMatrix) && Array.isArray(qMatrix[0]) ? qMatrix[0].length : 0;
  if (responseRows === 0 && responseItems === 0 && qItems === 0 && attributes === 0) return;

  let limits = DEFAULT_RESOURCE_LIMITS;
  const estimation = input["estimation"];
  if (isRecord(estimation) && isRecord(estimation["resourceLimits"])) {
    try {
      limits = resolveResourceLimits(estimation["resourceLimits"]);
    } catch {
      // Detailed validation below reports malformed overrides. Defaults remain
      // safe for the early copy-avoidance guard.
    }
  }
  assertFitDimensionsWithinResourceLimits(
    {
      respondents: Math.max(1, responseRows),
      items: Math.max(1, responseItems, qItems),
      attributes: Math.max(1, attributes),
    },
    limits,
  );
}

interface ResponseValidationResult {
  readonly matrix: ResponseValue[][];
  readonly respondents: number;
  readonly items: number;
  readonly missingResponseCount: number;
}

function validateResponses(
  value: unknown,
  issues: ValidationIssue[],
): ResponseValidationResult | null {
  if (!Array.isArray(value)) {
    issues.push({ path: "responses", code: "type", message: "must be an array of rows" });
    return null;
  }
  if (value.length === 0) {
    issues.push({ path: "responses", code: "empty", message: "must contain at least one row" });
    return null;
  }
  if (!Array.isArray(value[0]) || value[0].length === 0) {
    issues.push({
      path: "responses[0]",
      code: Array.isArray(value[0]) ? "empty" : "type",
      message: "must be a non-empty array",
    });
    return null;
  }

  const items = value[0].length;
  const matrix: ResponseValue[][] = [];
  let missingResponseCount = 0;
  let rectangular = true;

  for (let rowIndex = 0; rowIndex < value.length; rowIndex += 1) {
    const row = value[rowIndex];
    if (!Array.isArray(row)) {
      issues.push({
        path: `responses[${rowIndex}]`,
        code: "type",
        message: "must be an array",
      });
      rectangular = false;
      continue;
    }
    if (row.length !== items) {
      issues.push({
        path: `responses[${rowIndex}]`,
        code: "rectangular",
        message: `must contain exactly ${items} values`,
      });
      rectangular = false;
      continue;
    }

    const normalizedRow: ResponseValue[] = [];
    for (let itemIndex = 0; itemIndex < items; itemIndex += 1) {
      const cell = row[itemIndex];
      if (cell === 0 || cell === 1) {
        normalizedRow.push(cell);
      } else if (cell === null || (typeof cell === "number" && Number.isNaN(cell))) {
        normalizedRow.push(null);
        missingResponseCount += 1;
      } else {
        issues.push({
          path: `responses[${rowIndex}][${itemIndex}]`,
          code: "range",
          message: "must be 0, 1, null, or NaN",
        });
        // Preserve shape to discover independent validation errors.
        normalizedRow.push(null);
      }
    }
    matrix.push(normalizedRow);
  }

  if (!rectangular || matrix.length !== value.length) return null;

  for (let itemIndex = 0; itemIndex < items; itemIndex += 1) {
    let hasZero = false;
    let hasOne = false;
    for (const row of matrix) {
      hasZero ||= row[itemIndex] === 0;
      hasOne ||= row[itemIndex] === 1;
    }
    if (!hasZero || !hasOne) {
      issues.push({
        path: `responses[*][${itemIndex}]`,
        code: "degenerate",
        message: "must contain both observed response categories 0 and 1",
      });
    }
  }

  return {
    matrix,
    respondents: value.length,
    items,
    missingResponseCount,
  };
}

interface QValidationResult {
  readonly matrix: BinaryValue[][];
  readonly items: number;
  readonly attributes: number;
}

function validateQMatrix(
  value: unknown,
  issues: ValidationIssue[],
): QValidationResult | null {
  if (!Array.isArray(value)) {
    issues.push({ path: "qMatrix", code: "type", message: "must be an array of rows" });
    return null;
  }
  if (value.length === 0) {
    issues.push({ path: "qMatrix", code: "empty", message: "must contain at least one row" });
    return null;
  }
  if (!Array.isArray(value[0]) || value[0].length === 0) {
    issues.push({
      path: "qMatrix[0]",
      code: Array.isArray(value[0]) ? "empty" : "type",
      message: "must be a non-empty array",
    });
    return null;
  }

  const attributes = value[0].length;
  const matrix: BinaryValue[][] = [];
  let rectangular = true;

  for (let itemIndex = 0; itemIndex < value.length; itemIndex += 1) {
    const row = value[itemIndex];
    if (!Array.isArray(row)) {
      issues.push({ path: `qMatrix[${itemIndex}]`, code: "type", message: "must be an array" });
      rectangular = false;
      continue;
    }
    if (row.length !== attributes) {
      issues.push({
        path: `qMatrix[${itemIndex}]`,
        code: "rectangular",
        message: `must contain exactly ${attributes} values`,
      });
      rectangular = false;
      continue;
    }

    const normalizedRow: BinaryValue[] = [];
    let required = 0;
    for (let attributeIndex = 0; attributeIndex < attributes; attributeIndex += 1) {
      const cell = row[attributeIndex];
      if (cell === 0 || cell === 1) {
        normalizedRow.push(cell);
        required += cell;
      } else {
        issues.push({
          path: `qMatrix[${itemIndex}][${attributeIndex}]`,
          code: "range",
          message: "must be 0 or 1",
        });
        normalizedRow.push(0);
      }
    }
    if (required === 0) {
      issues.push({
        path: `qMatrix[${itemIndex}]`,
        code: "degenerate",
        message: "each item must require at least one attribute",
      });
    }
    matrix.push(normalizedRow);
  }

  if (!rectangular || matrix.length !== value.length) return null;

  for (let attributeIndex = 0; attributeIndex < attributes; attributeIndex += 1) {
    if (!matrix.some((row) => row[attributeIndex] === 1)) {
      issues.push({
        path: `qMatrix[*][${attributeIndex}]`,
        code: "degenerate",
        message: "each attribute must be required by at least one item",
      });
    }
  }

  return { matrix, items: value.length, attributes };
}

function validateModels(
  value: unknown,
  itemCount: number | null,
  issues: ValidationIssue[],
): ItemModel[] | null {
  if (itemCount === null) return null;
  if (value === undefined) return Array<ItemModel>(itemCount).fill("GDINA");

  const rawModels = Array.isArray(value) ? value : [value];
  if (Array.isArray(value) && value.length !== itemCount) {
    issues.push({
      path: "model",
      code: "length",
      message: `must be a scalar or contain exactly ${itemCount} entries`,
    });
  }

  const normalized = rawModels.map((entry, index): ItemModel | null => {
    const candidate = typeof entry === "string" ? entry.toUpperCase() : "";
    if ((ITEM_MODELS as readonly string[]).includes(candidate)) return candidate as ItemModel;
    issues.push({
      path: Array.isArray(value) ? `model[${index}]` : "model",
      code: "unsupported",
      message: 'must be "GDINA", "DINA", or "DINO"',
    });
    return null;
  });
  if (normalized.some((entry) => entry === null) || (Array.isArray(value) && value.length !== itemCount)) {
    return null;
  }
  return Array.isArray(value)
    ? (normalized as ItemModel[])
    : Array<ItemModel>(itemCount).fill(normalized[0] as ItemModel);
}

function validatePrior(
  value: unknown,
  latentClasses: number | null,
  issues: ValidationIssue[],
): ValidatedAttributePrior | null {
  if (latentClasses === null) return null;
  if (value === undefined) return { type: "saturated", initialProbabilities: null };
  if (!isRecord(value)) {
    issues.push({ path: "prior", code: "type", message: "must be an object" });
    return null;
  }

  if (value["type"] === "fixed") {
    const probabilities = validateProbabilityVector(
      value["probabilities"],
      "prior.probabilities",
      latentClasses,
      issues,
    );
    return probabilities === null ? null : { type: "fixed", probabilities };
  }
  if (value["type"] === "saturated") {
    if (value["initialProbabilities"] === undefined) {
      return { type: "saturated", initialProbabilities: null };
    }
    const initialProbabilities = validateProbabilityVector(
      value["initialProbabilities"],
      "prior.initialProbabilities",
      latentClasses,
      issues,
    );
    return initialProbabilities === null
      ? null
      : { type: "saturated", initialProbabilities };
  }

  issues.push({
    path: "prior.type",
    code: "unsupported",
    message: 'must be "saturated" or "fixed"',
  });
  return null;
}

function validateProbabilityVector(
  value: unknown,
  path: string,
  expectedLength: number,
  issues: ValidationIssue[],
): number[] | null {
  if (!Array.isArray(value)) {
    issues.push({ path, code: "type", message: "must be an array" });
    return null;
  }
  if (value.length !== expectedLength) {
    issues.push({
      path,
      code: "length",
      message: `must contain exactly ${expectedLength} class probabilities`,
    });
  }
  let valid = value.length === expectedLength;
  const probabilities = value.map((entry, index) => {
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0 || entry > 1) {
      issues.push({
        path: `${path}[${index}]`,
        code: "range",
        message: "must be a finite number in [0, 1]",
      });
      valid = false;
      return 0;
    }
    return entry;
  });
  const sum = probabilities.reduce((total, probability) => total + probability, 0);
  if (!Number.isFinite(sum) || Math.abs(sum - 1) > PRIOR_SUM_TOLERANCE) {
    issues.push({
      path,
      code: "range",
      message: `must sum to 1 within tolerance ${PRIOR_SUM_TOLERANCE}`,
    });
    valid = false;
  }
  if (!valid) return null;
  // Remove harmless floating-point drift while preserving exact zero classes.
  return probabilities.map((probability) => probability / sum);
}

function validateEstimation(
  value: unknown,
  qMatrix: readonly (readonly BinaryValue[])[] | null,
  models: readonly ItemModel[] | null,
  issues: ValidationIssue[],
): ResolvedEstimationOptions | null {
  if (value !== undefined && !isRecord(value)) {
    issues.push({ path: "estimation", code: "type", message: "must be an object" });
    return null;
  }
  const options = value === undefined ? {} : value;

  let resourceLimits: ResourceLimits = DEFAULT_RESOURCE_LIMITS;
  try {
    const rawLimits = options["resourceLimits"];
    if (rawLimits !== undefined && !isRecord(rawLimits)) {
      issues.push({
        path: "estimation.resourceLimits",
        code: "type",
        message: "must be an object",
      });
    } else {
      resourceLimits = resolveResourceLimits(rawLimits ?? {});
    }
  } catch (error) {
    if (error instanceof InputValidationError) issues.push(...error.issues);
    else throw error;
  }

  const maxIterations = readPositiveInteger(
    options["maxIterations"],
    DEFAULT_MAX_ITERATIONS,
    "estimation.maxIterations",
    issues,
  );
  const convergenceTolerance = readPositiveFinite(
    options["convergenceTolerance"],
    DEFAULT_CONVERGENCE_TOLERANCE,
    "estimation.convergenceTolerance",
    issues,
  );
  const probabilityBounds = validateProbabilityBounds(options["probabilityBounds"], issues);
  const smallSampleCorrection = validateSmallSampleCorrection(
    options["smallSampleCorrection"],
    issues,
  );
  const aggregateRows = readBoolean(
    options["aggregateRows"],
    true,
    "estimation.aggregateRows",
    issues,
  );
  const posteriorStorage =
    options["posteriorStorage"] === undefined ? "full" : options["posteriorStorage"];
  if (posteriorStorage !== "full" && posteriorStorage !== "scores-only") {
    issues.push({
      path: "estimation.posteriorStorage",
      code: "unsupported",
      message: 'must be "full" or "scores-only"',
    });
  }
  const blockSize = readPositiveInteger(
    options["blockSize"],
    DEFAULT_BLOCK_SIZE,
    "estimation.blockSize",
    issues,
  );
  const initialization = validateInitialization(
    options["initialization"],
    qMatrix,
    models,
    probabilityBounds,
    issues,
  );

  if (
    maxIterations === null ||
    convergenceTolerance === null ||
    probabilityBounds === null ||
    smallSampleCorrection === null ||
    aggregateRows === null ||
    (posteriorStorage !== "full" && posteriorStorage !== "scores-only") ||
    blockSize === null ||
    initialization === null
  ) {
    return null;
  }

  return {
    maxIterations,
    convergenceTolerance,
    probabilityBounds,
    smallSampleCorrection,
    initialization,
    aggregateRows,
    posteriorStorage,
    blockSize,
    resourceLimits,
  };
}

function validateInitialization(
  value: unknown,
  qMatrix: readonly (readonly BinaryValue[])[] | null,
  models: readonly ItemModel[] | null,
  probabilityBounds: readonly [number, number] | null,
  issues: ValidationIssue[],
): ResolvedEstimationOptions["initialization"] | null {
  if (value !== undefined && !isRecord(value)) {
    issues.push({
      path: "estimation.initialization",
      code: "type",
      message: "must be an object",
    });
    return null;
  }
  const initialization = value === undefined ? {} : value;
  if (
    initialization["strategy"] !== undefined &&
    initialization["strategy"] !== "deterministic"
  ) {
    issues.push({
      path: "estimation.initialization.strategy",
      code: "unsupported",
      message: 'v1 supports only "deterministic"',
    });
  }
  const seed = readUint32(
    initialization["seed"],
    DEFAULT_SEED,
    "estimation.initialization.seed",
    issues,
  );
  const rawCandidates = initialization["initialItemProbabilityCandidates"];
  const initialItemProbabilityCandidates = validateInitialItemProbabilityCandidates(
    rawCandidates,
    qMatrix,
    models,
    probabilityBounds,
    issues,
  );
  // Explicit candidates take precedence over the backward-compatible start-0 field.
  const initialItemProbabilities =
    rawCandidates === undefined
      ? validateInitialItemProbabilities(
          initialization["initialItemProbabilities"],
          qMatrix,
          models,
          probabilityBounds,
          issues,
        )
      : null;
  const starts = readPositiveInteger(
    initialization["starts"],
    initialItemProbabilityCandidates?.length ?? DEFAULT_STARTS,
    "estimation.initialization.starts",
    issues,
  );
  if (
    starts !== null &&
    initialItemProbabilityCandidates !== null &&
    initialItemProbabilityCandidates !== undefined &&
    starts < initialItemProbabilityCandidates.length
  ) {
    issues.push({
      path: "estimation.initialization.starts",
      code: "range",
      message: `must be at least the explicit candidate count (${initialItemProbabilityCandidates.length})`,
    });
  }
  if (
    starts === null ||
    seed === null ||
    initialItemProbabilities === undefined ||
    initialItemProbabilityCandidates === undefined ||
    (initialItemProbabilityCandidates !== null &&
      starts < initialItemProbabilityCandidates.length)
  ) {
    return null;
  }
  return {
    strategy: "deterministic",
    starts,
    seed,
    initialItemProbabilities,
    initialItemProbabilityCandidates,
  };
}

/** undefined means invalid/unavailable; null means valid and not supplied. */
function validateInitialItemProbabilityCandidates(
  value: unknown,
  qMatrix: readonly (readonly BinaryValue[])[] | null,
  models: readonly ItemModel[] | null,
  probabilityBounds: readonly [number, number] | null,
  issues: ValidationIssue[],
): number[][][] | null | undefined {
  const path = "estimation.initialization.initialItemProbabilityCandidates";
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    issues.push({ path, code: "type", message: "must be an array of item-probability candidates" });
    return undefined;
  }
  if (value.length === 0) {
    issues.push({ path, code: "empty", message: "must contain at least one candidate" });
    return undefined;
  }
  if (qMatrix === null || models === null || probabilityBounds === null) return undefined;

  const candidates: number[][][] = [];
  let valid = true;
  for (let candidateIndex = 0; candidateIndex < value.length; candidateIndex += 1) {
    const candidate = validateInitialItemProbabilities(
      value[candidateIndex],
      qMatrix,
      models,
      probabilityBounds,
      issues,
      `${path}[${candidateIndex}]`,
    );
    if (candidate === undefined || candidate === null) valid = false;
    else candidates.push(candidate);
  }
  return valid ? candidates : undefined;
}

/** undefined means invalid/unavailable; null means valid and not supplied. */
function validateInitialItemProbabilities(
  value: unknown,
  qMatrix: readonly (readonly BinaryValue[])[] | null,
  models: readonly ItemModel[] | null,
  probabilityBounds: readonly [number, number] | null,
  issues: ValidationIssue[],
  path = "estimation.initialization.initialItemProbabilities",
): number[][] | null | undefined {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    issues.push({
      path,
      code: "type",
      message: "must be an array with one probability array per item",
    });
    return undefined;
  }
  if (qMatrix === null || models === null || probabilityBounds === null) return undefined;
  if (value.length !== qMatrix.length) {
    issues.push({
      path,
      code: "length",
      message: `must contain exactly ${qMatrix.length} item arrays`,
    });
  }

  let valid = value.length === qMatrix.length;
  const result: number[][] = [];
  for (let itemIndex = 0; itemIndex < value.length; itemIndex += 1) {
    const item = value[itemIndex];
    const qRow = qMatrix[itemIndex];
    const model = models[itemIndex];
    if (!Array.isArray(item)) {
      issues.push({
        path: `${path}[${itemIndex}]`,
        code: "type",
        message: "must be an array",
      });
      valid = false;
      continue;
    }
    if (qRow === undefined || model === undefined) {
      valid = false;
      continue;
    }
    const requiredAttributes = qRow.reduce<number>((sum, entry) => sum + entry, 0);
    const fullLength = 2 ** requiredAttributes;
    const validLengths = model === "GDINA" ? [fullLength] : [2, fullLength];
    if (!validLengths.includes(item.length)) {
      issues.push({
        path: `${path}[${itemIndex}]`,
        code: "length",
        message:
          model === "GDINA"
            ? `${model} with ${requiredAttributes} required attributes needs ${fullLength} probabilities`
            : `${model} with ${requiredAttributes} required attributes needs 2 compact or ${fullLength} tied full probabilities`,
      });
      valid = false;
    }
    const normalizedItem: number[] = [];
    for (let groupIndex = 0; groupIndex < item.length; groupIndex += 1) {
      const probability = item[groupIndex];
      if (
        typeof probability !== "number" ||
        !Number.isFinite(probability) ||
        probability < probabilityBounds[0] ||
        probability > probabilityBounds[1]
      ) {
        issues.push({
          path: `${path}[${itemIndex}][${groupIndex}]`,
          code: "range",
          message: `must be a finite number in [${probabilityBounds[0]}, ${probabilityBounds[1]}]`,
        });
        valid = false;
        normalizedItem.push(0);
      } else {
        normalizedItem.push(probability);
      }
    }
    if (model !== "GDINA" && item.length === fullLength) {
      const start = model === "DINA" ? 0 : 1;
      const end = model === "DINA" ? fullLength - 1 : fullLength;
      const reference = normalizedItem[start];
      for (let groupIndex = start + 1; groupIndex < end; groupIndex += 1) {
        if (normalizedItem[groupIndex] !== reference) {
          issues.push({
            path: `${path}[${itemIndex}]`,
            code: "degenerate",
            message:
              model === "DINA"
                ? "full DINA non-master probabilities must be tied"
                : "full DINO any-mastered probabilities must be tied",
          });
          valid = false;
          break;
        }
      }
    }
    result.push(normalizedItem);
  }
  return valid ? result : undefined;
}

function validateProbabilityBounds(
  value: unknown,
  issues: ValidationIssue[],
): readonly [number, number] | null {
  if (value === undefined) return [...DEFAULT_PROBABILITY_BOUNDS];
  if (!Array.isArray(value) || value.length !== 2) {
    issues.push({
      path: "estimation.probabilityBounds",
      code: "length",
      message: "must be a two-number tuple [lower, upper]",
    });
    return null;
  }
  const [lower, upper] = value;
  if (
    typeof lower !== "number" ||
    typeof upper !== "number" ||
    !Number.isFinite(lower) ||
    !Number.isFinite(upper) ||
    lower <= 0 ||
    upper >= 1 ||
    lower >= upper
  ) {
    issues.push({
      path: "estimation.probabilityBounds",
      code: "range",
      message: "must satisfy 0 < lower < upper < 1",
    });
    return null;
  }
  return [lower, upper];
}

function validateSmallSampleCorrection(
  value: unknown,
  issues: ValidationIssue[],
): readonly [number, number] | null {
  if (value === undefined) return [...DEFAULT_SMALL_SAMPLE_CORRECTION];
  if (!Array.isArray(value) || value.length !== 2) {
    issues.push({
      path: "estimation.smallSampleCorrection",
      code: "length",
      message: "must be a two-number tuple [numerator, denominator]",
    });
    return null;
  }
  const [numerator, denominator] = value;
  if (
    typeof numerator !== "number" ||
    typeof denominator !== "number" ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator < 0 ||
    denominator <= 0
  ) {
    issues.push({
      path: "estimation.smallSampleCorrection",
      code: "range",
      message: "requires a finite numerator >= 0 and denominator > 0",
    });
    return null;
  }
  return [numerator, denominator];
}

function readPositiveInteger(
  value: unknown,
  fallback: number,
  path: string,
  issues: ValidationIssue[],
): number | null {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate <= 0) {
    issues.push({ path, code: "integer", message: "must be a positive safe integer" });
    return null;
  }
  return candidate;
}

function readUint32(
  value: unknown,
  fallback: number,
  path: string,
  issues: ValidationIssue[],
): number | null {
  const candidate = value === undefined ? fallback : value;
  if (
    typeof candidate !== "number" ||
    !Number.isInteger(candidate) ||
    candidate < 0 ||
    candidate > 0xffff_ffff
  ) {
    issues.push({ path, code: "range", message: "must be an unsigned 32-bit integer" });
    return null;
  }
  return candidate;
}

function readPositiveFinite(
  value: unknown,
  fallback: number,
  path: string,
  issues: ValidationIssue[],
): number | null {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) {
    issues.push({ path, code: "range", message: "must be a positive finite number" });
    return null;
  }
  return candidate;
}

function readBoolean(
  value: unknown,
  fallback: boolean,
  path: string,
  issues: ValidationIssue[],
): boolean | null {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "boolean") {
    issues.push({ path, code: "type", message: "must be boolean" });
    return null;
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
