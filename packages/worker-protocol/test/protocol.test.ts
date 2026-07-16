import { describe, expect, it } from "vitest";
import { validateFitInput, type FitResult } from "@jgdina/core";
import {
  packFitResult,
  packValidatedInput,
  unpackFitResult,
  unpackValidatedInput,
} from "../src/index.js";

describe("worker protocol", () => {
  it("round-trips normalized input through transferable typed arrays", () => {
    const validated = validateFitInput({
      responses: [
        [0, 1, Number.NaN],
        [1, 0, 1],
        [0, 0, 0],
        [1, 1, 1],
      ],
      qMatrix: [
        [1, 0],
        [0, 1],
        [1, 1],
      ],
      model: ["GDINA", "DINA", "DINO"],
      prior: { type: "fixed", probabilities: [0.1, 0.2, 0.3, 0.4] },
      estimation: { initialization: { starts: 1 } },
    });

    const packed = packValidatedInput(validated);
    expect(packed.responses).toBeInstanceOf(Float64Array);
    expect(packed.qMatrix).toBeInstanceOf(Uint8Array);
    expect(Number.isNaN(packed.responses[2])).toBe(true);
    expect(unpackValidatedInput(packed)).toEqual(validated);
  });

  it("moves JSON-safe results through one UTF-8 buffer", () => {
    const result = {
      schemaVersion: "1.0",
      backendId: "test",
      nested: { values: [0.1, 0.2, 0.3], missing: null },
    } as unknown as FitResult;
    const payload = packFitResult(result);
    expect(payload).toBeInstanceOf(Uint8Array);
    expect(unpackFitResult(payload)).toEqual(result);
  });
});
