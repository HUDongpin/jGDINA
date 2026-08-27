import type { ItemModel, ValidatedFitInput } from "@jgdina/core";
import { deltaToProbabilities } from "./helpers.js";
import type { CompiledModel, ParameterState } from "./internal.js";
import { deriveStartSeed, Xoshiro128StarStar } from "./random.js";

export function initialState(
  input: ValidatedFitInput,
  model: CompiledModel,
  startIndex: number,
): ParameterState {
  const [lower, upper] = input.estimation.probabilityBounds;
  const itemProbabilities = new Float64Array(model.totalReducedClasses);
  const supplied =
    input.estimation.initialization.initialItemProbabilityCandidates?.[startIndex] ??
    (startIndex === 0 ? input.estimation.initialization.initialItemProbabilities : null);

  for (let item = 0; item < model.items; item += 1) {
    const offset = model.categoryOffsets[item] ?? 0;
    const count = model.reducedClassCounts[item] ?? 0;
    const itemModel = model.models[item] ?? "GDINA";
    const suppliedItem = supplied?.[item];
    const values =
      suppliedItem === undefined
        ? randomItemProbabilities(
            count,
            itemModel,
            lower,
            upper,
            new Xoshiro128StarStar(
              deriveStartSeed(input.estimation.initialization.seed, startIndex * model.items + item),
            ),
          )
        : expandProbabilities(suppliedItem, count, itemModel);
    for (let category = 0; category < count; category += 1) {
      itemProbabilities[offset + category] = values[category] ?? lower;
    }
  }

  let classProbabilities: Float64Array;
  if (input.prior.type === "fixed") {
    classProbabilities = Float64Array.from(input.prior.probabilities);
  } else if (input.prior.initialProbabilities !== null) {
    classProbabilities = Float64Array.from(input.prior.initialProbabilities);
  } else {
    classProbabilities = new Float64Array(model.classes);
    classProbabilities.fill(1 / model.classes);
  }
  normalizeInPlace(classProbabilities);
  return { classProbabilities, itemProbabilities };
}

export function expandProbabilities(
  values: readonly number[],
  reducedClassCount: number,
  model: ItemModel,
): number[] {
  if (model === "GDINA") {
    if (values.length !== reducedClassCount) {
      throw new RangeError(`GDINA initial probabilities must contain ${reducedClassCount} values`);
    }
    return Array.from(values);
  }
  if (values.length === reducedClassCount) {
    const expanded = Array.from(values);
    if (model === "DINA") {
      assertEqualRange(expanded, 0, reducedClassCount - 1, "DINA non-master groups");
    } else {
      assertEqualRange(expanded, 1, reducedClassCount, "DINO master groups");
    }
    return expanded;
  }
  if (values.length !== 2) throw new RangeError(`${model} initial probabilities must contain 2 values`);
  const lowerGroup = values[0] ?? 0;
  const upperGroup = values[1] ?? 0;
  if (model === "DINA") {
    return Array.from({ length: reducedClassCount }, (_, index) =>
      index === reducedClassCount - 1 ? upperGroup : lowerGroup,
    );
  }
  return Array.from({ length: reducedClassCount }, (_, index) =>
    index === 0 ? lowerGroup : upperGroup,
  );
}

function assertEqualRange(
  values: readonly number[],
  start: number,
  end: number,
  label: string,
): void {
  const reference = values[start];
  for (let index = start + 1; index < end; index += 1) {
    if (values[index] !== reference) throw new RangeError(`${label} must have tied probabilities`);
  }
}

function randomItemProbabilities(
  reducedClassCount: number,
  model: ItemModel,
  lower: number,
  upper: number,
  random: Xoshiro128StarStar,
): number[] {
  const span = upper - lower;
  const guessing = lower + span * (0.05 + random.next() * 0.2);
  const mastery = upper - span * (0.05 + random.next() * 0.2);
  if (model === "DINA") {
    return Array.from({ length: reducedClassCount }, (_, index) =>
      index === reducedClassCount - 1 ? mastery : guessing,
    );
  }
  if (model === "DINO") {
    return Array.from({ length: reducedClassCount }, (_, index) =>
      index === 0 ? guessing : mastery,
    );
  }

  const delta = new Float64Array(reducedClassCount);
  delta[0] = guessing;
  let weightSum = 0;
  for (let index = 1; index < reducedClassCount; index += 1) {
    const weight = 0.001 + random.next();
    delta[index] = weight;
    weightSum += weight;
  }
  for (let index = 1; index < reducedClassCount; index += 1) {
    delta[index] = ((delta[index] ?? 0) / weightSum) * (mastery - guessing);
  }
  return deltaToProbabilities(Array.from(delta), Math.log2(reducedClassCount), "GDINA");
}

export function normalizeInPlace(values: Float64Array): void {
  let total = 0;
  for (const value of values) total += value;
  if (!(total > 0) || !Number.isFinite(total)) throw new RangeError("probabilities must have positive sum");
  for (let index = 0; index < values.length; index += 1) {
    values[index] = (values[index] ?? 0) / total;
  }
}
