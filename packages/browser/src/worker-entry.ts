/// <reference lib="webworker" />

import type { FitProgress } from "@jgdina/core";
import { fitValidated } from "@jgdina/kernels-js";
import {
  packFitResult,
  serializeError,
  unpackValidatedInput,
  type FitWorkerRequest,
  type FitWorkerResponse,
} from "./protocol.js";

const scope = self as DedicatedWorkerGlobalScope;
scope.onmessage = (event: MessageEvent<FitWorkerRequest>): void => {
  const request = event.data;
  if (request.type !== "fit") return;

  const emitProgress = (progress: FitProgress): void => {
    const response: FitWorkerResponse = {
      type: "progress",
      requestId: request.requestId,
      progress,
    };
    scope.postMessage(response);
  };

  Promise.resolve(
    fitValidated(
      unpackValidatedInput(request.input),
      { onProgress: emitProgress },
      "browser-worker:js",
    ),
  ).then(
    (result) => {
      const payload = packFitResult(result);
      const response: FitWorkerResponse = {
        type: "result",
        requestId: request.requestId,
        payload,
      };
      scope.postMessage(response, [payload.buffer as ArrayBuffer]);
    },
    (error: unknown) => {
      const response: FitWorkerResponse = {
        type: "error",
        requestId: request.requestId,
        error: serializeError(error),
      };
      scope.postMessage(response);
    },
  );
};
