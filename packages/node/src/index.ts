import { Worker } from "node:worker_threads";

import { configureDefaultNodeWorkerFactory } from "./pool.js";

// Keep the path in a value so application bundlers leave Node's adjacent worker
// asset to worker_threads instead of trying to absorb it as a web asset.
const workerEntryPath = "./worker-entry.js";

configureDefaultNodeWorkerFactory(
  (slotIndex) =>
    new Worker(new URL(workerEntryPath, import.meta.url), {
      name: `jgdina-fit-${slotIndex}`,
    }),
);

export * from "./api.js";
