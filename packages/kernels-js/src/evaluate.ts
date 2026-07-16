import type { BinaryValue, FitOptions, ValidatedFitInput } from "@jgdina/core";
import { aggregateRowsInternal } from "./aggregate.js";
import { expectationStep } from "./expectation.js";
import { classSuccessProbabilities } from "./helpers.js";
import { expandProbabilities, normalizeInPlace } from "./initialization.js";
import { compileModel, type ParameterState } from "./internal.js";

export interface ModelEvaluation {
  readonly logLikelihood: number;
  readonly classProbabilities: readonly number[];
  readonly itemSuccessProbabilities: readonly (readonly number[])[];
  readonly classSuccessProbabilities: readonly (readonly number[])[];
  readonly posteriorProbabilities: readonly (readonly number[])[];
  readonly logLikelihoodByClass: readonly (readonly number[])[];
  readonly expectedCorrect: readonly (readonly number[])[];
  readonly expectedTotal: readonly (readonly number[])[];
  readonly mapClassIndices: readonly number[];
  readonly mapHasTies: readonly boolean[];
  readonly mleClassIndices: readonly number[];
  readonly mleHasTies: readonly boolean[];
  readonly eapAttributeProbabilities: readonly (readonly number[])[];
  readonly eapAttributeClassifications: readonly (readonly BinaryValue[])[];
}

/**
 * Evaluates supplied item parameters without fitting. This is the numerical
 * oracle surface used for likelihood/posterior parity fixtures.
 */
export function evaluateValidated(
  input: ValidatedFitInput,
  itemProbabilities: readonly (readonly number[])[],
  classProbabilities?: readonly number[],
  options?: FitOptions,
): ModelEvaluation {
  const model = compileModel(input);
  if (itemProbabilities.length !== model.items) {
    throw new RangeError(`itemProbabilities must contain ${model.items} rows`);
  }
  const stateItem = new Float64Array(model.totalReducedClasses);
  const nestedReduced: number[][] = [];
  for (let item = 0; item < model.items; item += 1) {
    const offset = model.categoryOffsets[item] ?? 0;
    const count = model.reducedClassCounts[item] ?? 0;
    const source = itemProbabilities[item];
    if (source === undefined) throw new RangeError(`missing item probabilities for item ${item}`);
    const expanded = expandProbabilities(source, count, model.models[item] ?? "GDINA");
    nestedReduced.push(expanded);
    for (let category = 0; category < count; category += 1) {
      const probability = expanded[category] ?? 0;
      if (!(probability > 0 && probability < 1)) {
        throw new RangeError(`item probability ${item}:${category} must be strictly between zero and one`);
      }
      stateItem[offset + category] = probability;
    }
  }

  const priors = Float64Array.from(
    classProbabilities ??
      (input.prior.type === "fixed"
        ? input.prior.probabilities
        : input.prior.initialProbabilities ??
          Array.from({ length: model.classes }, () => 1 / model.classes)),
  );
  if (priors.length !== model.classes) {
    throw new RangeError(`classProbabilities must contain ${model.classes} values`);
  }
  for (let latentClass = 0; latentClass < priors.length; latentClass += 1) {
    const probability = priors[latentClass] ?? 0;
    if (!Number.isFinite(probability) || probability < 0) {
      throw new RangeError(`classProbabilities[${latentClass}] must be finite and nonnegative`);
    }
  }
  normalizeInPlace(priors);
  const state: ParameterState = { classProbabilities: priors, itemProbabilities: stateItem };
  const rows = aggregateRowsInternal(input.responses, false);
  const result = expectationStep(model, rows, state, {
    blockSize: input.estimation.blockSize,
    collectSufficientStatistics: true,
    ...(options === undefined ? {} : { execution: options }),
    retainLogLikelihoodByClass: true,
    retainPosterior: true,
  });
  if (result.posterior === null || result.logLikelihoodByClass === null) {
    throw new Error("evaluation rows were not retained");
  }

  const posteriorProbabilities = splitMatrix(result.posterior, model.respondents, model.classes);
  const logLikelihoodByClass = splitMatrix(
    result.logLikelihoodByClass,
    model.respondents,
    model.classes,
  );
  const map = posteriorProbabilities.map(argmaxWithTie);
  const mle = logLikelihoodByClass.map(argmaxWithTie);
  const eapAttributeProbabilities = posteriorProbabilities.map((posterior) =>
    Array.from({ length: model.attributes }, (_, attribute) => {
      let probability = 0;
      for (let latentClass = 0; latentClass < model.classes; latentClass += 1) {
        if (model.flatPatterns[latentClass * model.attributes + attribute] === 1) {
          probability += posterior[latentClass] ?? 0;
        }
      }
      return Math.max(0, Math.min(1, probability));
    }),
  );

  return {
    classProbabilities: Array.from(priors),
    classSuccessProbabilities: classSuccessProbabilities(
      nestedReduced,
      nestedLocations(model),
    ),
    expectedCorrect: splitReduced(model, result.expectedCorrect),
    expectedTotal: splitReduced(model, result.expectedTotal),
    eapAttributeClassifications: eapAttributeProbabilities.map((row) =>
      row.map((probability): BinaryValue => (probability > 0.5 ? 1 : 0)),
    ),
    eapAttributeProbabilities,
    itemSuccessProbabilities: nestedReduced,
    logLikelihood: result.logLikelihood,
    logLikelihoodByClass,
    mapClassIndices: map.map((score) => score.index),
    mapHasTies: map.map((score) => score.hasTie),
    mleClassIndices: mle.map((score) => score.index),
    mleHasTies: mle.map((score) => score.hasTie),
    posteriorProbabilities,
  };
}

function argmaxWithTie(values: readonly number[]): { index: number; hasTie: boolean } {
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

function nestedLocations(model: ReturnType<typeof compileModel>): number[][] {
  const output: number[][] = [];
  for (let item = 0; item < model.items; item += 1) {
    output.push(
      Array.from(
        model.locations.subarray(item * model.classes, (item + 1) * model.classes),
      ),
    );
  }
  return output;
}

function splitReduced(
  model: ReturnType<typeof compileModel>,
  values: Float64Array,
): number[][] {
  const output: number[][] = [];
  for (let item = 0; item < model.items; item += 1) {
    output.push(
      Array.from(
        values.subarray(
          model.categoryOffsets[item] ?? 0,
          model.categoryOffsets[item + 1] ?? 0,
        ),
      ),
    );
  }
  return output;
}

function splitMatrix(values: Float64Array, rows: number, columns: number): number[][] {
  const output: number[][] = [];
  for (let row = 0; row < rows; row += 1) {
    output.push(Array.from(values.subarray(row * columns, (row + 1) * columns)));
  }
  return output;
}
