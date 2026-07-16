import { describe, expect, it } from "vitest";

import {
  InputValidationError,
  ResourceLimitError,
  validateFitInput,
  type FitInput,
} from "../src/index.js";

function validInput(): FitInput {
  return {
    responses: [
      [0, 0, 1],
      [1, 1, 0],
      [0, 1, Number.NaN],
      [1, 0, null],
    ],
    qMatrix: [
      [1, 0],
      [0, 1],
      [1, 1],
    ],
    model: ["GDINA", "DINA", "DINO"],
  };
}

describe("validateFitInput", () => {
  it("normalizes missing values, expands defaults, and returns defensive arrays", () => {
    const input = validInput();
    const validated = validateFitInput(input);

    expect(validated.responses[2]?.[2]).toBeNull();
    expect(validated.responses[3]?.[2]).toBeNull();
    expect(validated.missingResponseCount).toBe(2);
    expect(validated.models).toEqual(["GDINA", "DINA", "DINO"]);
    expect(validated.prior).toEqual({ type: "saturated", initialProbabilities: null });
    expect(validated.dimensions).toEqual({
      respondents: 4,
      items: 3,
      attributes: 2,
      latentClasses: 4,
    });
    expect(validated.estimation).toMatchObject({
      maxIterations: 2_000,
      convergenceTolerance: 1e-4,
      probabilityBounds: [1e-4, 0.9999],
      smallSampleCorrection: [0.0005, 0.001],
      initialization: {
        strategy: "deterministic",
        starts: 3,
        seed: 123_456,
        initialItemProbabilities: null,
        initialItemProbabilityCandidates: null,
      },
      aggregateRows: true,
      posteriorStorage: "full",
      blockSize: 256,
    });
    expect(validated.responses).not.toBe(input.responses);
    expect(validated.qMatrix).not.toBe(input.qMatrix);
    expect(validated.memoryEstimate.dimensions).toEqual(validated.dimensions);
    expect(validated.memoryEstimate.assumptions).toMatchObject({
      starts: 3,
      suppliedCandidateCount: 0,
      totalReducedClasses: 8,
      totalRequiredAttributes: 4,
      uniqueResponsePatterns: 4,
    });
  });

  it("expands a scalar model and validates fixed priors", () => {
    const validated = validateFitInput({
      ...validInput(),
      model: "DINA",
      prior: { type: "fixed", probabilities: [0.1, 0.2, 0.3, 0.4] },
    });

    expect(validated.models).toEqual(["DINA", "DINA", "DINA"]);
    expect(validated.prior).toEqual({
      type: "fixed",
      probabilities: [0.1, 0.2, 0.3, 0.4],
    });
  });

  it("accepts valid supplied reduced-group probabilities as deterministic start 0", () => {
    const validated = validateFitInput({
      ...validInput(),
      estimation: {
        initialization: {
          starts: 4,
          seed: 7,
          initialItemProbabilities: [
            [0.1, 0.8],
            [0.2, 0.7],
            [0.3, 0.9],
          ],
        },
      },
    });

    expect(validated.estimation.initialization).toEqual({
      strategy: "deterministic",
      starts: 4,
      seed: 7,
      initialItemProbabilities: [
        [0.1, 0.8],
        [0.2, 0.7],
        [0.3, 0.9],
      ],
      initialItemProbabilityCandidates: null,
    });
  });

  it("accepts explicit candidates, derives starts, and allows tied full DINO groups", () => {
    const candidates = [
      [
        [0.1, 0.8],
        [0.2, 0.7],
        [0.3, 0.9, 0.9, 0.9],
      ],
      [
        [0.15, 0.75],
        [0.25, 0.65],
        [0.35, 0.85],
      ],
    ];
    const validated = validateFitInput({
      ...validInput(),
      estimation: {
        initialization: {
          // Explicit candidates take precedence; this legacy value is ignored.
          initialItemProbabilities: [[2], [2], [2]],
          initialItemProbabilityCandidates: candidates,
          seed: 9,
        },
      },
    });

    expect(validated.estimation.initialization).toEqual({
      strategy: "deterministic",
      starts: 2,
      seed: 9,
      initialItemProbabilities: null,
      initialItemProbabilityCandidates: candidates,
    });
    expect(validated.memoryEstimate.assumptions).toMatchObject({
      starts: 2,
      suppliedCandidateCount: 2,
      totalReducedClasses: 8,
    });
  });

  it("requires starts to cover every explicit candidate", () => {
    expectValidationIssue(
      {
        ...validInput(),
        estimation: {
          initialization: {
            starts: 1,
            initialItemProbabilityCandidates: [
              [[0.1, 0.8], [0.2, 0.7], [0.3, 0.9]],
              [[0.15, 0.75], [0.25, 0.65], [0.35, 0.85]],
            ],
          },
        },
      },
      "estimation.initialization.starts",
    );
  });

  it("rejects untied full DINO candidate probabilities", () => {
    expectValidationIssue(
      {
        ...validInput(),
        estimation: {
          initialization: {
            initialItemProbabilityCandidates: [
              [[0.1, 0.8], [0.2, 0.7], [0.3, 0.8, 0.9, 0.9]],
            ],
          },
        },
      },
      "estimation.initialization.initialItemProbabilityCandidates[0][2]",
    );
  });

  it("requires 2^Kj supplied probabilities for a GDINA item", () => {
    const input = validInput();
    expectValidationIssue(
      {
        ...input,
        model: ["DINA", "DINA", "GDINA"],
        estimation: {
          initialization: {
            initialItemProbabilities: [
              [0.1, 0.8],
              [0.2, 0.7],
              [0.3, 0.9],
            ],
          },
        },
      },
      "estimation.initialization.initialItemProbabilities[2]",
    );
  });

  it.each([
    {
      name: "non-binary responses",
      mutate: (input: FitInput) => ({ ...input, responses: [[0, 0, 1], [1, 2, 0]] }),
      path: "responses[1][1]",
    },
    {
      name: "ragged responses",
      mutate: (input: FitInput) => ({ ...input, responses: [[0, 1], [1]] }),
      path: "responses[1]",
    },
    {
      name: "response/Q item mismatch",
      mutate: (input: FitInput) => ({ ...input, qMatrix: [[1, 0], [0, 1]] }),
      path: "qMatrix",
    },
    {
      name: "an item requiring no attributes",
      mutate: (input: FitInput) => ({
        ...input,
        qMatrix: [[0, 0], [0, 1], [1, 1]],
      }),
      path: "qMatrix[0]",
    },
    {
      name: "an unused attribute",
      mutate: (input: FitInput) => ({
        ...input,
        qMatrix: [[1, 0], [1, 0], [1, 0]],
      }),
      path: "qMatrix[*][1]",
    },
    {
      name: "a degenerate response item",
      mutate: (input: FitInput) => ({
        ...input,
        responses: [
          [0, 0, 1],
          [1, 0, 0],
          [0, 0, 1],
          [1, null, 0],
        ],
      }),
      path: "responses[*][1]",
    },
    {
      name: "an unsupported model",
      mutate: (input: FitInput) => ({ ...input, model: "ACDM" as never }),
      path: "model",
    },
    {
      name: "a prior with the wrong length",
      mutate: (input: FitInput) => ({
        ...input,
        prior: { type: "fixed", probabilities: [0.5, 0.5] },
      }),
      path: "prior.probabilities",
    },
    {
      name: "a prior that does not sum to one",
      mutate: (input: FitInput) => ({
        ...input,
        prior: { type: "fixed", probabilities: [0.1, 0.1, 0.1, 0.1] },
      }),
      path: "prior.probabilities",
    },
    {
      name: "an invalid small-sample correction",
      mutate: (input: FitInput) => ({
        ...input,
        estimation: { smallSampleCorrection: [0.0005, 0] },
      }),
      path: "estimation.smallSampleCorrection",
    },
    {
      name: "probability bounds touching exact zero and one",
      mutate: (input: FitInput) => ({
        ...input,
        estimation: { probabilityBounds: [0, 1] },
      }),
      path: "estimation.probabilityBounds",
    },
    {
      name: "a supplied item probability outside estimation bounds",
      mutate: (input: FitInput) => ({
        ...input,
        estimation: {
          probabilityBounds: [0.1, 0.9],
          initialization: {
            initialItemProbabilities: [
              [0.05, 0.8],
              [0.2, 0.7],
              [0.3, 0.9],
            ],
          },
        },
      }),
      path: "estimation.initialization.initialItemProbabilities[0][0]",
    },
  ])("rejects $name", ({ mutate, path }) => {
    expectValidationIssue(mutate(validInput()) as FitInput, path);
  });

  it("enforces configured dimension, memory, start, and iteration limits", () => {
    expect(() =>
      validateFitInput({
        ...validInput(),
        estimation: { resourceLimits: { maxAttributes: 1 } },
      }),
    ).toThrowError(ResourceLimitError);

    expect(() =>
      validateFitInput({
        ...validInput(),
        estimation: { resourceLimits: { maxEstimatedBytes: 1 } },
      }),
    ).toThrowError(ResourceLimitError);

    expect(() =>
      validateFitInput({
        ...validInput(),
        estimation: {
          initialization: { starts: 3 },
          resourceLimits: { maxStarts: 2 },
        },
      }),
    ).toThrowError(ResourceLimitError);

    expect(() =>
      validateFitInput({
        ...validInput(),
        estimation: {
          maxIterations: 3,
          resourceLimits: { maxIterations: 2 },
        },
      }),
    ).toThrowError(ResourceLimitError);
  });

  it("rejects oversized dimensions before copying response cells", () => {
    let cellReads = 0;
    const guardedRow = new Proxy([0, 0, 1] as const, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) cellReads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    expect(() =>
      validateFitInput({
        ...validInput(),
        responses: [guardedRow, guardedRow, guardedRow, guardedRow],
        estimation: { resourceLimits: { maxRespondents: 3 } },
      }),
    ).toThrowError(ResourceLimitError);
    expect(cellReads).toBe(0);
  });
});

function expectValidationIssue(input: FitInput, path: string): void {
  try {
    validateFitInput(input);
    throw new Error("Expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(InputValidationError);
    expect((error as InputValidationError).issues.some((issue) => issue.path === path)).toBe(true);
  }
}
