"use client";

import { createJGDINAClient } from "@jgdina/next/client";
import { useState } from "react";

import { exampleInput } from "../lib/example-input";

const jgdina = createJGDINAClient();

export function ClientFitDemo() {
  const [output, setOutput] = useState("Not run yet.");
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    setOutput("Fitting in this browser…");
    try {
      const result = await jgdina.fit(exampleInput, {
        onProgress: (progress) => {
          setOutput(`${progress.phase}: ${Math.round(progress.fraction * 100)}%`);
        },
      });
      setOutput(JSON.stringify(result, null, 2));
    } catch (error) {
      setOutput(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <button type="button" onClick={run} disabled={running}>
        {running ? "Fitting…" : "Fit entirely in browser"}
      </button>
      <pre aria-live="polite">{output}</pre>
    </>
  );
}
