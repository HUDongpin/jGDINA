import { validateFitInput, type FitInput } from "@jgdina/core";
import { describe, expect, it } from "vitest";
import { evaluateValidated } from "../src/index.js";

const input: FitInput = {
  estimation: { initialization: { starts: 1 } },
  model: ["DINA", "DINA"],
  prior: { probabilities: [0.4, 0.6], type: "fixed" },
  qMatrix: [[1], [1]],
  responses: [
    [1, 0],
    [0, 1],
    [0, 0],
    [1, 1],
    [1, null],
  ],
};

describe("fixed-parameter evaluation", () => {
  it("matches hand-calculated likelihoods and posteriors", () => {
    const evaluation = evaluateValidated(
      validateFitInput(input),
      [
        [0.2, 0.8],
        [0.3, 0.7],
      ],
    );
    expect(evaluation.logLikelihoodByClass[0]?.[0]).toBeCloseTo(
      Math.log(0.2) + Math.log(0.7),
      14,
    );
    expect(evaluation.logLikelihoodByClass[0]?.[1]).toBeCloseTo(
      Math.log(0.8) + Math.log(0.3),
      14,
    );
    expect(evaluation.posteriorProbabilities[0]?.[0]).toBeCloseTo(0.28, 14);
    expect(evaluation.posteriorProbabilities[0]?.[1]).toBeCloseTo(0.72, 14);
    expect(evaluation.posteriorProbabilities[1]?.[0]).toBeCloseTo(0.096 / 0.18, 14);
    expect(evaluation.posteriorProbabilities[1]?.[1]).toBeCloseTo(0.084 / 0.18, 14);
    // Missing item 2 contributes exactly zero to the conditional log-likelihood.
    expect(evaluation.posteriorProbabilities[4]?.[0]).toBeCloseTo(1 / 7, 14);
    expect(evaluation.posteriorProbabilities[4]?.[1]).toBeCloseTo(6 / 7, 14);
    expect(evaluation.classSuccessProbabilities).toEqual([
      [0.2, 0.8],
      [0.3, 0.7],
    ]);
  });

  it("keeps every posterior row normalized", () => {
    const evaluation = evaluateValidated(
      validateFitInput(input),
      [
        [0.2, 0.8],
        [0.3, 0.7],
      ],
    );
    for (const posterior of evaluation.posteriorProbabilities) {
      expect(posterior.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 14);
    }
  });

  it("rejects exact-boundary supplied probabilities consistently with core bounds", () => {
    expect(() =>
      evaluateValidated(
        validateFitInput(input),
        [
          [0, 0.8],
          [0.3, 0.7],
        ],
      ),
    ).toThrow(/strictly between zero and one/);
  });
});
