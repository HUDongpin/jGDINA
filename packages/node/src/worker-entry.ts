import { parentPort } from "node:worker_threads";
import type { FitProgress } from "@jgdina/core";
import { fitValidated } from "@jgdina/kernels-js";
import {
  packFitResult,
  serializeError,
  unpackValidatedInput,
  type FitWorkerRequest,
  type FitWorkerResponse,
} from "@jgdina/worker-protocol";

if (parentPort === null) {
  throw new Error("The jGDINA Node worker must be started by worker_threads.");
}

const port = parentPort;
port.on("message", (request: FitWorkerRequest): void => {
  if (request.type !== "fit") return;

  const emitProgress = (progress: FitProgress): void => {
    const response: FitWorkerResponse = {
      type: "progress",
      requestId: request.requestId,
      progress,
    };
    port.postMessage(response);
  };

  Promise.resolve(
    fitValidated(
      unpackValidatedInput(request.input),
      { onProgress: emitProgress },
      "node-worker:js",
    ),
  ).then(
    (result) => {
      const payload = packFitResult(result);
      const response: FitWorkerResponse = {
        type: "result",
        requestId: request.requestId,
        payload,
      };
      port.postMessage(response, [payload.buffer as ArrayBuffer]);
    },
    (error: unknown) => {
      const response: FitWorkerResponse = {
        type: "error",
        requestId: request.requestId,
        error: serializeError(error),
      };
      port.postMessage(response);
    },
  );
});
