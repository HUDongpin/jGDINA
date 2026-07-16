import type { FitInput } from "@jgdina/core";

export const exampleInput: FitInput = {
  responses: [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
    [1, 1],
    [0, 0],
  ],
  qMatrix: [[1], [1]],
  model: "DINA",
  estimation: {
    initialization: { starts: 2, seed: 2026 },
  },
};

/**
 * Builds a deterministic workload that remains active long enough to exercise
 * real Web Worker cancellation in the production example. It is intentionally
 * created only when the cancellation-demo button is used; the normal example
 * and the library's resource limits are unchanged.
 */
export function createCancellationDemoInput(): FitInput {
  const respondents = 5_000;
  const items = 24;
  const attributes = 8;
  let state = 0x6d2b79f5;

  const nextBit = (): 0 | 1 => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 31) as 0 | 1;
  };

  const responses = Array.from({ length: respondents }, () =>
    Array.from({ length: items }, nextBit),
  );
  const qMatrix = Array.from({ length: items }, (_, itemIndex) =>
    Array.from({ length: attributes }, (_, attributeIndex) =>
      attributeIndex === itemIndex % attributes ||
      attributeIndex === (itemIndex + 1) % attributes ||
      attributeIndex === (itemIndex + 3) % attributes
        ? 1
        : 0,
    ),
  );

  return {
    responses,
    qMatrix,
    model: "GDINA",
    estimation: {
      aggregateRows: false,
      convergenceTolerance: 1e-14,
      maxIterations: 100_000,
      posteriorStorage: "scores-only",
      initialization: { starts: 16, seed: 2026 },
    },
  };
}
