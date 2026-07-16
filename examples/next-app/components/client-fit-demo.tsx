"use client";

import { createJGDINAClient } from "@jgdina/next/client";
import { useRef, useState } from "react";

import {
  createCancellationDemoInput,
  exampleInput,
} from "../lib/example-input";

const jgdina = createJGDINAClient();
type FitState = "idle" | "running" | "succeeded" | "cancelled" | "failed";

export function ClientFitDemo() {
  const [output, setOutput] = useState("Not run yet.");
  const [fitState, setFitState] = useState<FitState>("idle");
  const controllerRef = useRef<AbortController | null>(null);
  const running = fitState === "running";

  async function run(
    input: typeof exampleInput,
    initialMessage = "Fitting in this browser…",
  ) {
    if (controllerRef.current !== null) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setFitState("running");
    setOutput(initialMessage);
    try {
      const result = await jgdina.fit(input, {
        signal: controller.signal,
        onProgress: (progress) => {
          setOutput(`${progress.phase}: ${Math.round(progress.fraction * 100)}%`);
        },
      });
      setOutput(JSON.stringify(result, null, 2));
      setFitState("succeeded");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        setOutput(`Cancelled: ${error.message}`);
        setFitState("cancelled");
      } else {
        setOutput(error instanceof Error ? error.message : String(error));
        setFitState("failed");
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  function cancel() {
    controllerRef.current?.abort(
      new DOMException("Cancelled by the user.", "AbortError"),
    );
    setOutput("Cancelling…");
  }

  return (
    <>
      <div className="actions">
        <button
          type="button"
          onClick={() => void run(exampleInput)}
          disabled={running}
        >
          {running ? "Fitting…" : "Fit entirely in browser"}
        </button>
        <button
          type="button"
          onClick={() =>
            void run(
              createCancellationDemoInput(),
              "Fitting cancellable stress workload…",
            )
          }
          disabled={running}
        >
          Start cancellation demo
        </button>
        <button type="button" onClick={cancel} disabled={!running}>
          Cancel fit
        </button>
      </div>
      <pre aria-live="polite" data-fit-state={fitState}>{output}</pre>
    </>
  );
}
