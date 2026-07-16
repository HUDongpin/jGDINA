import {
  createJGDINA,
  type FitInput,
  type FitOptions,
  type FitResult,
  type JGDINA,
} from "@jgdina/core";
import {
  createNodeWorkerPool,
  NodeWorkerPool,
  type NodeWorkerFactory,
  type NodeWorkerPoolOptions,
} from "./pool.js";

export {
  createNodeWorkerPool,
  NodeWorkerPool,
  type NodeWorkerFactory,
  type NodeWorkerPoolOptions,
};

export interface NodeJGDINA extends JGDINA {
  close(): Promise<void>;
}

/** Create a reusable Node worker-thread jGDINA instance. */
export function createNodeJGDINA(options: NodeWorkerPoolOptions = {}): NodeJGDINA {
  const pool = createNodeWorkerPool(options);
  const engine = createJGDINA(pool);
  return {
    backendId: engine.backendId,
    validate: (input) => engine.validate(input),
    fit: (input, fitOptions) => engine.fit(input, fitOptions),
    close: () => pool.close(),
  };
}

/** Convenience for a single isolated fit; a new worker is always terminated. */
export async function fitInNodeWorker(
  input: FitInput,
  options: FitOptions = {},
): Promise<FitResult> {
  const engine = createNodeJGDINA({ size: 1 });
  try {
    return await engine.fit(input, options);
  } finally {
    await engine.close();
  }
}
