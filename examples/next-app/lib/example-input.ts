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
