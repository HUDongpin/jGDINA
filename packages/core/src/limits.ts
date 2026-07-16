import {
  InputValidationError,
  ResourceLimitError,
  type ValidationIssue,
} from "./errors.js";
import type {
  FitMemoryEstimate,
  PosteriorStorage,
  ResourceLimitOverrides,
  ResourceLimits,
} from "./types.js";

export const MEBIBYTE = 1024 ** 2;
/** JavaScript object/allocator behavior varies by engine; reserve at least 2x by default. */
export const DEFAULT_MEMORY_SAFETY_FACTOR = 2;
export const DEFAULT_BLOCK_SIZE = 256;

const DEFAULT_MEMORY_STARTS = 3;
const FLOAT_BYTES = 8;
const BINARY_BYTES = 1;
const INDEX_BYTES = 4;
const JS_SLOT_BYTES = 8;
const ARRAY_HEADER_BYTES = 32;
const STRING_CHARACTER_BYTES = 2;
const MAP_ENTRY_BYTES = 48;
const JSON_NUMBER_BYTES = 26;
const JSON_SCALAR_BYTES = 6;
const STATIC_OBJECT_BYTES = 4_096;

/** Conservative defaults suitable for both Node and modern desktop browsers. */
export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = Object.freeze({
  maxRespondents: 100_000,
  maxItems: 10_000,
  maxAttributes: 20,
  maxLatentClasses: 2 ** 20,
  maxEstimatedBytes: 512 * MEBIBYTE,
  maxStarts: 32,
  maxIterations: 100_000,
});

export interface FitMemoryRequest {
  readonly respondents: number;
  readonly items: number;
  readonly attributes: number;
  /**
   * Optional 2^Kj counts derived from Q. If omitted, every item is conservatively
   * treated as requiring all K attributes.
   */
  readonly reducedClassCounts?: readonly number[];
  /** Number of initialization candidates evaluated. Defaults to 3. */
  readonly starts?: number;
  /** Number of supplied candidate matrices retained in validated input. */
  readonly suppliedCandidateCount?: number;
  /** Include the browser/Node worker pack, unpack, and JSON result envelope. Default true. */
  readonly workerTransport?: boolean;
  readonly blockSize?: number;
  readonly posteriorStorage?: PosteriorStorage;
  /** Must be at least 1. The default reserves 100% for runtime/object overhead. */
  readonly safetyFactor?: number;
}

export function resolveResourceLimits(
  overrides: ResourceLimitOverrides = {},
): ResourceLimits {
  const resolved: ResourceLimits = {
    ...DEFAULT_RESOURCE_LIMITS,
    ...overrides,
  };

  const issues: ValidationIssue[] = [];
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      issues.push({
        path: `estimation.resourceLimits.${key}`,
        code: Number.isInteger(value) ? "range" : "integer",
        message: "must be a positive safe integer",
      });
    }
  }

  if (issues.length > 0) throw new InputValidationError(issues);
  return Object.freeze(resolved);
}

/**
 * Conservatively estimates the current v1 implementation's allocation envelope.
 * It includes worker transport and result serialization by default. JavaScript
 * object sizes are modeled explicitly and then covered by an additional safety
 * factor because allocator behavior is not portable across runtimes.
 */
export function estimateFitMemory(request: FitMemoryRequest): FitMemoryEstimate {
  const issues = validateMemoryRequest(request);
  if (issues.length > 0) throw new InputValidationError(issues);

  const respondents = request.respondents;
  const items = request.items;
  const attributes = request.attributes;
  const latentClasses = 2 ** attributes;
  const blockSize = Math.min(request.blockSize ?? DEFAULT_BLOCK_SIZE, respondents);
  const storesFullPosterior = (request.posteriorStorage ?? "full") === "full";
  const safetyFactor = request.safetyFactor ?? DEFAULT_MEMORY_SAFETY_FACTOR;
  const starts = request.starts ?? DEFAULT_MEMORY_STARTS;
  const suppliedCandidateCount = request.suppliedCandidateCount ?? 0;
  const workerTransport = request.workerTransport ?? true;
  const reduced = reducedClassSummary(request, latentClasses);
  const uniqueRows = respondents; // Preflight runs before aggregation: use U=N.

  const responseMatrix = nestedMatrixBytes(respondents, items);
  const qMatrix = nestedMatrixBytes(items, attributes);
  const modelArray = checkedSum(ARRAY_HEADER_BYTES, checkedProduct(items, JS_SLOT_BYTES));
  const priorArray = checkedSum(
    ARRAY_HEADER_BYTES,
    checkedProduct(latentClasses, JS_SLOT_BYTES),
  );
  const suppliedCandidates = candidateMatrixBytes(
    suppliedCandidateCount,
    items,
    reduced.total,
  );
  const validatedInput = checkedSum(
    responseMatrix,
    qMatrix,
    modelArray,
    priorArray,
    suppliedCandidates,
    STATIC_OBJECT_BYTES,
  );

  // These two ArrayBuffers are the exact transferable binary payload.
  const packedTransport = workerTransport
    ? checkedSum(
        checkedProduct(respondents, items, FLOAT_BYTES),
        checkedProduct(items, attributes, BINARY_BYTES),
      )
    : 0;
  // unpackValidatedInput rebuilds nested matrices while structured-cloned model,
  // prior, and initialization metadata remain live in the worker request.
  const workerUnpackedInput = workerTransport
    ? checkedSum(
        responseMatrix,
        qMatrix,
        modelArray,
        priorArray,
        suppliedCandidates,
        STATIC_OBJECT_BYTES,
      )
    : 0;

  const aggregationRetained = checkedSum(
    checkedProduct(uniqueRows, items, BINARY_BYTES),
    checkedProduct(uniqueRows, FLOAT_BYTES),
    checkedProduct(respondents, INDEX_BYTES),
  );
  const aggregationScratch = checkedSum(
    checkedProduct(uniqueRows, items, JS_SLOT_BYTES), // uniqueValues number[]
    checkedProduct(uniqueRows, items, STRING_CHARACTER_BYTES), // row keys
    checkedProduct(uniqueRows, ARRAY_HEADER_BYTES), // key strings
    checkedProduct(uniqueRows, MAP_ENTRY_BYTES),
    checkedProduct(uniqueRows, JS_SLOT_BYTES), // counts number[]
    items, // per-row Int8 encoding
    ARRAY_HEADER_BYTES * 2,
  );

  const compiledModel = checkedSum(
    nestedMatrixBytes(latentClasses, attributes), // retained canonical JS patterns
    checkedProduct(latentClasses, attributes, BINARY_BYTES), // flatPatterns
    checkedProduct(items, latentClasses, INDEX_BYTES), // flat locations
    checkedProduct(items, INDEX_BYTES, 2), // reduced counts and offsets
    INDEX_BYTES,
    checkedProduct(reduced.totalRequiredAttributes, JS_SLOT_BYTES),
    checkedProduct(checkedSum(items, 1), ARRAY_HEADER_BYTES),
  );
  const tupleConstruction = checkedSum(
    ARRAY_HEADER_BYTES,
    checkedProduct(reduced.maximum, JS_SLOT_BYTES),
    checkedProduct(reduced.maximum, ARRAY_HEADER_BYTES + 2 * JS_SLOT_BYTES),
  );
  const compilationScratch = checkedSum(
    nestedMatrixBytes(items, latentClasses), // parameterLocations nested result
    nestedMatrixBytes(reduced.maximum, reduced.maximumAttributes),
    checkedProduct(
      reduced.maximum,
      reduced.maximumAttributes,
      STRING_CHARACTER_BYTES,
    ),
    checkedProduct(reduced.maximum, ARRAY_HEADER_BYTES),
    checkedProduct(reduced.maximum, MAP_ENTRY_BYTES),
    tupleConstruction,
  );

  // Only the best state is retained; lightweight initial-likelihood summaries
  // remain for every candidate so selection is observable in FitResult.
  const startStates = checkedSum(
    checkedProduct(
      Math.min(starts, 2),
      checkedSum(reduced.total, latentClasses),
      FLOAT_BYTES,
    ),
    checkedProduct(starts, ARRAY_HEADER_BYTES + 4 * JS_SLOT_BYTES),
    checkedProduct(reduced.maximum, JS_SLOT_BYTES), // largest transient item vector
  );
  // E-step: four L and four T Float64 vectors. Saturated-prior normalization
  // allocates one additional L vector while the expectation result is live.
  const expectationWorkspace = checkedSum(
    checkedProduct(reduced.total, 4, FLOAT_BYTES),
    checkedProduct(latentClasses, 5, FLOAT_BYTES),
  );

  const scoreScratch = checkedSum(
    checkedProduct(uniqueRows, INDEX_BYTES, 2),
    checkedProduct(uniqueRows, attributes, FLOAT_BYTES),
    checkedProduct(uniqueRows, JS_SLOT_BYTES, 2),
    storesFullPosterior
      ? checkedSum(
          checkedProduct(respondents, JS_SLOT_BYTES),
          checkedProduct(checkedSum(uniqueRows, respondents), ARRAY_HEADER_BYTES),
        )
      : 0,
  );
  const scoreOutput = checkedSum(
    nestedMatrixBytes(respondents, attributes),
    nestedMatrixBytes(respondents, attributes),
    checkedProduct(respondents, JS_SLOT_BYTES, 4),
    ARRAY_HEADER_BYTES * 4,
  );
  const itemOutput = checkedSum(
    checkedProduct(items, latentClasses, JS_SLOT_BYTES),
    checkedProduct(reduced.total, JS_SLOT_BYTES, 2), // group probabilities + deltas
    checkedProduct(reduced.totalRequiredAttributes, JS_SLOT_BYTES),
    checkedProduct(
      checkedSum(checkedProduct(items, 4), 1),
      ARRAY_HEADER_BYTES,
    ),
  );
  const publicResultWithoutPosterior = checkedSum(
    scoreOutput,
    itemOutput,
    nestedMatrixBytes(latentClasses, attributes), // public attributePatterns copy
    checkedProduct(latentClasses, JS_SLOT_BYTES),
    checkedProduct(starts, ARRAY_HEADER_BYTES + 12 * JS_SLOT_BYTES),
    checkedProduct(items, JS_SLOT_BYTES),
    STATIC_OBJECT_BYTES,
  );
  const scoringAndResult = checkedSum(scoreScratch, publicResultWithoutPosterior);
  const posterior = storesFullPosterior
    ? nestedMatrixBytes(respondents, latentClasses)
    : 0;

  const resultObjectBytes = checkedSum(publicResultWithoutPosterior, posterior);
  const resultSerialization = workerTransport
    ? checkedSum(
        checkedProduct(estimatedResultJsonBytes({
          attributes,
          items,
          latentClasses,
          posterior: storesFullPosterior,
          respondents,
          starts,
          totalReducedClasses: reduced.total,
          totalRequiredAttributes: reduced.totalRequiredAttributes,
        }), 3),
        resultObjectBytes, // parsed result simultaneously lives in the caller realm
      )
    : 0;

  const rawBytes = checkedSum(
    validatedInput,
    packedTransport,
    workerUnpackedInput,
    aggregationRetained,
    aggregationScratch,
    compiledModel,
    compilationScratch,
    startStates,
    expectationWorkspace,
    scoringAndResult,
    posterior,
    resultSerialization,
  );
  const overhead = checkedScale(rawBytes, safetyFactor - 1);
  const estimatedBytes = checkedSum(rawBytes, overhead);

  return {
    dimensions: { attributes, items, latentClasses, respondents },
    rawBytes,
    estimatedBytes,
    breakdown: {
      validatedInput,
      packedTransport,
      workerUnpackedInput,
      aggregationRetained,
      aggregationScratch,
      compiledModel,
      compilationScratch,
      startStates,
      expectationWorkspace,
      scoringAndResult,
      posterior,
      resultSerialization,
      overhead,
    },
    assumptions: {
      floatBytes: FLOAT_BYTES,
      binaryBytes: BINARY_BYTES,
      indexBytes: INDEX_BYTES,
      jsSlotBytes: JS_SLOT_BYTES,
      arrayHeaderBytes: ARRAY_HEADER_BYTES,
      stringCharacterBytes: STRING_CHARACTER_BYTES,
      mapEntryBytes: MAP_ENTRY_BYTES,
      jsonNumberBytes: JSON_NUMBER_BYTES,
      safetyFactor,
      blockSize,
      blockSizeAffectsMemory: false,
      storesFullPosterior,
      workerTransport,
      uniqueResponsePatterns: uniqueRows,
      starts,
      suppliedCandidateCount,
      totalReducedClasses: reduced.total,
      maxReducedClassesPerItem: reduced.maximum,
      totalRequiredAttributes: reduced.totalRequiredAttributes,
    },
  };
}

/** Estimates memory and throws a typed error before unsafe work is allocated. */
export function assertWithinResourceLimits(
  request: FitMemoryRequest,
  limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS,
): FitMemoryEstimate {
  assertFitDimensionsWithinResourceLimits(request, limits);

  const estimate = estimateFitMemory(request);
  if (estimate.estimatedBytes > limits.maxEstimatedBytes) {
    throw new ResourceLimitError(
      "estimatedBytes",
      estimate.estimatedBytes,
      limits.maxEstimatedBytes,
    );
  }
  return estimate;
}

/** Cheap dimension-only guard suitable before response/Q defensive copies. */
export function assertFitDimensionsWithinResourceLimits(
  dimensions: Pick<FitMemoryRequest, "respondents" | "items" | "attributes">,
  limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS,
): void {
  assertDimensionLimit("respondents", dimensions.respondents, limits.maxRespondents);
  assertDimensionLimit("items", dimensions.items, limits.maxItems);
  assertDimensionLimit("attributes", dimensions.attributes, limits.maxAttributes);
  const latentClasses = 2 ** dimensions.attributes;
  assertDimensionLimit("latentClasses", latentClasses, limits.maxLatentClasses);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"] as const;
  let value = bytes / 1024;
  let unit: (typeof units)[number] = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index] ?? unit;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function validateMemoryRequest(request: FitMemoryRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const key of ["respondents", "items", "attributes", "blockSize"] as const) {
    const value = key === "blockSize" ? request.blockSize ?? DEFAULT_BLOCK_SIZE : request[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      issues.push({
        path: key,
        code: Number.isInteger(value) ? "range" : "integer",
        message: "must be a positive safe integer",
      });
    }
  }

  const starts = request.starts ?? DEFAULT_MEMORY_STARTS;
  if (!Number.isSafeInteger(starts) || starts <= 0) {
    issues.push({ path: "starts", code: "integer", message: "must be a positive safe integer" });
  }
  const suppliedCandidateCount = request.suppliedCandidateCount ?? 0;
  if (!Number.isSafeInteger(suppliedCandidateCount) || suppliedCandidateCount < 0) {
    issues.push({
      path: "suppliedCandidateCount",
      code: "integer",
      message: "must be a nonnegative safe integer",
    });
  } else if (Number.isSafeInteger(starts) && suppliedCandidateCount > starts) {
    issues.push({
      path: "suppliedCandidateCount",
      code: "range",
      message: "must not exceed starts",
    });
  }

  if (request.attributes > 52) {
    issues.push({
      path: "attributes",
      code: "range",
      message: "must be 52 or less so 2^K is represented exactly",
    });
  }
  if (
    request.posteriorStorage !== undefined &&
    request.posteriorStorage !== "full" &&
    request.posteriorStorage !== "scores-only"
  ) {
    issues.push({
      path: "posteriorStorage",
      code: "unsupported",
      message: 'must be "full" or "scores-only"',
    });
  }
  if (request.workerTransport !== undefined && typeof request.workerTransport !== "boolean") {
    issues.push({
      path: "workerTransport",
      code: "type",
      message: "must be boolean",
    });
  }
  if (request.reducedClassCounts !== undefined) {
    if (!Array.isArray(request.reducedClassCounts)) {
      issues.push({
        path: "reducedClassCounts",
        code: "type",
        message: "must be an array",
      });
    } else {
      const latentClasses = 2 ** request.attributes;
      if (request.reducedClassCounts.length !== request.items) {
        issues.push({
          path: "reducedClassCounts",
          code: "length",
          message: `must contain exactly ${request.items} entries`,
        });
      }
      request.reducedClassCounts.forEach((count, item) => {
        if (
          !Number.isSafeInteger(count) ||
          count < 2 ||
          count > latentClasses ||
          !Number.isInteger(Math.log2(count))
        ) {
          issues.push({
            path: `reducedClassCounts[${item}]`,
            code: "range",
            message: `must be a power of two from 2 through ${latentClasses}`,
          });
        }
      });
    }
  }
  const safetyFactor = request.safetyFactor ?? DEFAULT_MEMORY_SAFETY_FACTOR;
  if (!Number.isFinite(safetyFactor) || safetyFactor < 1) {
    issues.push({
      path: "safetyFactor",
      code: "range",
      message: "must be a finite number greater than or equal to 1",
    });
  }
  return issues;
}

interface ReducedClassSummary {
  readonly total: number;
  readonly maximum: number;
  readonly maximumAttributes: number;
  readonly totalRequiredAttributes: number;
}

function reducedClassSummary(
  request: FitMemoryRequest,
  latentClasses: number,
): ReducedClassSummary {
  if (request.reducedClassCounts === undefined) {
    return {
      total: checkedProduct(request.items, latentClasses),
      maximum: latentClasses,
      maximumAttributes: request.attributes,
      totalRequiredAttributes: checkedProduct(request.items, request.attributes),
    };
  }

  let total = 0;
  let maximum = 0;
  let totalRequiredAttributes = 0;
  for (const count of request.reducedClassCounts) {
    total = checkedSum(total, count);
    maximum = Math.max(maximum, count);
    totalRequiredAttributes = checkedSum(totalRequiredAttributes, Math.log2(count));
  }
  return {
    total,
    maximum,
    maximumAttributes: Math.log2(maximum),
    totalRequiredAttributes,
  };
}

function nestedMatrixBytes(rows: number, columns: number): number {
  return checkedSum(
    checkedProduct(rows, columns, JS_SLOT_BYTES),
    checkedProduct(checkedSum(rows, 1), ARRAY_HEADER_BYTES),
  );
}

function candidateMatrixBytes(count: number, items: number, totalValues: number): number {
  if (count === 0) return 0;
  const oneCandidate = checkedSum(
    checkedProduct(totalValues, JS_SLOT_BYTES),
    checkedProduct(checkedSum(items, 1), ARRAY_HEADER_BYTES),
  );
  return checkedSum(
    ARRAY_HEADER_BYTES,
    checkedProduct(count, JS_SLOT_BYTES),
    checkedProduct(count, oneCandidate),
  );
}

interface ResultJsonShape {
  readonly attributes: number;
  readonly items: number;
  readonly latentClasses: number;
  readonly posterior: boolean;
  readonly respondents: number;
  readonly starts: number;
  readonly totalReducedClasses: number;
  readonly totalRequiredAttributes: number;
}

function estimatedResultJsonBytes(shape: ResultJsonShape): number {
  const posteriorValues = shape.posterior
    ? checkedProduct(shape.respondents, shape.latentClasses)
    : 0;
  const numericValues = checkedSum(
    checkedProduct(shape.latentClasses, shape.attributes), // attribute patterns
    shape.latentClasses, // class probabilities
    checkedProduct(shape.items, shape.latentClasses), // expanded item probabilities
    checkedProduct(shape.totalReducedClasses, 2), // groups and deltas
    shape.totalRequiredAttributes,
    posteriorValues,
    checkedProduct(shape.respondents, 2), // MAP and MLE indices
    checkedProduct(shape.respondents, shape.attributes), // EAP probabilities
    checkedProduct(shape.starts, 8),
    128,
  );
  const booleanOrNullValues = checkedSum(
    checkedProduct(shape.respondents, 2), // MAP/MLE ties
    checkedProduct(shape.respondents, shape.attributes), // EAP classifications
    shape.starts,
    16,
  );
  const containers = checkedSum(
    shape.latentClasses,
    shape.posterior ? shape.respondents : 0,
    checkedProduct(shape.respondents, 2),
    checkedProduct(shape.items, 4),
    shape.starts,
    32,
  );
  return checkedSum(
    checkedProduct(numericValues, JSON_NUMBER_BYTES),
    checkedProduct(booleanOrNullValues, JSON_SCALAR_BYTES),
    checkedProduct(containers, 2),
    checkedProduct(shape.items, 256), // repeated item keys and model strings
    checkedProduct(shape.starts, 256), // repeated start-summary keys/reasons
    STATIC_OBJECT_BYTES,
  );
}

function assertDimensionLimit(limit: string, actual: number, maximum: number): void {
  if (actual > maximum) throw new ResourceLimitError(limit, actual, maximum);
}

function checkedProduct(...factors: number[]): number {
  let product = 1;
  for (const factor of factors) {
    product *= factor;
    if (!Number.isSafeInteger(product)) {
      throw new ResourceLimitError("safeIntegerBytes", product, Number.MAX_SAFE_INTEGER);
    }
  }
  return product;
}

function checkedSum(...values: number[]): number {
  let sum = 0;
  for (const value of values) {
    sum += value;
    if (!Number.isSafeInteger(sum)) {
      throw new ResourceLimitError("safeIntegerBytes", sum, Number.MAX_SAFE_INTEGER);
    }
  }
  return sum;
}

function checkedScale(value: number, factor: number): number {
  const scaled = Math.ceil(value * factor);
  if (!Number.isSafeInteger(scaled)) {
    throw new ResourceLimitError("safeIntegerBytes", scaled, Number.MAX_SAFE_INTEGER);
  }
  return scaled;
}
