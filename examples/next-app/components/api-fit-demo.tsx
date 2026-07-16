"use client";

import { useState } from "react";

import { exampleInput } from "../lib/example-input";

export function ApiFitDemo() {
  const [output, setOutput] = useState("Not run yet.");
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    setOutput("Fitting in the Node worker pool…");
    try {
      const response = await fetch("/api/jgdina", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(exampleInput),
      });
      const payload: unknown = await response.json();
      setOutput(JSON.stringify(payload, null, 2));
    } catch (error) {
      setOutput(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <button type="button" onClick={run} disabled={running}>
        {running ? "Fitting…" : "Fit through API route"}
      </button>
      <pre aria-live="polite">{output}</pre>
    </>
  );
}
