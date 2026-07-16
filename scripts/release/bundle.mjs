#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RELEASE_VERIFICATIONS, packReleasePackages, runCommand, smokeInstalledTarballs } from "./package-artifacts.mjs";
import { checkInstalledReleaseToolchain, checkVersionsAndOrder } from "./release-metadata.mjs";
import { runNextTarballProductionSmoke } from "./next-tarball-smoke.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function fail(message) {
  throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function parseArguments(argv, defaultVersion) {
  let allowDirty = false;
  let targetVersion;
  for (const argument of argv) {
    if (argument === "--allow-dirty") {
      allowDirty = true;
    } else if (argument.startsWith("--")) {
      fail(`Unknown option: ${argument}`);
    } else if (targetVersion === undefined) {
      targetVersion = argument;
    } else {
      fail(`Unexpected argument: ${argument}`);
    }
  }
  const version = targetVersion ?? defaultVersion;
  if (!/^\d+\.\d+\.\d+-rc\.\d+$/.test(version)) {
    fail(`Release bundle requires an rc version such as 1.0.0-rc.1; received ${version}.`);
  }
  return { allowDirty, targetVersion: version };
}

function gitResult(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  return result;
}

function requireGitOutput(args, description) {
  const result = gitResult(args);
  if (result.status !== 0) {
    fail(`Could not determine ${description} from local Git.\n${result.stderr || result.stdout || ""}`);
  }
  return result.stdout.trim();
}

async function collectProvenance(targetVersion, allowDirty) {
  if (requireGitOutput(["rev-parse", "--is-inside-work-tree"], "worktree status") !== "true") {
    fail("Release bundles require a local Git worktree; GitHub or a remote is not required.");
  }
  const sourceCommit = requireGitOutput(["rev-parse", "--verify", "HEAD"], "source commit");
  const sourceTree = requireGitOutput(["rev-parse", "HEAD^{tree}"], "source tree");
  const status = requireGitOutput(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "working-tree status",
  );
  const workingTreeClean = status.length === 0;
  const tag = `v${targetVersion}`;
  const tagResult = gitResult(["show-ref", "--verify", "--quiet", `refs/tags/${tag}`]);
  if (![0, 1].includes(tagResult.status)) fail(`Could not determine whether local tag ${tag} exists.`);
  const tagAvailable = tagResult.status === 1;

  if (!allowDirty && !workingTreeClean) {
    fail(
      "Official release bundles require a clean local commit. " +
      "Commit the intended source first, or use --allow-dirty for an isolated local-evaluation bundle.\n" +
      status,
    );
  }
  if (!allowDirty && !tagAvailable) {
    fail(`Official release bundle target ${tag} is already present locally.`);
  }

  const npmVersion = runCommand(npm, ["--version"], { cwd: root, capture: true }).stdout.trim();
  const releaseTools = await checkInstalledReleaseToolchain(root);
  const [rootLockSha256, exampleLockSha256] = await Promise.all([
    sha256(join(root, "package-lock.json")),
    sha256(join(root, "examples/next-app/package-lock.json")),
  ]);

  return {
    bundleKind: allowDirty ? "local-evaluation" : "official-rc-candidate",
    source: {
      gitHead: sourceCommit,
      gitTree: sourceTree,
      workingTreeClean,
      rootPackageLockSha256: rootLockSha256,
      nextExamplePackageLockSha256: exampleLockSha256,
    },
    target: { version: targetVersion, tag, tagAvailable },
    toolchain: { node: process.version, npm: npmVersion, packages: releaseTools },
  };
}

function packageManifest(artifact) {
  const { entry, pack, sha256: checksum, sourceEvidence } = artifact;
  return {
    package: entry.directory,
    name: pack.name,
    version: pack.version,
    file: pack.filename,
    size: pack.size,
    unpackedSize: pack.unpackedSize,
    sha256: checksum,
    integrity: pack.integrity,
    shasum: pack.shasum,
    source: {
      preferredForm: "src/**/*.ts",
      buildCommand: "npm run build:source",
      buildConfig: "tsconfig.json extending tsconfig.source.json",
      buildControlFileCount: sourceEvidence.buildControlFileCount,
      sourceFileCount: sourceEvidence.sourceFileCount,
      sourceMapCount: sourceEvidence.sourceMapCount,
    },
    files: [...pack.files]
      .sort((left, right) => compareText(left.path, right.path))
      .map(({ path, size, mode }) => ({ path, size, mode })),
  };
}

async function verifyRepeatPack(primary, repeated) {
  if (primary.length !== repeated.length) fail("Repeated npm pack produced a different artifact count.");
  for (let index = 0; index < primary.length; index += 1) {
    const first = primary[index];
    const second = repeated[index];
    if (first.pack.filename !== second.pack.filename || first.sha256 !== second.sha256) {
      fail(
        `npm pack reproducibility check failed for ${first.entry.name}: ` +
        `${first.sha256} != ${second.sha256}. Checksums would not identify a stable current build.`,
      );
    }
  }
}

async function writeBundleMetadata(stagingDirectory, targetVersion, artifacts, provenance, nextEvidence) {
  const manifest = {
    schemaVersion: 1,
    releaseVersion: targetVersion,
    bundleKind: provenance.bundleKind,
    artifactCount: artifacts.length,
    checksumScope:
      "These digests identify the complete packed bytes, including dist, preferred source, build controls, and notices.",
    source: provenance.source,
    target: provenance.target,
    toolchain: provenance.toolchain,
    packages: artifacts.map(packageManifest),
    verification: {
      metadataAndPublishOrder: "passed",
      cleanCommittedSource: {
        status: provenance.bundleKind === "official-rc-candidate" ? "passed" : "bypassed-for-local-evaluation",
        requiredForOfficialBundle: true,
      },
      sharedLegalAndProvenanceFiles: {
        status: "passed",
        comparison: "byte-for-byte with root files",
        files: ["LICENSE", "NOTICE", "UPSTREAM.md"],
      },
      correspondingSource: {
        status: "passed",
        preferredForm: "TypeScript src/** included byte-for-byte",
        rebuildGuide: "SOURCE.md",
        buildConfig: "tsconfig.json extending tsconfig.source.json",
        sourceMaps: "sourcesContent matched packaged source",
        readmeLocalLinks: "all resolved inside each package",
      },
      fixedTarballNextProduction: {
        status: "passed",
        evidence: basename(nextEvidence.evidencePath),
        nextVersion: nextEvidence.summary.nextVersion,
        apiBackendId: nextEvidence.summary.checks.apiFit.backendId,
        browserBackendId: nextEvidence.summary.checks.browserFit.backendId,
        browserVersion: nextEvidence.summary.browserToolchain.actualBrowserVersion,
        committedExampleLockSha256: nextEvidence.summary.install.committedExampleLockSha256,
        installedTreeSha256: nextEvidence.summary.install.installedTree.sha256,
        cancellationAndRecovery: "passed",
      },
      npmPackReproducibility: {
        status: "passed",
        attempts: 2,
        comparison: "byte-identical SHA-256 per tarball in this build environment",
      },
      cleanInstall: {
        status: "passed",
        projectStartedEmpty: true,
        npmCacheStartedEmpty: true,
        npmNetworkMode: "offline",
        lifecycleScripts: "disabled",
        peerDependencyRegistryResolution: "disabled with legacy-peer-deps",
      },
      smokes: RELEASE_VERIFICATIONS.map(({ id, command }) => ({ id, command, status: "passed" })),
    },
  };

  const manifestPath = join(stagingDirectory, "manifest.json");
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (manifestText.includes(root)) fail("Release manifest must not contain an absolute workspace path.");
  await writeFile(manifestPath, manifestText);

  const checksumFiles = [
    ...artifacts.map(({ path }) => ({ file: basename(path), path })),
    { file: basename(nextEvidence.evidencePath), path: nextEvidence.evidencePath },
    { file: "manifest.json", path: manifestPath },
  ].sort((left, right) => compareText(left.file, right.file));
  const checksumRows = [];
  for (const entry of checksumFiles) {
    checksumRows.push(`${await sha256(entry.path)}  ${entry.file}`);
  }
  await writeFile(join(stagingDirectory, "SHA256SUMS"), `${checksumRows.join("\n")}\n`);

  for (const row of checksumRows) {
    const [expected, file] = row.split("  ");
    const actual = await sha256(join(stagingDirectory, file));
    if (actual !== expected) fail(`SHA256SUMS verification failed for ${file}.`);
  }
  return { manifest, checksumRows };
}

async function replaceBundle(stagingDirectory, finalDirectory) {
  const backupDirectory = `${finalDirectory}.previous-${process.pid}`;
  await rm(backupDirectory, { recursive: true, force: true });
  const hadPrevious = await pathExists(finalDirectory);
  if (hadPrevious) await rename(finalDirectory, backupDirectory);

  try {
    await rename(stagingDirectory, finalDirectory);
  } catch (error) {
    if (hadPrevious && !(await pathExists(finalDirectory))) {
      await rename(backupDirectory, finalDirectory);
    }
    throw error;
  }
  if (hadPrevious) await rm(backupDirectory, { recursive: true, force: true });
}

const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const { allowDirty, targetVersion } = parseArguments(process.argv.slice(2), rootManifest.version);
const provenance = await collectProvenance(targetVersion, allowDirty);
const releaseRoot = join(root, ".release");
const finalDirectory = join(releaseRoot, allowDirty ? `${targetVersion}-dev` : targetVersion);

console.log(`jGDINA local offline release bundle: ${targetVersion} (${provenance.bundleKind})`);
await checkVersionsAndOrder(root, targetVersion);

console.log("\nBuilding all seven package distributions...");
runCommand(npm, ["run", "build"], { cwd: root });

await mkdir(releaseRoot, { recursive: true });
const stagingDirectory = await mkdtemp(join(releaseRoot, `.staging-${targetVersion}-`));
const temporaryRoot = await mkdtemp(join(tmpdir(), `jgdina-bundle-${targetVersion}-`));
let replaced = false;

try {
  console.log("\nPacking the retained artifacts...");
  const artifacts = await packReleasePackages({
    root,
    targetVersion,
    destination: stagingDirectory,
  });

  console.log("\nPacking a second independent copy to check byte reproducibility...");
  const repeatedArtifacts = await packReleasePackages({
    root,
    targetVersion,
    destination: join(temporaryRoot, "repeat-packs"),
    quiet: true,
  });
  await verifyRepeatPack(artifacts, repeatedArtifacts);
  console.log("  [ok] all seven repeated npm packs are byte-identical");

  console.log("\nInstalling retained tarballs in offline mode with a new empty npm cache...");
  await smokeInstalledTarballs({
    root,
    targetVersion,
    artifacts,
    installDirectory: join(temporaryRoot, "empty-project"),
    cacheDirectory: join(temporaryRoot, "empty-npm-cache"),
  });

  console.log("\nRunning fixed-tarball Next 16 production build and browser E2E...");
  const nextEvidence = await runNextTarballProductionSmoke({
    root,
    artifacts,
    temporaryRoot,
    evidenceDirectory: stagingDirectory,
  });

  const finalProvenance = await collectProvenance(targetVersion, allowDirty);
  if (JSON.stringify(finalProvenance) !== JSON.stringify(provenance)) {
    fail("Source, lockfiles, toolchain, or target tag changed while the release bundle was being built.");
  }

  console.log("\nWriting deterministic manifest and SHA256SUMS...");
  const { checksumRows } = await writeBundleMetadata(
    stagingDirectory,
    targetVersion,
    artifacts,
    provenance,
    nextEvidence,
  );
  await replaceBundle(stagingDirectory, finalDirectory);
  replaced = true;

  console.log(`\nLocal offline bundle passed and was retained at ${finalDirectory}`);
  for (const row of checksumRows) console.log(`  ${row}`);
  console.log("No registry, Git tag, Git commit, remote, or GitHub state was changed.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
  if (!replaced) await rm(stagingDirectory, { recursive: true, force: true });
}
