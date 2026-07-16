import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { fit as fitDirect } from "jgdina";
import { createNodeJGDINA, fitInNodeWorker } from "@jgdina/node";

const input = {
  responses: [
    [0, 0, 0],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 0],
    [1, 0, null],
    [0, 1, 0],
  ],
  qMatrix: [
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  model: ["DINA", "DINO", "GDINA"],
  estimation: {
    maxIterations: 100,
    convergenceTolerance: 1e-6,
    initialization: { starts: 1, seed: 9 },
  },
};

const direct = await fitDirect(input);
const isolated = await fitInNodeWorker(input);
assert.equal(direct.backendId, "js");
assert.equal(isolated.backendId, "node-worker:js");
assert.ok(Math.abs(direct.statistics.logLikelihood - isolated.statistics.logLikelihood) < 1e-12);

const pooled = createNodeJGDINA({ size: 1 });
let progressEvents = 0;
try {
  const first = await pooled.fit(input, { onProgress: () => { progressEvents += 1; } });
  const second = await pooled.fit(input);
  assert.equal(first.backendId, "node-worker:js");
  assert.equal(second.statistics.logLikelihood, first.statistics.logLikelihood);
  assert.ok(progressEvents > 0);
} finally {
  await pooled.close();
}

// Verify that the package's documented CommonJS export can also locate its worker asset.
const require = createRequire(import.meta.url);
const cjsNode = require("@jgdina/node");
const cjsResult = await cjsNode.fitInNodeWorker(input);
assert.equal(cjsResult.backendId, "node-worker:js");
assert.equal(cjsResult.statistics.logLikelihood, direct.statistics.logLikelihood);

console.log("Runtime smoke passed: direct ESM, pooled/isolated Node workers, and CommonJS.");
