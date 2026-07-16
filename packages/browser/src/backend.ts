import type {
  AbortSignalLike,
  FitBackend,
  FitOptions,
  FitResult,
  ValidatedFitInput,
} from "@jgdina/core";
import {
  deserializeError,
  packValidatedInput,
  unpackFitResult,
  type FitWorkerRequest,
  type FitWorkerResponse,
} from "./protocol.js";

export type BrowserWorkerFactory = () => Worker;

export interface BrowserBackendOptions {
  /** Override for CSPs, custom asset paths, test doubles, or alternate bundlers. */
  readonly workerFactory?: BrowserWorkerFactory;
}

type EventedAbortSignal = AbortSignalLike & {
  addEventListener?: (type: "abort", listener: () => void, options?: { once?: boolean }) => void;
  removeEventListener?: (type: "abort", listener: () => void) => void;
};

let nextRequestId = 1;

function defaultWorkerFactory(): Worker {
  return new Worker(new URL("./worker-entry.js", import.meta.url), {
    type: "module",
    name: "jgdina-fit",
  });
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

export class BrowserWorkerBackend implements FitBackend {
  readonly id = "browser-worker:js";
  readonly #workerFactory: BrowserWorkerFactory;

  constructor(options: BrowserBackendOptions = {}) {
    this.#workerFactory = options.workerFactory ?? defaultWorkerFactory;
  }

  fit(input: ValidatedFitInput, options: FitOptions = {}): Promise<FitResult> {
    if (options.signal?.aborted === true) {
      return Promise.reject(abortError(options.signal));
    }

    const requestId = nextRequestId;
    nextRequestId += 1;
    const packed = packValidatedInput(input);
    const request: FitWorkerRequest = { type: "fit", requestId, input: packed };
    const signal = options.signal as EventedAbortSignal | undefined;
    const worker = this.#workerFactory();

    return new Promise<FitResult>((resolve, reject) => {
      let settled = false;
      let abortPoll: ReturnType<typeof setInterval> | undefined;

      const cleanUp = (): void => {
        if (abortPoll !== undefined) clearInterval(abortPoll);
        signal?.removeEventListener?.("abort", onAbort);
        worker.terminate();
      };

      const settle = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        cleanUp();
        operation();
      };

      const onAbort = (): void => {
        if (signal === undefined) return;
        settle(() => reject(abortError(signal)));
      };

      worker.onmessage = (event: MessageEvent<FitWorkerResponse>): void => {
        const response = event.data;
        if (response.requestId !== requestId) return;
        if (response.type === "progress") {
          try {
            options.onProgress?.(response.progress);
          } catch (error) {
            settle(() => reject(error));
          }
        } else if (response.type === "result") {
          try {
            const result = unpackFitResult(response.payload);
            settle(() => resolve(result));
          } catch (error) {
            settle(() => reject(error));
          }
        } else {
          settle(() => reject(deserializeError(response.error)));
        }
      };
      worker.onerror = (event): void => {
        settle(() => reject(new Error(event.message || "jGDINA browser worker failed.")));
      };
      worker.onmessageerror = (): void => {
        settle(() => reject(new Error("jGDINA browser worker returned an unreadable message.")));
      };

      signal?.addEventListener?.("abort", onAbort, { once: true });
      if (signal !== undefined && signal.addEventListener === undefined) {
        abortPoll = setInterval(() => {
          if (signal.aborted) onAbort();
        }, 25);
      }

      try {
        worker.postMessage(request, [
          packed.responses.buffer as ArrayBuffer,
          packed.qMatrix.buffer as ArrayBuffer,
        ]);
      } catch (error) {
        settle(() => reject(error));
      }
    });
  }
}

export function createBrowserBackend(options: BrowserBackendOptions = {}): FitBackend {
  return new BrowserWorkerBackend(options);
}
