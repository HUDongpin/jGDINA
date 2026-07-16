import {
  FitAbortedError,
  assertValidBackendResult,
  validateFitInput,
  type FitInput,
  type FitProgress,
} from "@jgdina/core";
import { describe, expect, it } from "vitest";
import {
  Xoshiro128StarStar,
  attributePatterns,
  fitValidated,
  jsBackend,
  parameterLocations,
} from "../src/index.js";

describe("pure TypeScript EM backend", () => {
  it("fits mixed GDINA/DINA/DINO items deterministically and returns JSON-safe scores", () => {
    const validated = validateFitInput(simulatedInput(true));
    const first = fitValidated(validated);
    const second = fitValidated(validated);
    expect(second).toEqual(first);
    expect(first.backendId).toBe("js");
    expect(first.estimates.classProbabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(first.estimates.items[2]?.groupSuccessProbabilities[1]).toBe(
      first.estimates.items[2]?.groupSuccessProbabilities[3],
    );
    for (const posterior of first.scores.posteriorProbabilities ?? []) {
      expect(posterior.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    }
    const selected = first.convergence.starts.filter((start) => start.selectedForEstimation);
    expect(selected).toHaveLength(1);
    const initialMaximum = Math.max(
      ...first.convergence.starts.map((start) => start.initialLogLikelihood),
    );
    expect(selected[0]?.initialLogLikelihood).toBe(initialMaximum);
    expect(
      first.convergence.starts
        .filter((start) => !start.selectedForEstimation)
        .every((start) => start.reason === "not-selected" && start.iterations === 0),
    ).toBe(true);

    expect(first.statistics.deviance).toBeCloseTo(-2 * first.statistics.logLikelihood, 12);
    expect(first.statistics.aic).toBeCloseTo(
      first.statistics.deviance + 2 * first.statistics.estimatedParameterCount,
      12,
    );
    const parameterCount = first.statistics.estimatedParameterCount;
    expect(first.statistics.aicc).toBeCloseTo(
      first.statistics.aic +
        (2 * parameterCount * (parameterCount + 1)) /
          (first.dimensions.respondents - parameterCount - 1),
      12,
    );
    assertValidBackendResult(first, validated, "js");
    expect(() => JSON.stringify(first)).not.toThrow();
  });

  it("produces equivalent estimates with and without row aggregation", () => {
    const aggregated = fitValidated(validateFitInput(simulatedInput(true)));
    const raw = fitValidated(validateFitInput(simulatedInput(false)));
    expect(raw.statistics.logLikelihood).toBeCloseTo(aggregated.statistics.logLikelihood, 9);
    raw.estimates.classProbabilities.forEach((value, index) =>
      expect(value).toBeCloseTo(aggregated.estimates.classProbabilities[index] ?? 0, 10),
    );
    raw.estimates.items.forEach((item, itemIndex) =>
      item.groupSuccessProbabilities.forEach((value, group) =>
        expect(value).toBeCloseTo(
          aggregated.estimates.items[itemIndex]?.groupSuccessProbabilities[group] ?? 0,
          10,
        ),
      ),
    );
  });

  it("supports scores-only mode without changing classifications", () => {
    const full = fitValidated(validateFitInput(simulatedInput(true, "full")));
    const scoresOnly = fitValidated(validateFitInput(simulatedInput(true, "scores-only")));
    expect(scoresOnly.scores.posteriorProbabilities).toBeNull();
    expect(scoresOnly.scores.mapClassIndices).toEqual(full.scores.mapClassIndices);
    expect(scoresOnly.scores.mleClassIndices).toEqual(full.scores.mleClassIndices);
    expect(scoresOnly.scores.eapAttributeProbabilities).toEqual(
      full.scores.eapAttributeProbabilities,
    );
  });

  it("applies GDINA small-sample correction before bounds", () => {
    const validated = validateFitInput({
      estimation: {
        initialization: { initialItemProbabilities: [[0.2, 0.8]], starts: 1 },
        maxIterations: 1,
        probabilityBounds: [0.000001, 0.999999],
        smallSampleCorrection: [0.0005, 0.001],
      },
      model: "GDINA",
      prior: { probabilities: [0.5, 0.5], type: "fixed" },
      qMatrix: [[1]],
      responses: [[0], [1], [0], [1]],
    });
    const result = fitValidated(validated);
    expect(result.estimates.items[0]?.groupSuccessProbabilities[0]).toBeCloseTo(
      0.4005 / 2.001,
      12,
    );
    expect(result.estimates.items[0]?.groupSuccessProbabilities[1]).toBeCloseTo(
      1.6005 / 2.001,
      12,
    );
    expect(result.estimates.classProbabilities).toEqual([0.5, 0.5]);
  });

  it("returns null when the conventional AICc denominator is undefined", () => {
    const result = fitValidated(
      validateFitInput({
        model: "DINA",
        qMatrix: [[1]],
        responses: [[0], [1]],
        estimation: { initialization: { starts: 1 }, maxIterations: 2 },
      }),
    );
    expect(result.statistics.aicc).toBeNull();
  });

  it("has nondecreasing ML iteration likelihood with negligible correction", () => {
    const source = simulatedInput(true);
    const validated = validateFitInput({
      ...source,
      estimation: {
        ...source.estimation,
        initialization: { seed: 55, starts: 1 },
        smallSampleCorrection: [0, 1e-12],
      },
    });
    const likelihoods: number[] = [];
    const onProgress = (progress: FitProgress): void => {
      if (progress.phase === "estimation" && progress.logLikelihood !== undefined) {
        likelihoods.push(progress.logLikelihood);
      }
    };
    const result = fitValidated(validated, { onProgress });
    likelihoods.push(result.statistics.logLikelihood);
    for (let index = 1; index < likelihoods.length; index += 1) {
      expect((likelihoods[index] ?? 0) + 1e-8).toBeGreaterThanOrEqual(likelihoods[index - 1] ?? 0);
    }
  });

  it("scores an all-missing row as prior-only and flags the MLE tie", () => {
    const input = simulatedInput(true);
    const responses = [...input.responses, Array<null>(6).fill(null)];
    const result = fitValidated(validateFitInput({ ...input, responses }));
    const last = responses.length - 1;
    result.scores.posteriorProbabilities?.[last]?.forEach((value, latentClass) =>
      expect(value).toBeCloseTo(result.estimates.classProbabilities[latentClass] ?? 0, 14),
    );
    expect(result.scores.mleClassIndices[last]).toBe(0);
    expect(result.scores.mleHasTies[last]).toBe(true);
  });

  it("honors cancellation and exposes the FitBackend contract", () => {
    const validated = validateFitInput(simulatedInput(true));
    expect(jsBackend.id).toBe("js");
    expect(() => fitValidated(validated, { signal: { aborted: true } })).toThrow(
      FitAbortedError,
    );
  });

  it("floors and renormalizes underflowed saturated classes but leaves fixed zeros", () => {
    const base: FitInput = {
      estimation: {
        initialization: { initialItemProbabilities: [[0.2, 0.8]], starts: 1 },
        maxIterations: 1,
      },
      model: "GDINA",
      qMatrix: [[1]],
      responses: [[0], [1], [0], [1]],
    };
    const saturated = fitValidated(
      validateFitInput({
        ...base,
        prior: { initialProbabilities: [1, 0], type: "saturated" },
      }),
    );
    expect(saturated.estimates.classProbabilities[1]).toBe(Number.MIN_VALUE);
    expect(saturated.estimates.classProbabilities.every((value) => value > 0)).toBe(true);
    expect(
      saturated.estimates.classProbabilities.reduce((sum, value) => sum + value, 0),
    ).toBe(1);

    const fixed = fitValidated(
      validateFitInput({
        ...base,
        prior: { probabilities: [1, 0], type: "fixed" },
      }),
    );
    expect(fixed.estimates.classProbabilities).toEqual([1, 0]);
  });
});

function simulatedInput(
  aggregateRows: boolean,
  posteriorStorage: "full" | "scores-only" = "full",
): FitInput {
  const qMatrix = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, 1],
    [1, 0],
    [0, 1],
  ] as const;
  const models = ["GDINA", "DINA", "DINO", "GDINA", "DINA", "DINO"] as const;
  const reduced = [
    [0.12, 0.82],
    [0.18, 0.77],
    [0.08, 0.84],
    [0.1, 0.36, 0.53, 0.9],
    [0.22, 0.74],
    [0.16, 0.79],
  ];
  const patterns = attributePatterns(2);
  const locations = parameterLocations(qMatrix, patterns);
  const priors = [0.32, 0.18, 0.2, 0.3];
  const random = new Xoshiro128StarStar(8_421);
  const responses: (0 | 1)[][] = [];
  for (let person = 0; person < 500; person += 1) {
    const draw = random.next();
    let cumulative = 0;
    let latentClass = priors.length - 1;
    for (let index = 0; index < priors.length; index += 1) {
      cumulative += priors[index] ?? 0;
      if (draw < cumulative) {
        latentClass = index;
        break;
      }
    }
    responses.push(
      reduced.map((item, itemIndex) =>
        random.next() < (item[locations[itemIndex]?.[latentClass] ?? 0] ?? 0) ? 1 : 0,
      ),
    );
  }
  return {
    estimation: {
      aggregateRows,
      convergenceTolerance: 1e-7,
      initialization: { seed: 19_871, starts: 3 },
      maxIterations: 500,
      posteriorStorage,
    },
    model: models,
    qMatrix,
    responses,
  };
}
