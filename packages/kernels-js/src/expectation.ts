import { JGDINAError, throwIfAborted, type FitOptions } from "@jgdina/core";
import type {
  AggregatedRows,
  CompiledModel,
  ExpectationResult,
  ParameterState,
} from "./internal.js";

export interface ExpectationOptions {
  readonly collectSufficientStatistics?: boolean;
  readonly retainPosterior?: boolean;
  readonly retainLogLikelihoodByClass?: boolean;
  readonly blockSize?: number;
  readonly execution?: FitOptions;
  readonly onRow?: (
    uniqueRow: number,
    logLikelihoodByClass: Float64Array,
    posterior: Float64Array,
  ) => void;
}

/** Stable row-wise log-sum-exp E-step with no N x J x L temporary arrays. */
export function expectationStep(
  model: CompiledModel,
  rows: AggregatedRows,
  state: ParameterState,
  options: ExpectationOptions = {},
): ExpectationResult {
  const { classes, items, totalReducedClasses } = model;
  const collect = options.collectSufficientStatistics ?? true;
  const blockSize = Math.max(1, options.blockSize ?? 256);
  if (state.classProbabilities.length !== classes) {
    throw new RangeError("class probability vector has the wrong length");
  }
  if (state.itemProbabilities.length !== totalReducedClasses) {
    throw new RangeError("item probability vector has the wrong length");
  }

  const logPrior = new Float64Array(classes);
  for (let latentClass = 0; latentClass < classes; latentClass += 1) {
    const value = state.classProbabilities[latentClass] ?? 0;
    logPrior[latentClass] = value === 0 ? Number.NEGATIVE_INFINITY : Math.log(value);
  }

  // Cache both response-category logs once per item/reduced group. The probabilities
  // are bounded by validation/M-step, so log and log1p remain finite.
  const logSuccess = new Float64Array(totalReducedClasses);
  const logFailure = new Float64Array(totalReducedClasses);
  for (let item = 0; item < items; item += 1) {
    const categoryOffset = model.categoryOffsets[item] ?? 0;
    const categoryEnd = model.categoryOffsets[item + 1] ?? categoryOffset;
    for (let category = categoryOffset; category < categoryEnd; category += 1) {
      const probability = state.itemProbabilities[category] ?? 0;
      if (!(probability > 0 && probability < 1)) {
        throw new JGDINAError(
          "NUMERICAL_FAILURE",
          `Item ${item} success probability must be strictly between zero and one.`,
          { category: category - categoryOffset, item, probability },
        );
      }
      logSuccess[category] = Math.log(probability);
      logFailure[category] = Math.log1p(-probability);
    }
  }

  const classCounts = new Float64Array(classes);
  const expectedTotal = new Float64Array(totalReducedClasses);
  const expectedCorrect = new Float64Array(totalReducedClasses);
  const posterior = options.retainPosterior
    ? new Float64Array(rows.uniqueRowCount * classes)
    : null;
  const retainedLogLikelihood = options.retainLogLikelihoodByClass
    ? new Float64Array(rows.uniqueRowCount * classes)
    : null;
  const rowLogLikelihood = new Float64Array(classes);
  const rowPosterior = new Float64Array(classes);
  let logLikelihood = 0;

  for (let row = 0; row < rows.uniqueRowCount; row += 1) {
    if (row % blockSize === 0) throwIfAborted(options.execution);
    let maximum = Number.NEGATIVE_INFINITY;
    for (let latentClass = 0; latentClass < classes; latentClass += 1) {
      let value = 0;
      for (let item = 0; item < items; item += 1) {
        const response = rows.values[row * items + item] ?? -1;
        const category =
          (model.categoryOffsets[item] ?? 0) +
          (model.locations[item * classes + latentClass] ?? 0);
        if (response === 1) value += logSuccess[category] ?? 0;
        else if (response === 0) value += logFailure[category] ?? 0;
      }
      rowLogLikelihood[latentClass] = value;
      const joint = value + (logPrior[latentClass] ?? Number.NEGATIVE_INFINITY);
      if (joint > maximum) maximum = joint;
    }
    if (!Number.isFinite(maximum)) {
      throw new JGDINAError(
        "NUMERICAL_FAILURE",
        "No latent class has positive prior probability.",
      );
    }

    let scaledSum = 0;
    for (let latentClass = 0; latentClass < classes; latentClass += 1) {
      scaledSum += Math.exp(
        (rowLogLikelihood[latentClass] ?? 0) +
          (logPrior[latentClass] ?? Number.NEGATIVE_INFINITY) -
          maximum,
      );
    }
    const rowMarginalLogLikelihood = maximum + Math.log(scaledSum);
    const frequency = rows.frequencies[row] ?? 0;
    logLikelihood += frequency * rowMarginalLogLikelihood;

    for (let latentClass = 0; latentClass < classes; latentClass += 1) {
      const value = Math.exp(
        (rowLogLikelihood[latentClass] ?? 0) +
          (logPrior[latentClass] ?? Number.NEGATIVE_INFINITY) -
          rowMarginalLogLikelihood,
      );
      rowPosterior[latentClass] = value;
      classCounts[latentClass] = (classCounts[latentClass] ?? 0) + frequency * value;
      if (posterior !== null) posterior[row * classes + latentClass] = value;
      if (retainedLogLikelihood !== null) {
        retainedLogLikelihood[row * classes + latentClass] = rowLogLikelihood[latentClass] ?? 0;
      }

      if (collect) {
        const weightedPosterior = frequency * value;
        for (let item = 0; item < items; item += 1) {
          const response = rows.values[row * items + item] ?? -1;
          if (response === -1) continue;
          const location = model.locations[item * classes + latentClass] ?? 0;
          const index = (model.categoryOffsets[item] ?? 0) + location;
          expectedTotal[index] = (expectedTotal[index] ?? 0) + weightedPosterior;
          if (response === 1) {
            expectedCorrect[index] = (expectedCorrect[index] ?? 0) + weightedPosterior;
          }
        }
      }
    }
    options.onRow?.(row, rowLogLikelihood, rowPosterior);
  }
  throwIfAborted(options.execution);

  if (!Number.isFinite(logLikelihood)) {
    throw new JGDINAError("NUMERICAL_FAILURE", "Observed log-likelihood is not finite.");
  }
  return {
    classCounts,
    expectedCorrect,
    expectedTotal,
    logLikelihood,
    logLikelihoodByClass: retainedLogLikelihood,
    posterior,
  };
}
