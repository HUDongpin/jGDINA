/** Canonical item models supported by the jGDINA v1 estimation engine. */
export const ITEM_MODELS = ["GDINA", "DINA", "DINO"] as const;

export type ItemModel = (typeof ITEM_MODELS)[number];
export type BinaryValue = 0 | 1;
export type MissingResponse = null;

/**
 * Public input values are numbers so JavaScript callers can use `Number.NaN`.
 * Validation accepts only 0, 1, null, and NaN; NaN is normalized to null.
 */
export type ResponseInputValue = number | null;
export type ResponseValue = BinaryValue | MissingResponse;

export type MatrixInput<T> = readonly (readonly T[])[];

export interface SaturatedPrior {
  readonly type: "saturated";
  /** Optional deterministic starting proportions, ordered like attributePatterns. */
  readonly initialProbabilities?: readonly number[];
}

export interface FixedPrior {
  readonly type: "fixed";
  /** Fixed latent-class proportions, ordered like attributePatterns. */
  readonly probabilities: readonly number[];
}

export type AttributePrior = SaturatedPrior | FixedPrior;

/** One compact/full reduced-group probability vector per item. */
export type ItemProbabilities = readonly (readonly number[])[];

export interface DeterministicInitializationOptions {
  /** v1 intentionally exposes only reproducible initialization. */
  readonly strategy?: "deterministic";
  /**
   * Number of reproducible candidates. Matching GDINA, every candidate is
   * scored under the initial prior, the highest initial likelihood (lowest
   * index on ties) is selected, and EM runs only from that candidate.
   */
  readonly starts?: number;
  /** Unsigned 32-bit seed. Start i is derived deterministically from this seed and i. */
  readonly seed?: number;
  /**
   * Optional legacy start-0 probabilities. GDINA items require 2^Kj values in
   * alpha2 order. DINA/DINO accept either the compact two free probabilities or
   * the full 2^Kj vector with the model-required groups tied. Remaining starts
   * derive from seed and start index.
   */
  readonly initialItemProbabilities?: ItemProbabilities;
  /**
   * Explicit ordered candidates. These take precedence over the legacy
   * initialItemProbabilities field. If starts is omitted, candidate count is
   * used; a larger starts value appends seeded candidates.
   */
  readonly initialItemProbabilityCandidates?: readonly ItemProbabilities[];
}

export type PosteriorStorage = "full" | "scores-only";

export interface ResourceLimits {
  readonly maxRespondents: number;
  readonly maxItems: number;
  readonly maxAttributes: number;
  readonly maxLatentClasses: number;
  readonly maxEstimatedBytes: number;
  readonly maxStarts: number;
  readonly maxIterations: number;
}

export type ResourceLimitOverrides = Partial<ResourceLimits>;

export interface EstimationOptions {
  readonly maxIterations?: number;
  readonly convergenceTolerance?: number;
  /** Strict-interior success-probability bounds. Defaults to [0.0001, 0.9999]. */
  readonly probabilityBounds?: readonly [lower: number, upper: number];
  /** GDINA small-expected-cell correction controls. Defaults to [0.0005, 0.001]. */
  readonly smallSampleCorrection?: readonly [numerator: number, denominator: number];
  readonly initialization?: DeterministicInitializationOptions;
  /** Aggregate identical response rows before EM; individual scores retain input order. */
  readonly aggregateRows?: boolean;
  /** Full stores N x 2^K posteriors; scores-only avoids that persistent matrix. */
  readonly posteriorStorage?: PosteriorStorage;
  /** Respondent-row interval between cooperative abort checks; no row block is allocated. */
  readonly blockSize?: number;
  readonly resourceLimits?: ResourceLimitOverrides;
}

/**
 * Data-only fit request. Use null for JSON transport; local callers may also
 * pass NaN, which validation normalizes to null. Callbacks belong in FitOptions.
 */
export interface FitInput {
  /** N x J binary response matrix. null and NaN both mean missing. */
  readonly responses: MatrixInput<ResponseInputValue>;
  /** J x K binary Q-matrix. */
  readonly qMatrix: MatrixInput<number>;
  /** One model for all items or one model per item. Defaults to GDINA. */
  readonly model?: ItemModel | readonly ItemModel[];
  /** Defaults to an estimated saturated latent-class distribution. */
  readonly prior?: AttributePrior;
  readonly estimation?: EstimationOptions;
}

export interface FitDimensions {
  readonly respondents: number;
  readonly items: number;
  readonly attributes: number;
  readonly latentClasses: number;
}

export interface ResolvedInitializationOptions {
  readonly strategy: "deterministic";
  readonly starts: number;
  readonly seed: number;
  readonly initialItemProbabilities: ItemProbabilities | null;
  readonly initialItemProbabilityCandidates: readonly ItemProbabilities[] | null;
}

export interface ResolvedEstimationOptions {
  readonly maxIterations: number;
  readonly convergenceTolerance: number;
  readonly probabilityBounds: readonly [lower: number, upper: number];
  readonly smallSampleCorrection: readonly [numerator: number, denominator: number];
  readonly initialization: ResolvedInitializationOptions;
  readonly aggregateRows: boolean;
  readonly posteriorStorage: PosteriorStorage;
  readonly blockSize: number;
  readonly resourceLimits: ResourceLimits;
}

export type ValidatedAttributePrior =
  | {
      readonly type: "saturated";
      readonly initialProbabilities: readonly number[] | null;
    }
  | {
      readonly type: "fixed";
      readonly probabilities: readonly number[];
    };

export interface MemoryBreakdown {
  /** Defensive normalized matrices and supplied prior/start arrays in the caller realm. */
  readonly validatedInput: number;
  /** Exact transferable response and Q ArrayBuffer payloads. */
  readonly packedTransport: number;
  /** Worker-side nested matrices and structured-cloned input metadata. */
  readonly workerUnpackedInput: number;
  /** Compact unique response rows, frequencies, and original-row mapping. */
  readonly aggregationRetained: number;
  /** String keys, Map entries, and temporary JavaScript arrays used while aggregating. */
  readonly aggregationScratch: number;
  /** Retained attribute patterns, parameter locations, and compiled item metadata. */
  readonly compiledModel: number;
  /** Nested locations plus the largest item-local pattern/Map construction. */
  readonly compilationScratch: number;
  /** Best candidate state plus lightweight initial-likelihood summaries. */
  readonly startStates: number;
  /** E-step buffers plus the saturated-prior normalization buffer. */
  readonly expectationWorkspace: number;
  /** Scores and public result arrays other than the optional full posterior. */
  readonly scoringAndResult: number;
  /** Public N x 2^K posterior arrays, including row-array headers. */
  readonly posterior: number;
  /** Conservative worker JSON encode/decode envelope and parsed result copy. */
  readonly resultSerialization: number;
  /** Additional runtime/allocator reserve implied by safetyFactor. */
  readonly overhead: number;
}

export interface MemoryAssumptions {
  readonly floatBytes: 8;
  readonly binaryBytes: 1;
  readonly indexBytes: 4;
  readonly jsSlotBytes: 8;
  readonly arrayHeaderBytes: number;
  readonly stringCharacterBytes: number;
  readonly mapEntryBytes: number;
  readonly jsonNumberBytes: number;
  readonly safetyFactor: number;
  readonly blockSize: number;
  /** blockSize currently controls cancellation polling, not allocated row blocks. */
  readonly blockSizeAffectsMemory: false;
  readonly storesFullPosterior: boolean;
  readonly workerTransport: boolean;
  /** Worst-case unique rows used before aggregation has run. */
  readonly uniqueResponsePatterns: number;
  readonly starts: number;
  readonly suppliedCandidateCount: number;
  readonly totalReducedClasses: number;
  readonly maxReducedClassesPerItem: number;
  readonly totalRequiredAttributes: number;
}

export interface FitMemoryEstimate {
  readonly dimensions: FitDimensions;
  /** Sum before conservative JavaScript/runtime overhead. */
  readonly rawBytes: number;
  /** rawBytes plus the modeled overhead. */
  readonly estimatedBytes: number;
  readonly breakdown: MemoryBreakdown;
  readonly assumptions: MemoryAssumptions;
}

/** Canonical form consumed by numerical backends. Input arrays are defensive copies. */
export interface ValidatedFitInput {
  readonly responses: readonly (readonly ResponseValue[])[];
  readonly qMatrix: readonly (readonly BinaryValue[])[];
  readonly models: readonly ItemModel[];
  readonly prior: ValidatedAttributePrior;
  readonly estimation: ResolvedEstimationOptions;
  readonly dimensions: FitDimensions;
  readonly missingResponseCount: number;
  readonly memoryEstimate: FitMemoryEstimate;
}

/** A deliberately structural signal type usable in browsers, Node, and worker adapters. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
}

export type FitPhase =
  | "validation"
  | "initialization"
  | "estimation"
  | "scoring"
  | "complete";

export interface FitProgress {
  readonly phase: FitPhase;
  /** Overall completion in the inclusive range [0, 1]. */
  readonly fraction: number;
  readonly startIndex?: number;
  readonly totalStarts?: number;
  readonly iteration?: number;
  readonly maxIterations?: number;
  readonly logLikelihood?: number;
}

export interface FitOptions {
  readonly signal?: AbortSignalLike;
  readonly onProgress?: (progress: FitProgress) => void;
}

export interface ItemEstimate {
  /** Zero-based item index. */
  readonly itemIndex: number;
  readonly model: ItemModel;
  /** Zero-based attribute indices required by this item. */
  readonly requiredAttributes: readonly number[];
  /** P(X_j=1 | alpha_c), ordered by attributePatterns. */
  readonly successProbabilities: readonly number[];
  /**
   * Compact local pattern probabilities in GDINA alpha2 order over this item's
   * requiredAttributes: zero, singleton profiles, increasing-cardinality
   * combinations, then all ones (length 2^Kj). DINA/DINO repeat their two tied
   * group probabilities across those patterns for direct GDINA-oracle parity.
   */
  readonly groupSuccessProbabilities: readonly number[];
  /** Model-design coefficients in the backend's documented design-column order. */
  readonly deltaParameters: readonly number[];
}

export interface ParameterEstimates {
  readonly items: readonly ItemEstimate[];
  readonly classProbabilities: readonly number[];
}

export type ConvergenceReason = "tolerance" | "maximum-iterations";
export type StartSummaryReason = ConvergenceReason | "not-selected";

export interface StartSummary {
  /** Zero-based start index. */
  readonly startIndex: number;
  readonly initialLogLikelihood: number;
  readonly selectedForEstimation: boolean;
  readonly converged: boolean;
  readonly reason: StartSummaryReason;
  readonly iterations: number;
  /** Final likelihood for the selected candidate; initial likelihood otherwise. */
  readonly logLikelihood: number;
  readonly finalChange: number;
}

export interface ConvergenceSummary {
  readonly converged: boolean;
  readonly reason: ConvergenceReason;
  readonly iterations: number;
  readonly finalChange: number;
  readonly selectedStartIndex: number;
  readonly starts: readonly StartSummary[];
}

export interface FitStatistics {
  readonly logLikelihood: number;
  readonly deviance: number;
  readonly aic: number;
  /** Null when respondents <= estimatedParameterCount + 1. */
  readonly aicc: number | null;
  readonly bic: number;
  readonly caic: number;
  readonly sabic: number;
  readonly estimatedParameterCount: number;
}

export interface PersonScores {
  /** Null only when posteriorStorage is scores-only. Rows otherwise follow input order. */
  readonly posteriorProbabilities: readonly (readonly number[])[] | null;
  /** Zero-based class indices using the fitted/fixed prior. */
  readonly mapClassIndices: readonly number[];
  /** True where multiple classes share the maximum posterior probability. */
  readonly mapHasTies: readonly boolean[];
  /** Zero-based class indices with the prior omitted. */
  readonly mleClassIndices: readonly number[];
  /** True where multiple classes share the maximum response likelihood. */
  readonly mleHasTies: readonly boolean[];
  /** N x K posterior attribute-mastery probabilities. */
  readonly eapAttributeProbabilities: readonly (readonly number[])[];
  /** N x K binary classifications using probability > 0.5, matching GDINA. */
  readonly eapAttributeClassifications: readonly (readonly BinaryValue[])[];
}

export interface FitDiagnostics {
  readonly missingResponseCount: number;
  readonly uniqueResponsePatterns: number;
  readonly rowsAggregated: boolean;
  readonly memoryEstimate: FitMemoryEstimate;
}

/**
 * JSON-friendly result contract: only objects, arrays, strings, booleans, null,
 * and finite numbers. Backends must not return typed arrays, NaN, or Infinity.
 */
export interface FitResult {
  readonly schemaVersion: "1.0";
  readonly backendId: string;
  readonly dimensions: FitDimensions;
  readonly models: readonly ItemModel[];
  readonly priorType: AttributePrior["type"];
  /** Binary profiles in the exact class order used by every class-indexed field. */
  readonly attributePatterns: readonly (readonly BinaryValue[])[];
  readonly estimates: ParameterEstimates;
  readonly statistics: FitStatistics;
  readonly convergence: ConvergenceSummary;
  readonly scores: PersonScores;
  readonly diagnostics: FitDiagnostics;
}

export type MaybePromise<T> = T | PromiseLike<T>;

/** Numerical or worker implementation injected into the environment-neutral core. */
export interface FitBackend {
  readonly id: string;
  fit(input: ValidatedFitInput, options?: FitOptions): MaybePromise<FitResult>;
}

export interface JGDINA {
  readonly backendId: string;
  validate(input: FitInput): ValidatedFitInput;
  fit(input: FitInput, options?: FitOptions): Promise<FitResult>;
}
