#!/usr/bin/env node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { packReleasePackages, smokeInstalledTarballs } from "./package-artifacts.mjs";
import { checkVersionsAndOrder as checkReleaseVersionsAndOrder } from "./release-metadata.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

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
  await checkReleaseVersionsAndOrder(root, targetVersion);
}

function runFullReleaseGates() {
  const gates = [
    ["Node typecheck, unit tests, package builds, and runtime smoke", npm, ["run", "ci:node"]],
    ["Frozen upstream and benchmark-data reproducibility", npm, ["run", "verify:evidence"]],
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
  const cacheDirectory = join(temporaryRoot, "empty-npm-cache");

  try {
    const artifacts = await packReleasePackages({
      root,
      targetVersion,
      destination: packDirectory,
    });

    console.log("\nInstalling all seven tarballs into an empty project with an empty npm cache and offline mode...");
    await smokeInstalledTarballs({
      root,
      targetVersion,
      artifacts,
      installDirectory,
      cacheDirectory,
    });

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
