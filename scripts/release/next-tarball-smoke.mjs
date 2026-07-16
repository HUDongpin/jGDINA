import { createHash } from "node:crypto";
import { cp, lstat, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

import { RELEASE_PACKAGES } from "./config.mjs";
import { runCommand } from "./package-artifacts.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;

function fail(message) {
  throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function packagePath(directory, name) {
  return join(directory, "node_modules", ...(name.startsWith("@") ? name.split("/") : [name]));
}

async function copyExampleSource(source, destination) {
  const excluded = new Set([".next", "node_modules", "package-lock.json", "tsconfig.tsbuildinfo"]);
  await cp(source, destination, {
    recursive: true,
    filter(path) {
      if (path === source) return true;
      const topLevel = relative(source, path).split(sep, 1)[0];
      return !excluded.has(topLevel);
    },
  });
}

function localTarballSpec(project, artifact) {
  const relativePath = relative(project, artifact.path).split(sep).join("/");
  return `file:${relativePath.startsWith(".") ? relativePath : `./${relativePath}`}`;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function hashInstalledTree(directory) {
  const hash = createHash("sha256");
  let entries = 0;
  let fileBytes = 0;
  async function visit(current, prefix = "") {
    const children = await readdir(current, { withFileTypes: true });
    children.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const child of children) {
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      if (relativePath === ".package-lock.json") continue;
      const absolutePath = join(current, child.name);
      const stats = await lstat(absolutePath);
      const mode = (stats.mode & 0o777).toString(8);
      entries += 1;
      if (stats.isDirectory()) {
        hash.update(`directory\0${relativePath}\0${mode}\n`);
        await visit(absolutePath, relativePath);
      } else if (stats.isFile()) {
        const contents = await readFile(absolutePath);
        fileBytes += contents.byteLength;
        hash.update(`file\0${relativePath}\0${mode}\0${contents.byteLength}\0`);
        hash.update(createHash("sha256").update(contents).digest("hex"));
        hash.update("\n");
      } else if (stats.isSymbolicLink()) {
        hash.update(`symlink\0${relativePath}\0${mode}\0${await readlink(absolutePath)}\n`);
      } else {
        fail(`Unsupported installed dependency entry: ${relativePath}`);
      }
    }
  }
  await visit(directory);
  return {
    algorithm: "sha256-path-type-mode-size-content",
    excludes: ["node_modules/.package-lock.json (temporary tarball paths; committed lock hashed separately)"],
    entries,
    fileBytes,
    sha256: hash.digest("hex"),
  };
}

function rewriteLockForTarballs({ project, artifacts, manifest, lock }) {
  const artifactByName = new Map(artifacts.map((artifact) => [artifact.entry.name, artifact]));
  const installedTarballs = [];
  for (const { name } of RELEASE_PACKAGES) {
    if (!(name in manifest.dependencies)) continue;
    const artifact = artifactByName.get(name);
    if (artifact === undefined) fail(`Missing fixed tarball for ${name}.`);
    const spec = localTarballSpec(project, artifact);
    manifest.dependencies[name] = spec;
    lock.packages[""].dependencies[name] = spec;
    const locked = lock.packages[`node_modules/${name}`];
    if (locked === undefined) fail(`The committed Next lock has no ${name} entry.`);
    locked.resolved = spec;
    locked.integrity = artifact.pack.integrity;
    installedTarballs.push(name);
  }
  if (installedTarballs.length === 0) fail("The Next app lock contains no jGDINA packages.");
  return installedTarballs;
}

function installLockedTarballAppOffline(project) {
  runCommand(
    npm,
    [
      "ci",
      "--offline",
      "--prefer-offline",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
    ],
    {
      cwd: project,
      env: {
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_offline: "true",
        npm_config_prefer_offline: "true",
        npm_config_registry: "http://127.0.0.1:9/",
      },
    },
  );
}

export async function runNextTarballProductionSmoke({ root, artifacts, temporaryRoot, evidenceDirectory }) {
  const sourceExample = join(root, "examples", "next-app");
  const project = join(temporaryRoot, "fixed-tarball-next-app");
  const detailedOutput = join(temporaryRoot, "fixed-tarball-browser-evidence");
  await copyExampleSource(sourceExample, project);

  const exampleManifest = await readJson(join(sourceExample, "package.json"));
  const exampleLockContents = await readFile(join(sourceExample, "package-lock.json"));
  const exampleLock = JSON.parse(exampleLockContents.toString("utf8"));
  const finalManifest = structuredClone(exampleManifest);
  const finalLock = structuredClone(exampleLock);
  const installedTarballs = rewriteLockForTarballs({
    project,
    artifacts,
    manifest: finalManifest,
    lock: finalLock,
  });
  await writeFile(join(project, "package.json"), `${JSON.stringify(finalManifest, null, 2)}\n`);
  await writeFile(join(project, "package-lock.json"), `${JSON.stringify(finalLock, null, 2)}\n`);

  installLockedTarballAppOffline(project);
  const installedTreeBefore = await hashInstalledTree(join(project, "node_modules"));

  const artifactByName = new Map(artifacts.map((artifact) => [artifact.entry.name, artifact]));
  for (const name of installedTarballs) {
    const installed = await readJson(join(packagePath(project, name), "package.json"));
    if (installed.version !== artifactByName.get(name)?.pack.version) {
      fail(`Fixed-tarball Next smoke installed ${name}@${installed.version}.`);
    }
  }
  const installedNext = await readJson(join(project, "node_modules", "next", "package.json"));
  const lockedNext = exampleLock.packages?.["node_modules/next"]?.version;
  if (installedNext.version !== lockedNext || !/^16\./u.test(installedNext.version)) {
    fail(`Fixed-tarball Next smoke expected locked Next 16, got ${installedNext.version}.`);
  }

  const buildEnvironment = { NEXT_TELEMETRY_DISABLED: "1" };
  runCommand(npm, ["run", "typecheck"], { cwd: project, env: buildEnvironment });
  runCommand(npm, ["run", "build"], { cwd: project, env: buildEnvironment });

  const dependencyMode =
    `${installedTarballs.length} fixed RC tarballs and every non-jGDINA dependency installed by npm ci ` +
    "from a temporary rewrite of the committed Next lock in forced-offline mode with a prewarmed cache; " +
    `all ${artifacts.length} tarballs separately passed the new-empty-cache install smoke`;
  runCommand(node, [join(root, "scripts", "next-production-smoke.mjs")], {
    cwd: root,
    env: {
      JGDINA_NEXT_DEPENDENCY_MODE: dependencyMode,
      JGDINA_NEXT_EXAMPLE_DIR: project,
      JGDINA_NEXT_SMOKE_OUTPUT: detailedOutput,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });
  const report = await readJson(join(detailedOutput, "report.json"));
  if (report.status !== "passed") fail("Fixed-tarball Next production browser smoke did not pass.");
  const installedTreeAfter = await hashInstalledTree(join(project, "node_modules"));
  if (JSON.stringify(installedTreeAfter) !== JSON.stringify(installedTreeBefore)) {
    fail("The installed dependency tree changed during the fixed-tarball Next production test.");
  }

  const summary = {
    schemaVersion: 1,
    status: "passed",
    dependencyMode,
    releaseVersion: artifacts[0].pack.version,
    packageCount: RELEASE_PACKAGES.length,
    nextVersion: installedNext.version,
    browserToolchain: {
      playwrightCliPackage: report.runtime.playwrightCliPackage,
      playwrightCliVersion: report.runtime.playwrightCliVersion,
      requestedBrowser: report.runtime.browser,
      actualBrowserVersion: report.checks.home.browserVersion,
    },
    install: {
      projectStartedFresh: true,
      fixedTarballsInstalledFromLock: installedTarballs.length,
      allReleaseTarballsValidatedWithEmptyCache: artifacts.length,
      committedExampleLockSha256: sha256(exampleLockContents),
      npmNetworkMode: "offline with unreachable registry",
      externalDependencyCache: "prewarmed npm cache; integrity enforced by committed package-lock.json",
      lifecycleScripts: "disabled",
      installedTree: installedTreeAfter,
    },
    checks: {
      productionBuild: {
        browserWorkerAssetCount: report.checks.build.browserWorkerAssets.length,
        nodeWorkerTracePresent: Boolean(report.checks.build.tracedNodeWorker),
      },
      apiFit: {
        backendId: report.checks.apiFit.backendId,
        converged: report.checks.apiFit.converged,
        httpStatus: report.checks.apiFit.httpStatus,
      },
      apiErrors: Object.fromEntries(
        Object.entries(report.checks.apiErrors).map(([name, result]) => [
          name,
          { status: result.status, code: result.payload.error.code },
        ]),
      ),
      browserFit: {
        backendId: report.checks.clientFit.backendId,
        converged: report.checks.clientFit.converged,
        workerAssetLoaded: report.checks.clientFit.workerResponses.some(({ status }) => status === 200),
      },
      browserCancellation: {
        cancelled: report.checks.clientCancellation.cancelledText.startsWith("Cancelled:"),
        recoveryBackendId: report.checks.clientCancellation.recoveryBackendId,
        recoveryConverged: report.checks.clientCancellation.recoveryConverged,
      },
      browserErrors: {
        scope: "API fit, browser fit, cancellation/recovery, and full-session console capture",
        console: report.checks.fullSessionConsole.errors,
        page:
          report.checks.apiFit.pageErrors.length +
          report.checks.clientFit.pageErrors.length +
          report.checks.clientCancellation.pageErrors.length,
        network:
          report.checks.apiFit.failedRequests.length +
          report.checks.clientFit.failedRequests.length +
          report.checks.clientCancellation.failedRequests.length,
      },
    },
  };
  const evidencePath = join(evidenceDirectory, "next-production-e2e.json");
  await writeFile(evidencePath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Fixed-tarball Next 16 production E2E passed: ${basename(evidencePath)}`);
  return { evidencePath, summary };
}
