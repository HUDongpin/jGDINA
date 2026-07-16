import { describe, expect, it } from "vitest";
import {
  Xoshiro128StarStar,
  aggregateResponseRows,
  attributePatterns,
  classSuccessProbabilities,
  deltaToProbabilities,
  itemDesignMatrix,
  parameterLocations,
  probabilitiesToDelta,
} from "../src/index.js";

describe("GDINA indexing and design helpers", () => {
  it("matches alpha2 ordering", () => {
    expect(attributePatterns(3)).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 1, 0],
      [1, 0, 1],
      [0, 1, 1],
      [1, 1, 1],
    ]);
  });

  it("constructs GDINA, DINA, and DINO designs in canonical order", () => {
    expect(itemDesignMatrix(2, "GDINA")).toEqual([
      [1, 0, 0, 0],
      [1, 1, 0, 0],
      [1, 0, 1, 0],
      [1, 1, 1, 1],
    ]);
    expect(itemDesignMatrix(2, "DINA")).toEqual([
      [1, 0],
      [1, 0],
      [1, 0],
      [1, 1],
    ]);
    expect(itemDesignMatrix(2, "DINO")).toEqual([
      [1, 0],
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
  });

  it("maps global classes to item-reduced groups", () => {
    const q = [
      [1, 0, 1],
      [0, 1, 0],
    ] as const;
    expect(parameterLocations(q)).toEqual([
      [0, 1, 0, 2, 1, 3, 2, 3],
      [0, 0, 1, 0, 1, 0, 1, 1],
    ]);
  });

  it("round-trips saturated delta parameters over several attribute counts", () => {
    const random = new Xoshiro128StarStar(91_827);
    for (let attributes = 1; attributes <= 5; attributes += 1) {
      const probabilities = Array.from(
        { length: 2 ** attributes },
        () => 0.05 + 0.9 * random.next(),
      );
      const delta = probabilitiesToDelta(probabilities, "GDINA");
      const reconstructed = deltaToProbabilities(delta, attributes, "GDINA");
      reconstructed.forEach((value, index) =>
        expect(value).toBeCloseTo(probabilities[index] ?? 0, 12),
      );
    }
  });

  it("scales the Möbius transform to K=15 without constructing a square design", () => {
    const attributes = 15;
    const delta = Array<number>(2 ** attributes).fill(0);
    delta[0] = 0.1;
    for (let mainEffect = 1; mainEffect <= attributes; mainEffect += 1) {
      delta[mainEffect] = 0.01;
    }
    const probabilities = deltaToProbabilities(delta, attributes, "GDINA");
    const recovered = probabilitiesToDelta(probabilities, "GDINA");
    expect(probabilities).toHaveLength(2 ** attributes);
    expect(Math.max(...probabilities)).toBeCloseTo(0.25, 12);
    let maximumError = 0;
    recovered.forEach((value, index) => {
      maximumError = Math.max(maximumError, Math.abs(value - (delta[index] ?? 0)));
    });
    expect(maximumError).toBeLessThan(1e-11);
  });

  it("expands reduced probabilities into global class probabilities", () => {
    expect(
      classSuccessProbabilities(
        [
          [0.1, 0.8],
          [0.2, 0.4, 0.6, 0.9],
        ],
        [
          [0, 1, 0, 1],
          [0, 1, 2, 3],
        ],
      ),
    ).toEqual([
      [0.1, 0.8, 0.1, 0.8],
      [0.2, 0.4, 0.6, 0.9],
    ]);
  });
});

describe("row aggregation", () => {
  it("uses a missing-safe key and restores the original mapping", () => {
    const result = aggregateResponseRows([
      [1, null, 0],
      [1, Number.NaN, 0],
      [1, 0, 0],
      [0, 1, 1],
    ]);
    expect(result.responses).toEqual([
      [1, null, 0],
      [1, 0, 0],
      [0, 1, 1],
    ]);
    expect(result.frequencies).toEqual([2, 1, 1]);
    expect(result.originalToUnique).toEqual([0, 0, 1, 2]);
  });
});

describe("deterministic random generator", () => {
  it("is reproducible and seed-sensitive", () => {
    const a = new Xoshiro128StarStar(123);
    const b = new Xoshiro128StarStar(123);
    const c = new Xoshiro128StarStar(124);
    const sequenceA = Array.from({ length: 10 }, () => a.nextUint32());
    expect(Array.from({ length: 10 }, () => b.nextUint32())).toEqual(sequenceA);
    expect(Array.from({ length: 10 }, () => c.nextUint32())).not.toEqual(sequenceA);
  });
});
