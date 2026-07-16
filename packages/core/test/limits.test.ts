import { describe, expect, it } from "vitest";

import {
  DEFAULT_MEMORY_SAFETY_FACTOR,
  DEFAULT_RESOURCE_LIMITS,
  MEBIBYTE,
  ResourceLimitError,
  assertWithinResourceLimits,
  estimateFitMemory,
  formatBytes,
  resolveResourceLimits,
} from "../src/index.js";

const detailedRequest = {
  respondents: 10,
  items: 3,
  attributes: 2,
  reducedClassCounts: [2, 2, 4],
  starts: 2,
  suppliedCandidateCount: 1,
  posteriorStorage: "full" as const,
  workerTransport: true,
};

describe("estimateFitMemory", () => {
  it("reports implementation allocations and exact transferable buffers", () => {
    const estimate = estimateFitMemory({ ...detailedRequest, safetyFactor: 1 });

    expect(estimate.dimensions.latentClasses).toBe(4);
    expect(estimate.breakdown.packedTransport).toBe(10 * 3 * 8 + 3 * 2);
    expect(estimate.breakdown.workerUnpackedInput).toBeGreaterThan(
      estimate.breakdown.packedTransport,
    );
    expect(estimate.assumptions).toMatchObject({
      blockSizeAffectsMemory: false,
      maxReducedClassesPerItem: 4,
      starts: 2,
      suppliedCandidateCount: 1,
      totalReducedClasses: 8,
      totalRequiredAttributes: 4,
      uniqueResponsePatterns: 10,
      workerTransport: true,
    });
    const { overhead, ...modeled } = estimate.breakdown;
    expect(overhead).toBe(0);
    expect(Object.values(modeled).reduce((sum, bytes) => sum + bytes, 0)).toBe(
      estimate.rawBytes,
    );
    expect(estimate.estimatedBytes).toBe(estimate.rawBytes);
  });

  it("does not pretend blockSize allocates row blocks", () => {
    const one = estimateFitMemory({ ...detailedRequest, blockSize: 1, safetyFactor: 1 });
    const many = estimateFitMemory({ ...detailedRequest, blockSize: 10_000, safetyFactor: 1 });

    expect(many.breakdown).toEqual(one.breakdown);
    expect(many.rawBytes).toBe(one.rawBytes);
    expect(many.estimatedBytes).toBe(one.estimatedBytes);
    expect(one.assumptions.blockSize).toBe(1);
    expect(many.assumptions.blockSize).toBe(10);
  });

  it("retains one candidate state plus lightweight summaries", () => {
    const one = estimateFitMemory({
      ...detailedRequest,
      starts: 1,
      suppliedCandidateCount: 0,
      safetyFactor: 1,
    });
    const four = estimateFitMemory({
      ...detailedRequest,
      starts: 4,
      suppliedCandidateCount: 0,
      safetyFactor: 1,
    });
    const expectedDelta = 8 * (8 + 4) + 3 * (32 + 4 * 8);
    expect(four.breakdown.startStates - one.breakdown.startStates).toBe(expectedDelta);
    expect(four.estimatedBytes).toBeGreaterThan(one.estimatedBytes);
  });

  it("includes posterior arrays and their worker JSON serialization", () => {
    const full = estimateFitMemory({ ...detailedRequest, safetyFactor: 1 });
    const scoresOnly = estimateFitMemory({
      ...detailedRequest,
      posteriorStorage: "scores-only",
      safetyFactor: 1,
    });
    const posteriorBytes = 10 * 4 * 8 + (10 + 1) * 32;
    const serializationDelta = 3 * (10 * 4 * 26 + 10 * 2) + posteriorBytes;

    expect(scoresOnly.breakdown.posterior).toBe(0);
    expect(full.breakdown.posterior).toBe(posteriorBytes);
    expect(
      full.breakdown.resultSerialization - scoresOnly.breakdown.resultSerialization,
    ).toBe(serializationDelta);
    expect(full.estimatedBytes - scoresOnly.estimatedBytes).toBeGreaterThan(
      posteriorBytes,
    );
  });

  it("can omit worker transport for direct-kernel planning", () => {
    const worker = estimateFitMemory({ ...detailedRequest, safetyFactor: 1 });
    const direct = estimateFitMemory({
      ...detailedRequest,
      workerTransport: false,
      safetyFactor: 1,
    });

    expect(direct.breakdown.packedTransport).toBe(0);
    expect(direct.breakdown.workerUnpackedInput).toBe(0);
    expect(direct.breakdown.resultSerialization).toBe(0);
    expect(worker.estimatedBytes).toBeGreaterThan(direct.estimatedBytes);
  });

  it("uses a two-times default runtime/object reserve", () => {
    const estimate = estimateFitMemory(detailedRequest);
    expect(DEFAULT_MEMORY_SAFETY_FACTOR).toBe(2);
    expect(estimate.assumptions.safetyFactor).toBe(2);
    expect(estimate.breakdown.overhead).toBe(estimate.rawBytes);
    expect(estimate.estimatedBytes).toBe(2 * estimate.rawBytes);
  });

  it("uses Q-derived reduced counts and a worst-case fallback", () => {
    const detailed = estimateFitMemory({ ...detailedRequest, safetyFactor: 1 });
    const worstCase = estimateFitMemory({
      respondents: 10,
      items: 3,
      attributes: 2,
      starts: 2,
      suppliedCandidateCount: 1,
      posteriorStorage: "full",
      safetyFactor: 1,
    });
    expect(detailed.assumptions.totalReducedClasses).toBe(8);
    expect(worstCase.assumptions.totalReducedClasses).toBe(12);
    expect(worstCase.estimatedBytes).toBeGreaterThan(detailed.estimatedBytes);
  });

  it("rejects a K=15 dense posterior and exposes scores-only compilation risk", () => {
    const classes = 2 ** 15;
    expect(() =>
      assertWithinResourceLimits(
        {
          respondents: 3_000,
          items: 30,
          attributes: 15,
          posteriorStorage: "full",
        },
        DEFAULT_RESOURCE_LIMITS,
      ),
    ).toThrowError(ResourceLimitError);

    const scoresOnly = estimateFitMemory({
      respondents: 2,
      items: 1,
      attributes: 15,
      reducedClassCounts: [classes],
      starts: 1,
      posteriorStorage: "scores-only",
    });
    expect(scoresOnly.breakdown.posterior).toBe(0);
    expect(scoresOnly.breakdown.compilationScratch).toBeGreaterThan(8 * MEBIBYTE);
    // The old estimator reported 3.9 MiB; isolated RSS measurement was ~67 MiB.
    expect(scoresOnly.estimatedBytes).toBeGreaterThan(64 * MEBIBYTE);
  });

  it("enforces explicit dimension limits before estimation", () => {
    const limits = resolveResourceLimits({ maxAttributes: 3 });
    expect(() =>
      assertWithinResourceLimits(
        { respondents: 20, items: 5, attributes: 4 },
        limits,
      ),
    ).toThrowError(ResourceLimitError);
  });

  it("formats byte estimates for diagnostics", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(MEBIBYTE)).toBe("1.00 MiB");
  });
});
