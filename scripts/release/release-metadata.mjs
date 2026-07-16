import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  PACKAGE_SOURCE_ENTRIES,
  RELEASE_PACKAGES,
  RELEASE_TOOL_VERSIONS,
  REQUIRED_PACKAGE_FILES,
  SOURCE_BUILD_TOOL_VERSIONS,
} from "./config.mjs";

function fail(message) {
  throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function installedPackagePath(root, name) {
  const segments = name.startsWith("@") ? name.split("/") : [name];
  return join(root, "node_modules", ...segments, "package.json");
}

export async function checkInstalledReleaseToolchain(root, lock = undefined) {
  const rootLock = lock ?? await readJson(join(root, "package-lock.json"));
  const actual = {};
  for (const [name, expectedVersion] of Object.entries(RELEASE_TOOL_VERSIONS)) {
    const lockedVersion = rootLock.packages?.[`node_modules/${name}`]?.version;
    if (lockedVersion !== expectedVersion) {
      fail(`package-lock.json resolves ${name}@${lockedVersion ?? "missing"}, expected ${expectedVersion}.`);
    }
    let installed;
    try {
      installed = await readJson(installedPackagePath(root, name));
    } catch (error) {
      if (error?.code === "ENOENT") fail(`Missing installed release tool ${name}; run npm ci.`);
      throw error;
    }
    if (installed.version !== expectedVersion) {
      fail(`Installed ${name}@${installed.version ?? "unknown"}, expected locked ${expectedVersion}.`);
    }
    actual[name] = installed.version;
  }
  return actual;
}

export async function checkVersionsAndOrder(root, targetVersion) {
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
    const expectedNodeEngine = entry.nodeEngine ?? ">=20";
    if (manifest.engines?.node !== expectedNodeEngine) {
      fail(`${manifest.name} must retain the Node ${expectedNodeEngine} contract.`);
    }
    assert.deepEqual(manifest.sideEffects, entry.sideEffects, `${manifest.name} has an unsafe sideEffects contract.`);
    assert.deepEqual(
      manifest.peerDependencies,
      entry.peerDependencies,
      `${manifest.name} has an unverified peer-dependency contract.`,
    );
    for (const file of [
      ...REQUIRED_PACKAGE_FILES.slice(1),
      ...PACKAGE_SOURCE_ENTRIES,
      ...(entry.additionalSourceEntries ?? []),
    ]) {
      if (!manifest.files?.includes(file)) fail(`${manifest.name} does not include ${file} in its npm files list.`);
    }
    if (!manifest.files?.includes("dist")) fail(`${manifest.name} does not include dist in its npm files list.`);
    if (manifest.scripts?.["build:source"] !== "npm run build") {
      fail(`${manifest.name} must provide a standalone build:source command through its packaged build controls.`);
    }
    const expectedDevDependencies = {
      ...(entry.nodeTypes ? { "@types/node": SOURCE_BUILD_TOOL_VERSIONS["@types/node"] } : {}),
      tsup: SOURCE_BUILD_TOOL_VERSIONS.tsup,
      typescript: SOURCE_BUILD_TOOL_VERSIONS.typescript,
    };
    assert.deepEqual(
      manifest.devDependencies,
      expectedDevDependencies,
      `${manifest.name} must pin the independently rebuildable source toolchain exactly.`,
    );
    if (manifest.name === "@jgdina/node" && !manifest.scripts.build.includes("--format cjs --sourcemap")) {
      fail("@jgdina/node must emit source maps for its CommonJS build.");
    }
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
    const expectedDevDependencies = manifests.get(name).manifest.devDependencies;
    assert.deepEqual(
      lock.packages?.[directory]?.devDependencies,
      expectedDevDependencies,
      `package-lock.json does not preserve ${name}'s pinned source-build toolchain.`,
    );
    assert.deepEqual(
      lock.packages?.[directory]?.peerDependencies,
      manifests.get(name).manifest.peerDependencies,
      `package-lock.json does not preserve ${name}'s verified peer range.`,
    );
  }
  const installedToolchain = await checkInstalledReleaseToolchain(root, lock);

  const example = await readJson(join(root, "examples/next-app/package.json"));
  const exampleLock = await readJson(join(root, "examples/next-app/package-lock.json"));
  if (example.version !== targetVersion || exampleLock.version !== targetVersion || exampleLock.packages?.[""]?.version !== targetVersion) {
    fail("The Next.js example manifest and lock must match the release candidate version.");
  }

  const expectedExamplePackages = RELEASE_PACKAGES.filter(({ name }) => name in (example.dependencies ?? {}));
  const expectedExampleNames = expectedExamplePackages.map(({ name }) => name).sort();
  const lockedExampleNames = Object.keys(exampleLock.packages ?? {})
    .filter((key) => key.startsWith("node_modules/@jgdina/"))
    .map((key) => key.replace("node_modules/", ""))
    .sort();
  assert.deepEqual(
    lockedExampleNames,
    expectedExampleNames,
    "The Next.js example lock must cover exactly its local @jgdina dependencies.",
  );

  for (const { directory, name } of expectedExamplePackages) {
    const expectedResolved = `file:../../${directory}`;
    if (example.dependencies[name] !== expectedResolved) {
      fail(`The Next.js example dependency ${name} must resolve from ${expectedResolved}.`);
    }
    const locked = exampleLock.packages?.[`node_modules/${name}`];
    if (locked?.version !== targetVersion) {
      fail(`The Next.js example lock entry for ${name} is ${locked?.version ?? "missing"}, expected ${targetVersion}.`);
    }
    if (locked.resolved !== expectedResolved) {
      fail(`The Next.js example lock entry for ${name} resolves to ${locked.resolved ?? "missing"}, expected ${expectedResolved}.`);
    }
    for (const [dependency, range] of Object.entries(locked.dependencies ?? {})) {
      if (manifests.has(dependency) && range !== targetVersion) {
        fail(`The Next.js example lock entry for ${name} pins ${dependency} to ${range}, expected ${targetVersion}.`);
      }
    }
  }

  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
  if (!changelog.includes(`## [${targetVersion}]`)) {
    fail(`CHANGELOG.md has no ${targetVersion} release entry.`);
  }

  console.log(
    `  [ok] ${RELEASE_PACKAGES.length} manifests, exact internal dependencies, and all root/example lock entries use ${targetVersion}`,
  );
  console.log(
    `  [ok] Installed release toolchain matches the lock: ${Object.entries(installedToolchain)
      .map(([name, version]) => `${name}@${version}`)
      .join(", ")}`,
  );
  console.log(`  [ok] ${expectedExamplePackages.length} Next.js example packages resolve from the expected local file paths`);
  console.log(`  [ok] Publish order is topologically valid: ${RELEASE_PACKAGES.map(({ name }) => name).join(" -> ")}`);
}
