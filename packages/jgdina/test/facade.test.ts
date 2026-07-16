import { describe, expect, it } from "vitest";
import { FitAbortedError, createJGDINA, fit, jgdina } from "../src/index.js";

const input = {
  responses: [
    [0, 0, 0],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 0],
    [1, 0, null],
    [0, 1, 0],
  ],
  qMatrix: [
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  model: ["DINA", "DINO", "GDINA"],
  estimation: {
    maxIterations: 100,
    convergenceTolerance: 1e-6,
    initialization: { starts: 1, seed: 9 },
  },
} as const;

describe("jgdina facade", () => {
  it("fits through the default pure TypeScript backend", async () => {
    const result = await fit(input);
    expect(jgdina.backendId).toBe("js");
    expect(result.backendId).toBe("js");
    expect(result.dimensions).toEqual({
      respondents: 6,
      items: 3,
      attributes: 2,
      latentClasses: 4,
    });
    expect(result.estimates.items).toHaveLength(3);
    expect(result.scores.posteriorProbabilities).toHaveLength(6);
    expect(result.scores.mapClassIndices).toHaveLength(6);
    expect(Number.isFinite(result.statistics.logLikelihood)).toBe(true);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("creates independent engines and respects pre-aborted signals", async () => {
    const engine = createJGDINA();
    await expect(
      engine.fit(input, { signal: { aborted: true } }),
    ).rejects.toBeInstanceOf(FitAbortedError);
  });
});
