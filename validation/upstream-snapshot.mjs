#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalPath = join(root, "validation", "upstream-snapshot.json");
const arguments_ = process.argv.slice(2);
const check = arguments_.includes("--check");
const outputArguments = arguments_.filter((argument) => !argument.startsWith("--"));
if (outputArguments.length > 1) {
  throw new Error("Usage: node validation/upstream-snapshot.mjs [--check] [output.json]");
}
const outputArgument = outputArguments[0];
if (outputArgument !== undefined && !outputArgument.toLowerCase().endsWith(".json")) {
  throw new Error("The optional output path must end in .json.");
}
const temporaryDirectory = check
  ? await mkdtemp(join(tmpdir(), "jgdina-upstream-snapshot-"))
  : null;
const outputPath = check
  ? join(temporaryDirectory, "upstream-snapshot.json")
  : resolve(outputArgument ?? canonicalPath);

try {
  const paths = execFileSync(
    "git",
    ["ls-files", "-z", "--", "GDINA-master"],
    { cwd: root },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (paths.length === 0) {
    throw new Error("No tracked GDINA-master files were found.");
  }

  const files = [];
  let totalBytes = 0;
  const tree = createHash("sha256");
  for (const path of paths) {
    const content = await readFile(join(root, path));
    const sha256 = createHash("sha256").update(content).digest("hex");
    totalBytes += content.byteLength;
    tree.update(path, "utf8");
    tree.update("\0");
    tree.update(String(content.byteLength), "utf8");
    tree.update("\0");
    tree.update(sha256, "ascii");
    tree.update("\n");
    files.push({ path, bytes: content.byteLength, sha256 });
  }

  const payload = {
    schemaVersion: "1.0.0",
    generatedBy: "validation/upstream-snapshot.mjs",
    algorithm:
      "sha256(path UTF-8 + NUL + decimal byte length + NUL + file SHA-256 ASCII + LF), sorted by raw UTF-8 path bytes",
    upstream: {
      project: "Wenchao-Ma/GDINA",
      version: "2.12.3",
      date: "2026-07-10",
      recordedCommit: "ac5eca223a1ee32b6c2f595cfeaef9b330451425",
      localRoot: "GDINA-master/",
    },
    fileCount: files.length,
    totalBytes,
    treeSha256: tree.digest("hex"),
    files,
  };
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  if (check) {
    const [canonical, generated] = await Promise.all([
      readFile(canonicalPath),
      readFile(outputPath),
    ]);
    if (!canonical.equals(generated)) {
      throw new Error(
        "validation/upstream-snapshot.json is stale; run node validation/upstream-snapshot.mjs",
      );
    }
    console.log(
      `Verified ${files.length} frozen upstream files (${totalBytes} bytes), tree ${payload.treeSha256}.`,
    );
  } else {
    console.log(
      `Wrote ${files.length} frozen upstream files (${totalBytes} bytes), tree ${payload.treeSha256}.`,
    );
  }
} finally {
  if (temporaryDirectory !== null) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
