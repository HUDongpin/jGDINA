import { describe, expect, it } from "vitest";
import { fitValidated } from "@jgdina/kernels-js";
import {
  packFitResult,
  unpackValidatedInput,
  type FitWorkerRequest,
  type FitWorkerResponse,
} from "@jgdina/worker-protocol";
import { createBrowserJGDINA } from "../src/index.js";

const input = {
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
} as const;

class InlineWorker {
  onmessage: ((event: MessageEvent<FitWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminateCount = 0;
  transferCounts: number[] = [];
  readonly respond: boolean;
  readonly malformedResult: boolean;

  constructor(respond = true, malformedResult = false) {
    this.respond = respond;
    this.malformedResult = malformedResult;
  }

  postMessage(request: FitWorkerRequest, transfer: Transferable[]): void {
    this.transferCounts.push(transfer.length);
    if (!this.respond) return;
    setTimeout(() => {
      try {
        this.onmessage?.({
          data: {
            type: "progress",
            requestId: request.requestId,
            progress: { phase: "estimation", fraction: 0.5 },
          },
        } as MessageEvent<FitWorkerResponse>);
        const result = fitValidated(
          unpackValidatedInput(request.input),
          undefined,
          "browser-worker:js",
        );
        const response: FitWorkerResponse = {
          type: "result",
          requestId: request.requestId,
          payload: this.malformedResult
            ? new TextEncoder().encode("not JSON")
            : packFitResult(result),
        };
        this.onmessage?.({ data: response } as MessageEvent<FitWorkerResponse>);
      } catch (error) {
        this.onerror?.({ message: String(error) } as ErrorEvent);
      }
    }, 0);
  }

  terminate(): void {
    this.terminateCount += 1;
  }
}

describe("browser worker backend", () => {
  it("transfers packed input and restores a JSON-safe result", async () => {
    const worker = new InlineWorker();
    const engine = createBrowserJGDINA({ workerFactory: () => worker as unknown as Worker });
    const result = await engine.fit(input);

    expect(worker.transferCounts).toEqual([2]);
    expect(worker.terminateCount).toBe(1);
    expect(result.backendId).toBe("browser-worker:js");
    expect(result.scores.posteriorProbabilities).toHaveLength(4);
  });

  it("terminates CPU-bound work promptly when aborted", async () => {
    const worker = new InlineWorker(false);
    const engine = createBrowserJGDINA({ workerFactory: () => worker as unknown as Worker });
    const controller = new AbortController();
    const pending = engine.fit(input, { signal: controller.signal });
    controller.abort("stop");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminateCount).toBe(1);
  });

  it("rejects malformed worker results instead of leaving a fit pending", async () => {
    const worker = new InlineWorker(true, true);
    const engine = createBrowserJGDINA({ workerFactory: () => worker as unknown as Worker });

    await expect(engine.fit(input)).rejects.toBeInstanceOf(SyntaxError);
    expect(worker.terminateCount).toBe(1);
  });

  it("terminates the worker when a progress callback throws", async () => {
    const worker = new InlineWorker();
    const engine = createBrowserJGDINA({ workerFactory: () => worker as unknown as Worker });

    await expect(
      engine.fit(input, {
        onProgress: (progress) => {
          if (progress.phase === "estimation") throw new Error("progress failed");
        },
      }),
    ).rejects.toThrow("progress failed");
    expect(worker.terminateCount).toBe(1);
  });
});
