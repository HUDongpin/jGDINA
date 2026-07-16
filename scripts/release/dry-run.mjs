#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { RELEASE_PACKAGES, REQUIRED_PACKAGE_FILES } from "./config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    stdio: options.capture ? "pipe" : "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = options.capture
      ? `\nstdout:\n${result.stdout || "(empty)"}\nstderr:\n${result.stderr || "(empty)"}`
      : "";
    fail(`${command} ${args.join(" ")} exited with status ${result.status}.${details}`);
  }
  return result;
}

function git(args, options = {}) {
  return run("git", args, { ...options, capture: true }).stdout.trim();
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function parseArguments(argv) {
  let targetVersion;
  let skipGit = false;
  let keepPacks = false;

  for (const argument of argv) {
    if (argument === "--skip-git") {
      skipGit = true;
    } else if (argument === "--keep-packs") {
      keepPacks = true;
    } else if (argument.startsWith("--")) {
      fail(`Unknown option: ${argument}`);
    } else if (targetVersion === undefined) {
      targetVersion = argument;
    } else {
      fail(`Unexpected argument: ${argument}`);
    }
  }

  return { keepPacks, skipGit, targetVersion };
}

function checkGit(targetVersion) {
  if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") {
    fail("Release checks require a Git worktree.");
  }

  const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (head.error) throw head.error;
  if (head.status !== 0) {
    fail("Release checks require at least one Git commit; HEAD does not exist yet.");
  }
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) {
    fail(`Release checks require a clean worktree. Outstanding paths:\n${status}`);
  }

  const tag = `v${targetVersion}`;
  git(["check-ref-format", `refs/tags/${tag}`]);
  const existingTag = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], {
    cwd: root,
    stdio: "ignore",
  });
  if (existingTag.error) throw existingTag.error;
  if (existingTag.status === 0) fail(`Tag ${tag} already exists.`);
  if (existingTag.status !== 1) fail(`Unable to determine whether tag ${tag} exists.`);

  console.log(`  [ok] Git HEAD exists, worktree is clean, and ${tag} is available`);
}

async function checkVersionsAndOrder(targetVersion) {
  const rootManifest = await readJson(join(root, "package.json"));
  if (rootManifest.version !== targetVersion) {
    fail(`Root version ${rootManifest.version} does not match target ${targetVersion}.`);
  }

  const expectedDirectories = RELEASE_PACKAGES.map(({ directory }) => directory.replace("packages/", "")).sort();
  const actualDirectories = (
    await Promise.all(
      (await readdir(join(root, "packages"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            await readFile(join(root, "packages", entry.name, "package.json"));
            return entry.name;
          } catch {
            return null;
          }
        }),
    )
  ).filter(Boolean).sort();
  assert.deepEqual(actualDirectories, expectedDirectories, "Release package list does not cover exactly packages/*.");

  const manifests = new Map();
  for (const entry of RELEASE_PACKAGES) {
    const manifest = await readJson(join(root, entry.directory, "package.json"));
    if (manifest.name !== entry.name) {
      fail(`${entry.directory} is ${manifest.name}, expected ${entry.name}.`);
    }
    if (manifest.version !== targetVersion) {
      fail(`${manifest.name} is ${manifest.version}, expected ${targetVersion}.`);
    }
    if (manifest.private === true) fail(`${manifest.name} is marked private.`);
    if (manifest.license !== "GPL-3.0-only") fail(`${manifest.name} must declare GPL-3.0-only.`);
    if (manifest.publishConfig?.access !== "public") fail(`${manifest.name} must publish with public access.`);
    if (manifest.engines?.node !== ">=20") fail(`${manifest.name} must retain the Node >=20 contract.`);
    for (const file of REQUIRED_PACKAGE_FILES.slice(1)) {
      if (!manifest.files?.includes(file)) fail(`${manifest.name} does not include ${file} in its npm files list.`);
    }
    if (!manifest.files?.includes("dist")) fail(`${manifest.name} does not include dist in its npm files list.`);
    manifests.set(manifest.name, { entry, manifest });
  }

  const indices = new Map(RELEASE_PACKAGES.map(({ name }, index) => [name, index]));
  for (const [name, { manifest }] of manifests) {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
        if (!manifests.has(dependency)) continue;
        if (range !== targetVersion) {
          fail(`${name} ${field}.${dependency} is ${range}, expected exact ${targetVersion}.`);
        }
        if (indices.get(dependency) >= indices.get(name)) {
          fail(`Invalid publish order: ${dependency} must precede its consumer ${name}.`);
        }
      }
    }
  }

  const lock = await readJson(join(root, "package-lock.json"));
  if (lock.version !== targetVersion || lock.packages?.[""]?.version !== targetVersion) {
    fail("Root package-lock.json is not synchronized with the release version.");
  }
  for (const { directory, name } of RELEASE_PACKAGES) {
    if (lock.packages?.[directory]?.version !== targetVersion) {
      fail(`package-lock.json entry for ${name} is not ${targetVersion}.`);
    }
  }

  const example = await readJson(join(root, "examples/next-app/package.json"));
  const exampleLock = await readJson(join(root, "examples/next-app/package-lock.json"));
  if (example.version !== targetVersion || exampleLock.version !== targetVersion || exampleLock.packages?.[""]?.version !== targetVersion) {
    fail("The Next.js example manifest and lock must match the release candidate version.");
  }

  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
  if (!changelog.includes(`## [${targetVersion}]`)) {
    fail(`CHANGELOG.md has no ${targetVersion} release entry.`);
  }

  console.log(`  [ok] ${RELEASE_PACKAGES.length} manifests, exact internal dependencies, and both locks use ${targetVersion}`);
  console.log(`  [ok] Publish order is topologically valid: ${RELEASE_PACKAGES.map(({ name }) => name).join(" -> ")}`);
}

function parsePackJson(output, packageName) {
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed) || parsed.length !== 1) fail(`Unexpected npm pack result for ${packageName}.`);
    return parsed[0];
  } catch (error) {
    fail(`Could not parse npm pack --json output for ${packageName}: ${error.message}\n${output}`);
  }
}

function checkPackContents(pack, expectedName, targetVersion) {
  if (pack.name !== expectedName || pack.version !== targetVersion) {
    fail(`Packed identity ${pack.name}@${pack.version} does not match ${expectedName}@${targetVersion}.`);
  }
  if (!pack.filename?.endsWith(".tgz") || !pack.integrity || !pack.shasum || pack.size <= 0 || pack.unpackedSize <= 0) {
    fail(`${expectedName} did not produce complete npm pack metadata.`);
  }

  const paths = new Set((pack.files ?? []).map(({ path }) => path));
  for (const path of REQUIRED_PACKAGE_FILES) {
    if (!paths.has(path)) fail(`${expectedName} tarball is missing ${path}.`);
  }
  if (![...paths].some((path) => path.startsWith("dist/"))) {
    fail(`${expectedName} tarball contains no dist files.`);
  }
  const unexpected = [...paths].filter(
    (path) => !path.startsWith("dist/") && !REQUIRED_PACKAGE_FILES.includes(path),
  );
  if (unexpected.length) fail(`${expectedName} tarball contains unexpected files: ${unexpected.join(", ")}`);
}

async function writeSmokeProject(directory, targetVersion) {
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "jgdina-release-smoke", private: true, type: "module" }, null, 2)}\n`,
  );

  const expectedVersions = Object.fromEntries(RELEASE_PACKAGES.map(({ name }) => [name, targetVersion]));
  await writeFile(
    join(directory, "smoke.mjs"),
    `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const expectedVersions = ${JSON.stringify(expectedVersions)};
for (const [name, version] of Object.entries(expectedVersions)) {
  const parts = name.startsWith("@") ? name.split("/") : [name];
  const manifest = JSON.parse(await readFile(join(process.cwd(), "node_modules", ...parts, "package.json"), "utf8"));
  assert.equal(manifest.version, version, name);
}

const direct = await import("jgdina");
const core = await import("@jgdina/core");
const kernels = await import("@jgdina/kernels-js");
const protocol = await import("@jgdina/worker-protocol");
const browser = await import("@jgdina/browser");
const nodeAdapter = await import("@jgdina/node");
const next = await import("@jgdina/next");
const nextClient = await import("@jgdina/next/client");

assert.equal(typeof direct.fit, "function");
assert.equal(typeof core.validateFitInput, "function");
assert.equal(typeof kernels.createJsBackend, "function");
assert.equal(typeof protocol.packValidatedInput, "function");
assert.equal(typeof browser.createBrowserJGDINA, "function");
assert.equal(typeof nodeAdapter.fitInNodeWorker, "function");
assert.equal(typeof next.createJGDINARouteHandler, "function");
assert.equal(typeof nextClient.createJGDINAClient, "function");

const input = {
  responses: [[0, 0], [0, 1], [1, 0], [1, 1]],
  qMatrix: [[1], [1]],
  model: "DINA",
  estimation: { maxIterations: 100, convergenceTolerance: 1e-6, initialization: { starts: 1, seed: 7 } },
};
const directResult = await direct.fit(input);
const workerResult = await nodeAdapter.fitInNodeWorker(input);
assert.equal(directResult.backendId, "js");
assert.equal(workerResult.backendId, "node-worker:js");
assert.ok(Math.abs(directResult.statistics.logLikelihood - workerResult.statistics.logLikelihood) < 1e-12);

console.log("Installed-tarball ESM and worker smoke passed.");
`,
  );

  await writeFile(
    join(directory, "smoke.cjs"),
    `const assert = require("node:assert/strict");
for (const name of ["jgdina", "@jgdina/core", "@jgdina/kernels-js", "@jgdina/worker-protocol", "@jgdina/node"]) {
  assert.ok(require(name), name);
}
console.log("Installed-tarball CommonJS smoke passed.");
`,
  );
}

function runFullReleaseGates() {
  const gates = [
    ["Node typecheck, unit tests, package builds, and runtime smoke", npm, ["run", "ci:node"]],
    ["Independent base-R oracle", npm, ["run", "oracle"]],
    ["Real-data R to jGDINA acceptance", npm, ["run", "accept:real-data"]],
    ["Root dependency audit", npm, ["audit", "--audit-level=low"]],
    ["Next.js example dependency audit", npm, ["audit", "--prefix", "examples/next-app", "--audit-level=low"]],
    ["Locked Next.js example install", npm, ["ci", "--prefix", "examples/next-app"]],
    ["Next.js example typecheck", npm, ["run", "typecheck", "--prefix", "examples/next-app"]],
    ["Next.js 16 production build", npm, ["run", "build", "--prefix", "examples/next-app"]],
  ];

  console.log("\nRunning the complete non-publishing release gate sequence...");
  for (const [label, command, args] of gates) {
    console.log(`\n==> ${label}`);
    run(command, args);
  }
}

async function packAndSmoke(targetVersion, keepPacks, { build }) {
  if (build) {
    console.log("\nBuilding all release packages...");
    run(npm, ["run", "build"]);
  } else {
    console.log("\nPacking the package builds produced by the completed Node gate...");
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), `jgdina-${targetVersion}-`));
  const packDirectory = join(temporaryRoot, "packs");
  const installDirectory = join(temporaryRoot, "install-smoke");
  await Promise.all([mkdir(packDirectory), mkdir(installDirectory)]);

  try {
    const tarballs = [];
    for (const { directory, name } of RELEASE_PACKAGES) {
      const result = run(
        npm,
        ["pack", "--json", "--pack-destination", packDirectory],
        { capture: true, cwd: join(root, directory) },
      );
      const pack = parsePackJson(result.stdout, name);
      checkPackContents(pack, name, targetVersion);
      const tarball = join(packDirectory, pack.filename);
      tarballs.push(tarball);
      console.log(`  [ok] ${name}: ${pack.filename} (${pack.size} bytes, ${pack.files.length} files)`);
    }

    await writeSmokeProject(installDirectory, targetVersion);
    console.log("\nInstalling all seven tarballs into an empty project...");
    run(
      npm,
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        ...tarballs,
      ],
      { cwd: installDirectory },
    );
    run(node, ["smoke.mjs"], { cwd: installDirectory });
    run(node, ["smoke.cjs"], { cwd: installDirectory });

    console.log(`\nPackage pack/install smoke passed for ${targetVersion}.`);
    if (keepPacks) console.log(`Tarballs retained at ${packDirectory}`);
  } finally {
    if (!keepPacks) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const options = parseArguments(process.argv.slice(2));
const rootManifest = await readJson(join(root, "package.json"));
const targetVersion = options.targetVersion ?? rootManifest.version;

if (!/^\d+\.\d+\.\d+-rc\.\d+$/.test(targetVersion)) {
  fail(`Release dry-run requires an rc version such as 1.0.0-rc.1; received ${targetVersion}.`);
}

console.log(`jGDINA release-candidate preflight: ${targetVersion}`);
await checkVersionsAndOrder(targetVersion);
if (options.skipGit) {
  console.warn("  [fast] Running package-only smoke; Git and the full release gate sequence are skipped.");
  await packAndSmoke(targetVersion, options.keepPacks, { build: true });
} else {
  console.log("\nChecking release commit before running generated-output gates...");
  checkGit(targetVersion);
  runFullReleaseGates();
  console.log("\nRechecking release commit after all generated-output gates...");
  checkGit(targetVersion);
  await packAndSmoke(targetVersion, options.keepPacks, { build: false });
  console.log("\nPerforming final clean-worktree and tag-availability check after packaging...");
  checkGit(targetVersion);
  console.log(`\nComplete release-candidate preflight passed for ${targetVersion}.`);
  console.log("No package, Git tag, commit, or registry state was changed.");
}
