import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { configureDefaultNodeWorkerFactory } from "./pool.js";

declare const __filename: string;

configureDefaultNodeWorkerFactory(
  (slotIndex) =>
    new Worker(new URL("./worker-entry.cjs", pathToFileURL(__filename)), {
      name: `jgdina-fit-${slotIndex}`,
    }),
);

export * from "./api.js";
