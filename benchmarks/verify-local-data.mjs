import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const committedPath = join(root, "benchmarks", "data", "local-cases.json");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "jgdina-benchmark-data-"));
const generatedPath = join(temporaryDirectory, "local-cases.json");

try {
  const result = spawnSync(
    "Rscript",
    [join(root, "benchmarks", "generate-local-data.R"), generatedPath],
    { cwd: root, encoding: "utf8", stdio: "inherit" },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "Local benchmark input generation failed.");

  const [committed, generated] = await Promise.all([
    readFile(committedPath),
    readFile(generatedPath),
  ]);
  assert.deepEqual(
    generated,
    committed,
    "benchmarks/data/local-cases.json is stale; run Rscript benchmarks/generate-local-data.R",
  );
  console.log("Validated 4 local benchmark inputs byte-for-byte from frozen R data.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
