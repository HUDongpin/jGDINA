import type { ValidatedFitInput } from "@jgdina/core";
import type { CompiledModel, ExpectationResult, ParameterState } from "./internal.js";

/**
 * Closed-form M-step used by GDINA's fast path. The correction is applied once
 * per freely estimated probability, followed by inclusive item bounds.
 */
export function maximizationStep(
  input: ValidatedFitInput,
  model: CompiledModel,
  state: ParameterState,
  expectation: ExpectationResult,
): number {
  const [lower, upper] = input.estimation.probabilityBounds;
  const [numeratorCorrection, denominatorCorrection] =
    input.estimation.smallSampleCorrection;
  let maximumChange = 0;

  for (let item = 0; item < model.items; item += 1) {
    const offset = model.categoryOffsets[item] ?? 0;
    const count = model.reducedClassCounts[item] ?? 0;
    const itemModel = model.models[item] ?? "GDINA";
    if (itemModel === "GDINA") {
      for (let category = 0; category < count; category += 1) {
        update(offset + category, offset + category);
      }
    } else if (itemModel === "DINA") {
      let expectedTotal = 0;
      let expectedCorrect = 0;
      for (let category = 0; category < count - 1; category += 1) {
        expectedTotal += expectation.expectedTotal[offset + category] ?? 0;
        expectedCorrect += expectation.expectedCorrect[offset + category] ?? 0;
      }
      const pooled = correctedProbability(expectedCorrect, expectedTotal);
      for (let category = 0; category < count - 1; category += 1) {
        assign(offset + category, pooled);
      }
      update(offset + count - 1, offset + count - 1);
    } else {
      update(offset, offset);
      let expectedTotal = 0;
      let expectedCorrect = 0;
      for (let category = 1; category < count; category += 1) {
        expectedTotal += expectation.expectedTotal[offset + category] ?? 0;
        expectedCorrect += expectation.expectedCorrect[offset + category] ?? 0;
      }
      const pooled = correctedProbability(expectedCorrect, expectedTotal);
      for (let category = 1; category < count; category += 1) {
        assign(offset + category, pooled);
      }
    }
  }

  if (input.prior.type === "saturated") {
    const denominator = model.respondents;
    const updated = new Float64Array(model.classes);
    let total = 0;
    for (let latentClass = 0; latentClass < model.classes; latentClass += 1) {
      const next = Math.max(
        Number.MIN_VALUE,
        (expectation.classCounts[latentClass] ?? 0) / denominator,
      );
      updated[latentClass] = next;
      total += next;
    }
    for (let latentClass = 0; latentClass < model.classes; latentClass += 1) {
      const next = (updated[latentClass] ?? Number.MIN_VALUE) / total;
      const previous = state.classProbabilities[latentClass] ?? 0;
      maximumChange = Math.max(maximumChange, Math.abs(next - previous));
      state.classProbabilities[latentClass] = next;
    }
  }
  return maximumChange;

  function correctedProbability(expectedCorrect: number, expectedTotal: number): number {
    const raw =
      (expectedCorrect + numeratorCorrection) /
      (expectedTotal + denominatorCorrection);
    return Math.max(lower, Math.min(upper, raw));
  }

  function update(target: number, source: number): void {
    assign(
      target,
      correctedProbability(
        expectation.expectedCorrect[source] ?? 0,
        expectation.expectedTotal[source] ?? 0,
      ),
    );
  }

  function assign(index: number, next: number): void {
    const previous = state.itemProbabilities[index] ?? 0;
    maximumChange = Math.max(maximumChange, Math.abs(next - previous));
    state.itemProbabilities[index] = next;
  }
}
