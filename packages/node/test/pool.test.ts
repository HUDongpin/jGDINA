import { EventEmitter } from "node:events";

import { validateFitInput } from "@jgdina/core";
import { fitValidated } from "@jgdina/kernels-js";
import {
  packFitResult,
  unpackValidatedInput,
  type FitWorkerRequest,
  type FitWorkerResponse,
} from "@jgdina/worker-protocol";
import { describe, expect, it, vi } from "vitest";

import { createNodeWorkerPool } from "../src/index.js";

const validated = validateFitInput({
  responses: [
    [0, 0, 0],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 0],
  ],
  qMatrix: [
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  estimation: {
    maxIterations: 50,
    initialization: { starts: 1, seed: 17 },
  },
});

class InlineNodeWorker extends EventEmitter {
  readonly respond: boolean;
  readonly malformedResult: boolean;
  readonly transferCounts: number[] = [];
  terminateCount = 0;

  constructor(respond = true, malformedResult = false) {
    super();
    this.respond = respond;
    this.malformedResult = malformedResult;
  }

  postMessage(request: FitWorkerRequest, transfer: readonly ArrayBuffer[]): void {
    this.transferCounts.push(transfer.length);
    if (!this.respond) return;
    setTimeout(() => {
      try {
        const progress: FitWorkerResponse = {
          type: "progress",
          requestId: request.requestId,
          progress: { phase: "estimation", fraction: 0.5 },
        };
        this.emit("message", progress);
        const result = fitValidated(
          unpackValidatedInput(request.input),
          undefined,
          "node-worker:js",
        );
        const response: FitWorkerResponse = {
          type: "result",
          requestId: request.requestId,
          payload: this.malformedResult
            ? new TextEncoder().encode("not JSON")
            : packFitResult(result),
        };
        this.emit("message", response);
      } catch (error) {
        this.emit("error", error);
      }
    }, 0);
  }

  terminate(): Promise<number> {
    this.terminateCount += 1;
    return Promise.resolve(0);
  }
}

describe("NodeWorkerPool", () => {
  it("reuses a worker, transfers both input buffers, and forwards progress", async () => {
    const worker = new InlineNodeWorker();
    const factory = vi.fn(() => worker as never);
    const pool = createNodeWorkerPool({ size: 1, workerFactory: factory });
    const progress = vi.fn();

    try {
      const first = await pool.fit(validated, { onProgress: progress });
      const second = await pool.fit(validated);

      expect(first.backendId).toBe("node-worker:js");
      expect(second.statistics.logLikelihood).toBeCloseTo(first.statistics.logLikelihood, 12);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(worker.transferCounts).toEqual([2, 2]);
      expect(progress).toHaveBeenCalled();
    } finally {
      await pool.close();
    }
    expect(worker.terminateCount).toBe(1);
  });

  it("rejects a running fit on abort and replaces the terminated worker", async () => {
    const workers: InlineNodeWorker[] = [];
    const factory = vi.fn(() => {
      const worker = new InlineNodeWorker(workers.length > 0);
      workers.push(worker);
      return worker as never;
    });
    const pool = createNodeWorkerPool({ size: 1, workerFactory: factory });
    const controller = new AbortController();

    const pending = pool.fit(validated, { signal: controller.signal });
    controller.abort("stop");
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "stop" });

    const recovered = await pool.fit(validated);
    expect(recovered.backendId).toBe("node-worker:js");
    expect(factory).toHaveBeenCalledTimes(2);
    expect(workers[0]?.terminateCount).toBe(1);
    await pool.close();
  });

  it("rejects queued work without disturbing the running worker", async () => {
    const worker = new InlineNodeWorker(false);
    const pool = createNodeWorkerPool({
      size: 1,
      workerFactory: () => worker as never,
    });
    const running = pool.fit(validated);
    const controller = new AbortController();
    const queued = pool.fit(validated, { signal: controller.signal });
    controller.abort();

    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await pool.close();
    await expect(running).rejects.toThrow("closed before the fit completed");
    expect(worker.terminateCount).toBe(1);
  });

  it("rejects a malformed result and replaces the failed worker", async () => {
    const workers: InlineNodeWorker[] = [];
    const pool = createNodeWorkerPool({
      workerFactory: () => {
        const worker = new InlineNodeWorker(true, workers.length === 0);
        workers.push(worker);
        return worker as never;
      },
    });

    await expect(pool.fit(validated)).rejects.toBeInstanceOf(SyntaxError);
    const recovered = await pool.fit(validated);
    expect(recovered.backendId).toBe("node-worker:js");
    expect(workers).toHaveLength(2);
    expect(workers[0]?.terminateCount).toBe(1);
    await pool.close();
  });

  it("rejects new fits after close", async () => {
    const pool = createNodeWorkerPool({
      workerFactory: () => new InlineNodeWorker() as never,
    });
    await pool.close();
    await expect(pool.fit(validated)).rejects.toThrow("worker pool is closed");
  });

  it("admits active fits only within the configured aggregate memory budget", async () => {
    const workers = [new InlineNodeWorker(false), new InlineNodeWorker(false)];
    let factoryIndex = 0;
    const oneFitBytes = validated.memoryEstimate.estimatedBytes;
    const pool = createNodeWorkerPool({
      size: 2,
      maxConcurrentEstimatedBytes: oneFitBytes,
      workerFactory: () => workers[factoryIndex++] as never,
    });

    const first = pool.fit(validated);
    const second = pool.fit(validated);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(workers[0]?.transferCounts).toEqual([2]);
    expect(workers[1]?.transferCounts).toEqual([]);

    await pool.close();
    await expect(first).rejects.toThrow("closed before the fit completed");
    await expect(second).rejects.toThrow("closed before the fit completed");
  });

  it("rejects a fit that exceeds the pool budget before posting it", async () => {
    const worker = new InlineNodeWorker(false);
    const pool = createNodeWorkerPool({
      maxConcurrentEstimatedBytes: validated.memoryEstimate.estimatedBytes - 1,
      workerFactory: () => worker as never,
    });

    await expect(pool.fit(validated)).rejects.toMatchObject({
      code: "RESOURCE_LIMIT_EXCEEDED",
      limit: "nodePool.maxConcurrentEstimatedBytes",
    });
    expect(worker.transferCounts).toEqual([]);
    await pool.close();
  });

  it("validates the aggregate pool budget", () => {
    expect(() => createNodeWorkerPool({ maxConcurrentEstimatedBytes: 0 })).toThrow(
      RangeError,
    );
  });
});
