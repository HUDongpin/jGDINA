import { Worker } from "node:worker_threads";
import type {
  AbortSignalLike,
  FitBackend,
  FitOptions,
  FitResult,
  ValidatedFitInput,
} from "@jgdina/core";
import { DEFAULT_RESOURCE_LIMITS, ResourceLimitError } from "@jgdina/core";
import {
  deserializeError,
  packValidatedInput,
  unpackFitResult,
  type FitWorkerRequest,
  type FitWorkerResponse,
} from "@jgdina/worker-protocol";

export type NodeWorkerFactory = (slotIndex: number) => Worker;

export interface NodeWorkerPoolOptions {
  /** Conservative by default because each fit may use substantial 2^K memory. */
  readonly size?: number;
  /** Aggregate estimate allowed across active workers. Defaults to 512 MiB. */
  readonly maxConcurrentEstimatedBytes?: number;
  readonly workerFactory?: NodeWorkerFactory;
}

interface EventedAbortSignal extends AbortSignalLike {
  addEventListener?: (type: "abort", listener: () => void, options?: { once?: boolean }) => void;
  removeEventListener?: (type: "abort", listener: () => void) => void;
}

interface PendingTask {
  readonly requestId: number;
  readonly input: ValidatedFitInput;
  readonly options: FitOptions;
  readonly resolve: (result: FitResult) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: EventedAbortSignal | undefined;
  abortPoll: ReturnType<typeof setInterval> | undefined;
  abortListener: (() => void) | undefined;
  settled: boolean;
}

interface WorkerSlot {
  readonly index: number;
  worker: Worker;
  task: PendingTask | null;
}

let defaultWorkerFactory: NodeWorkerFactory | undefined;

/** @internal Configured by the format-specific package entry point. */
export function configureDefaultNodeWorkerFactory(factory: NodeWorkerFactory): void {
  defaultWorkerFactory = factory;
}

function abortError(signal: AbortSignalLike): Error {
  const message =
    signal.reason instanceof Error
      ? signal.reason.message
      : signal.reason === undefined
        ? "The jGDINA fit was aborted."
        : String(signal.reason);
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** Reusable worker_threads pool suitable for Next.js Node Route Handlers. */
export class NodeWorkerPool implements FitBackend {
  readonly id = "node-worker:js";
  readonly #factory: NodeWorkerFactory;
  readonly #slots: WorkerSlot[] = [];
  readonly #queue: PendingTask[] = [];
  readonly #maxConcurrentEstimatedBytes: number;
  #closed = false;
  #nextRequestId = 1;

  constructor(options: NodeWorkerPoolOptions = {}) {
    const size = options.size ?? 1;
    if (!Number.isSafeInteger(size) || size < 1 || size > 64) {
      throw new RangeError("NodeWorkerPool size must be an integer from 1 to 64.");
    }
    const maxConcurrentEstimatedBytes =
      options.maxConcurrentEstimatedBytes ?? DEFAULT_RESOURCE_LIMITS.maxEstimatedBytes;
    if (
      !Number.isSafeInteger(maxConcurrentEstimatedBytes) ||
      maxConcurrentEstimatedBytes < 1
    ) {
      throw new RangeError(
        "NodeWorkerPool maxConcurrentEstimatedBytes must be a positive safe integer.",
      );
    }
    this.#maxConcurrentEstimatedBytes = maxConcurrentEstimatedBytes;
    const factory = options.workerFactory ?? defaultWorkerFactory;
    if (factory === undefined) {
      throw new Error(
        "The jGDINA Node worker factory was not initialized by the package entry point.",
      );
    }
    this.#factory = factory;
    for (let index = 0; index < size; index += 1) {
      const slot: WorkerSlot = { index, worker: this.#factory(index), task: null };
      this.#attach(slot, slot.worker);
      this.#slots.push(slot);
    }
  }

  fit(input: ValidatedFitInput, options: FitOptions = {}): Promise<FitResult> {
    if (this.#closed) return Promise.reject(new Error("The jGDINA worker pool is closed."));
    if (options.signal?.aborted === true) {
      return Promise.reject(abortError(options.signal));
    }
    if (input.memoryEstimate.estimatedBytes > this.#maxConcurrentEstimatedBytes) {
      return Promise.reject(
        new ResourceLimitError(
          "nodePool.maxConcurrentEstimatedBytes",
          input.memoryEstimate.estimatedBytes,
          this.#maxConcurrentEstimatedBytes,
        ),
      );
    }

    return new Promise<FitResult>((resolve, reject) => {
      const signal = options.signal as EventedAbortSignal | undefined;
      const task: PendingTask = {
        requestId: this.#nextRequestId,
        input,
        options,
        resolve,
        reject,
        signal,
        abortPoll: undefined,
        abortListener: undefined,
        settled: false,
      };
      this.#nextRequestId += 1;
      const onAbort = (): void => this.#abort(task);
      task.abortListener = onAbort;
      signal?.addEventListener?.("abort", onAbort, { once: true });
      if (signal !== undefined && signal.addEventListener === undefined) {
        task.abortPoll = setInterval(() => {
          if (signal.aborted) onAbort();
        }, 25);
      }
      this.#queue.push(task);
      this.#dispatch();
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error("The jGDINA worker pool was closed before the fit completed.");
    for (const task of this.#queue.splice(0)) this.#settle(task, () => task.reject(error));
    const terminations: Promise<number>[] = [];
    for (const slot of this.#slots) {
      if (slot.task !== null) {
        const task = slot.task;
        slot.task = null;
        this.#settle(task, () => task.reject(error));
      }
      terminations.push(slot.worker.terminate());
    }
    await Promise.allSettled(terminations);
  }

  #attach(slot: WorkerSlot, worker: Worker): void {
    worker.on("message", (response: FitWorkerResponse): void => {
      if (slot.worker !== worker) return;
      const task = slot.task;
      if (task === null || response.requestId !== task.requestId) return;
      if (response.type === "progress") {
        try {
          task.options.onProgress?.(response.progress);
        } catch (error) {
          this.#failRunning(slot, worker, task, error);
        }
      } else if (response.type === "result") {
        try {
          const result = unpackFitResult(response.payload);
          slot.task = null;
          this.#settle(task, () => task.resolve(result));
          this.#dispatch();
        } catch (error) {
          this.#failRunning(slot, worker, task, error);
        }
      } else {
        slot.task = null;
        this.#settle(task, () => task.reject(deserializeError(response.error)));
        this.#dispatch();
      }
    });
    worker.on("messageerror", (): void => {
      const task = slot.task;
      if (slot.worker === worker && task !== null) {
        this.#failRunning(slot, worker, task, new Error("jGDINA worker returned an unreadable message."));
      }
    });
    worker.on("error", (error): void => {
      const task = slot.task;
      if (slot.worker === worker && task !== null) this.#failRunning(slot, worker, task, error);
    });
    worker.on("exit", (code): void => {
      if (slot.worker !== worker || this.#closed) return;
      const task = slot.task;
      if (task !== null) {
        slot.task = null;
        this.#settle(task, () => task.reject(new Error(`jGDINA worker exited with code ${code}.`)));
      }
      this.#replace(slot, worker);
      this.#dispatch();
    });
  }

  #dispatch(): void {
    if (this.#closed) return;
    let activeEstimatedBytes = this.#slots.reduce(
      (total, slot) =>
        total + (slot.task?.input.memoryEstimate.estimatedBytes ?? 0),
      0,
    );
    for (const slot of this.#slots) {
      if (slot.task !== null) continue;
      let task = this.#queue.shift();
      while (task !== undefined && task.signal?.aborted === true) {
        this.#settle(task, () => task?.reject(abortError(task.signal as AbortSignalLike)));
        task = this.#queue.shift();
      }
      if (task === undefined) return;
      const taskEstimatedBytes = task.input.memoryEstimate.estimatedBytes;
      if (
        activeEstimatedBytes + taskEstimatedBytes >
        this.#maxConcurrentEstimatedBytes
      ) {
        this.#queue.unshift(task);
        return;
      }
      slot.task = task;
      activeEstimatedBytes += taskEstimatedBytes;
      try {
        const packed = packValidatedInput(task.input);
        const request: FitWorkerRequest = {
          type: "fit",
          requestId: task.requestId,
          input: packed,
        };
        slot.worker.postMessage(request, [
          packed.responses.buffer as ArrayBuffer,
          packed.qMatrix.buffer as ArrayBuffer,
        ]);
      } catch (error) {
        this.#failRunning(slot, slot.worker, task, error);
      }
    }
  }

  #abort(task: PendingTask): void {
    if (task.settled) return;
    const queueIndex = this.#queue.indexOf(task);
    if (queueIndex >= 0) {
      this.#queue.splice(queueIndex, 1);
      this.#settle(task, () => task.reject(abortError(task.signal as AbortSignalLike)));
      return;
    }
    const slot = this.#slots.find((candidate) => candidate.task === task);
    if (slot !== undefined) {
      const worker = slot.worker;
      slot.task = null;
      this.#settle(task, () => task.reject(abortError(task.signal as AbortSignalLike)));
      this.#replace(slot, worker);
      void worker.terminate();
      this.#dispatch();
    }
  }

  #failRunning(slot: WorkerSlot, worker: Worker, task: PendingTask, error: unknown): void {
    if (slot.task !== task) return;
    slot.task = null;
    this.#settle(task, () => task.reject(error));
    this.#replace(slot, worker);
    void worker.terminate();
    this.#dispatch();
  }

  #replace(slot: WorkerSlot, oldWorker: Worker): void {
    if (this.#closed || slot.worker !== oldWorker) return;
    const replacement = this.#factory(slot.index);
    slot.worker = replacement;
    this.#attach(slot, replacement);
  }

  #settle(task: PendingTask, operation: () => void): void {
    if (task.settled) return;
    task.settled = true;
    if (task.abortPoll !== undefined) clearInterval(task.abortPoll);
    if (task.abortListener !== undefined) {
      task.signal?.removeEventListener?.("abort", task.abortListener);
    }
    operation();
  }
}

export function createNodeWorkerPool(options: NodeWorkerPoolOptions = {}): NodeWorkerPool {
  return new NodeWorkerPool(options);
}
