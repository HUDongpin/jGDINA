import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { delimiter } from "node:path";

import { RELEASE_PACKAGES, REQUIRED_PACKAGE_FILES, ROOT_SHARED_PACKAGE_FILES } from "./config.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;

function fail(message) {
  throw new Error(message);
}

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
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

export function parsePackJson(output, packageName) {
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed) || parsed.length !== 1) {
      fail(`Unexpected npm pack result for ${packageName}.`);
    }
    return parsed[0];
  } catch (error) {
    fail(`Could not parse npm pack --json output for ${packageName}: ${error.message}\n${output}`);
  }
}

export function checkPackContents(pack, expectedName, targetVersion, additionalSourceFiles = []) {
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
    (path) =>
      !path.startsWith("dist/") &&
      !path.startsWith("src/") &&
      !additionalSourceFiles.includes(path) &&
      !REQUIRED_PACKAGE_FILES.includes(path),
  );
  if (unexpected.length) {
    fail(`${expectedName} tarball contains unexpected files: ${unexpected.join(", ")}`);
  }
}

async function digestFile(path, algorithm, encoding) {
  const contents = await readFile(path);
  return createHash(algorithm).update(contents).digest(encoding);
}

function readPackedFile(tarball, file) {
  const result = spawnSync("tar", ["-xOzf", tarball, `package/${file}`], {
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`Could not read package/${file} from ${tarball}: ${result.stderr?.toString("utf8") || "tar failed"}`);
  }
  return result.stdout;
}

async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listFiles(join(directory, entry.name), relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      fail(`Unsupported non-regular filesystem entry: ${join(directory, entry.name)}`);
    }
  }
  return files.sort();
}

function localMarkdownLinks(markdown) {
  const links = [];
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(pattern)) {
    let target = match[1].trim().split(/\s+['"]/u, 1)[0];
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    if (/^(?:[a-z][a-z+.-]*:|#)/iu.test(target)) continue;
    target = decodeURIComponent(target.split("#", 1)[0].split("?", 1)[0]);
    if (!target) continue;
    const normalized = posix.normalize(target.replace(/^\.\//u, ""));
    if (posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
      fail(`Packed README contains a local link outside its package: ${target}`);
    }
    links.push(normalized);
  }
  return links;
}

async function verifyPackedSource({ root, entry, pack, tarball }) {
  const packedPaths = new Set(pack.files.map(({ path }) => path));
  const rootSourceFiles = await listFiles(join(root, entry.directory, "src"), "src");
  if (rootSourceFiles.length === 0) fail(`${entry.name} has no TypeScript preferred source.`);
  const unsupportedSourceFiles = rootSourceFiles.filter((path) => !path.endsWith(".ts"));
  if (unsupportedSourceFiles.length > 0) {
    fail(`${entry.name} src contains non-TypeScript files: ${unsupportedSourceFiles.join(", ")}`);
  }

  const packedSourceFiles = [...packedPaths].filter((path) => path.startsWith("src/")).sort();
  if (JSON.stringify(packedSourceFiles) !== JSON.stringify(rootSourceFiles)) {
    fail(`${entry.name} tarball does not contain exactly its package TypeScript source tree.`);
  }
  const packedSourceContents = new Map();
  for (const sourcePath of rootSourceFiles) {
    const [rootContents, packedContents] = await Promise.all([
      readFile(join(root, entry.directory, sourcePath)),
      Promise.resolve(readPackedFile(tarball, sourcePath)),
    ]);
    if (!packedContents.equals(rootContents)) {
      fail(`${entry.name} package/${sourcePath} does not match the preferred source byte-for-byte.`);
    }
    packedSourceContents.set(sourcePath, packedContents.toString("utf8"));
  }

  let buildControlFileCount = 4;
  for (const sourceEntry of entry.additionalSourceEntries ?? []) {
    const rootControlFiles = await listFiles(join(root, entry.directory, sourceEntry), sourceEntry);
    const packedControlFiles = [...packedPaths].filter((path) => path.startsWith(`${sourceEntry}/`)).sort();
    const expectedControlFiles = (entry.additionalSourceFiles ?? [])
      .filter((path) => path.startsWith(`${sourceEntry}/`))
      .sort();
    if (
      JSON.stringify(rootControlFiles) !== JSON.stringify(expectedControlFiles) ||
      JSON.stringify(packedControlFiles) !== JSON.stringify(expectedControlFiles)
    ) {
      fail(`${entry.name} must contain exactly the approved ${sourceEntry}/ build controls.`);
    }
    for (const controlPath of rootControlFiles) {
      const [rootContents, packedContents] = await Promise.all([
        readFile(join(root, entry.directory, controlPath)),
        Promise.resolve(readPackedFile(tarball, controlPath)),
      ]);
      if (!packedContents.equals(rootContents)) {
        fail(`${entry.name} package/${controlPath} does not match its build control byte-for-byte.`);
      }
    }
    buildControlFileCount += rootControlFiles.length;
  }

  const sourceGuide = readPackedFile(tarball, "SOURCE.md").toString("utf8");
  for (const requiredText of ["npm run build:source", "tsup `8.5.1`", "TypeScript `5.9.3`"]) {
    if (!sourceGuide.includes(requiredText)) fail(`${entry.name} SOURCE.md is missing ${requiredText}.`);
  }
  const sourceConfig = JSON.parse(readPackedFile(tarball, "tsconfig.source.json").toString("utf8"));
  if (sourceConfig.extends !== undefined || !sourceConfig.include?.includes("src/**/*.ts")) {
    fail(`${entry.name} tsconfig.source.json must be standalone and include src/**/*.ts.`);
  }
  const packageConfig = JSON.parse(readPackedFile(tarball, "tsconfig.json").toString("utf8"));
  if (packageConfig.extends !== "./tsconfig.source.json") {
    fail(`${entry.name} tsconfig.json must use the packaged standalone source configuration.`);
  }

  const readme = readPackedFile(tarball, "README.md").toString("utf8");
  for (const link of localMarkdownLinks(readme)) {
    if (!packedPaths.has(link)) fail(`${entry.name} packed README local link does not exist: ${link}`);
  }

  const sourceMaps = [...packedPaths].filter((path) => path.startsWith("dist/") && path.endsWith(".map")).sort();
  if (sourceMaps.length === 0) fail(`${entry.name} tarball contains no source maps.`);
  for (const mapPath of sourceMaps) {
    const sourceMap = JSON.parse(readPackedFile(tarball, mapPath).toString("utf8"));
    const expectedMapFile = posix.basename(mapPath, ".map");
    if (sourceMap.file !== undefined && sourceMap.file !== expectedMapFile) {
      fail(`${entry.name} ${mapPath} must identify its generated file as ${expectedMapFile}.`);
    }
    if (!Array.isArray(sourceMap.sources) || !Array.isArray(sourceMap.sourcesContent) || sourceMap.sources.length !== sourceMap.sourcesContent.length) {
      fail(`${entry.name} ${mapPath} must contain one sourcesContent entry per source.`);
    }
    for (let index = 0; index < sourceMap.sources.length; index += 1) {
      const declaredSource = sourceMap.sources[index].replaceAll("\\", "/");
      if (posix.isAbsolute(declaredSource) || /^[A-Za-z]:\//u.test(declaredSource)) {
        fail(`${entry.name} ${mapPath} contains machine-local absolute source ${declaredSource}.`);
      }
      const sourcePath = posix.normalize(posix.join(posix.dirname(mapPath), declaredSource));
      if (sourceMap.sourcesContent[index] === null) {
        if (!sourcePath.startsWith("dist/") || !packedPaths.has(sourcePath)) {
          fail(`${entry.name} ${mapPath} has null sourcesContent for non-generated source ${sourcePath}.`);
        }
        continue;
      }
      if (!packedSourceContents.has(sourcePath)) {
        fail(`${entry.name} ${mapPath} references unpackaged source ${sourcePath}.`);
      }
      if (sourceMap.sourcesContent[index] !== packedSourceContents.get(sourcePath)) {
        fail(`${entry.name} ${mapPath} sourcesContent differs from package/${sourcePath}.`);
      }
    }
  }

  return { buildControlFileCount, sourceFileCount: rootSourceFiles.length, sourceMapCount: sourceMaps.length };
}

export async function packReleasePackages({ root, targetVersion, destination, quiet = false }) {
  await mkdir(destination, { recursive: true });
  const artifacts = [];
  const sharedRootFiles = new Map(
    await Promise.all(
      ROOT_SHARED_PACKAGE_FILES.map(async (file) => [file, await readFile(join(root, file))]),
    ),
  );

  for (const entry of RELEASE_PACKAGES) {
    const result = runCommand(
      npm,
      ["pack", "--json", "--pack-destination", destination],
      { capture: true, cwd: join(root, entry.directory) },
    );
    const pack = parsePackJson(result.stdout, entry.name);
    checkPackContents(pack, entry.name, targetVersion, entry.additionalSourceFiles);

    const path = join(destination, pack.filename);
    const [fileStat, sha1, sha256, sha512] = await Promise.all([
      stat(path),
      digestFile(path, "sha1", "hex"),
      digestFile(path, "sha256", "hex"),
      digestFile(path, "sha512", "base64"),
    ]);
    if (fileStat.size !== pack.size) {
      fail(`${entry.name} npm metadata size ${pack.size} does not match ${fileStat.size} bytes on disk.`);
    }
    if (sha1 !== pack.shasum) {
      fail(`${entry.name} npm shasum does not match the tarball bytes.`);
    }
    if (`sha512-${sha512}` !== pack.integrity) {
      fail(`${entry.name} npm integrity does not match the tarball bytes.`);
    }
    for (const [file, rootContents] of sharedRootFiles) {
      const packedContents = readPackedFile(path, file);
      if (!packedContents.equals(rootContents)) {
        fail(`${entry.name} package/${file} does not match the root ${file} byte-for-byte.`);
      }
    }

    const sourceEvidence = await verifyPackedSource({ root, entry, pack, tarball: path });

    artifacts.push({ entry, pack, path, sha256, sourceEvidence });
    if (!quiet) {
      console.log(
        `  [ok] ${entry.name}: ${pack.filename} (${pack.size} bytes, ${pack.files.length} files, ` +
        `${sourceEvidence.sourceFileCount} sources, ${sourceEvidence.sourceMapCount} maps)`,
      );
    }
  }

  return artifacts;
}

async function writeSmokeProject(directory, targetVersion) {
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "jgdina-release-smoke", private: true, type: "module" }, null, 2)}\n`,
  );

  const expectedVersions = Object.fromEntries(RELEASE_PACKAGES.map(({ name }) => [name, targetVersion]));
  await writeFile(
    join(directory, "esm-imports.mjs"),
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

console.log("Installed-tarball ESM import smoke passed.");
`,
  );

  await writeFile(
    join(directory, "cjs-require.cjs"),
    `const assert = require("node:assert/strict");
for (const name of ["jgdina", "@jgdina/core", "@jgdina/kernels-js", "@jgdina/worker-protocol", "@jgdina/node"]) {
  assert.ok(require(name), name);
}
console.log("Installed-tarball CommonJS require smoke passed.");
`,
  );

  await writeFile(
    join(directory, "fixture.mjs"),
    `export const input = {
  responses: [[0, 0], [0, 1], [1, 0], [1, 1]],
  qMatrix: [[1], [1]],
  model: "DINA",
  estimation: { maxIterations: 100, convergenceTolerance: 1e-6, initialization: { starts: 1, seed: 7 } },
};
`,
  );

  await writeFile(
    join(directory, "direct-fit.mjs"),
    `import assert from "node:assert/strict";
import { fit } from "jgdina";
import { input } from "./fixture.mjs";

const result = await fit(input);
assert.equal(result.backendId, "js");
assert.ok(Number.isFinite(result.statistics.logLikelihood));
console.log("Installed-tarball direct fit smoke passed.");
`,
  );

  await writeFile(
    join(directory, "node-worker-fit.mjs"),
    `import assert from "node:assert/strict";
import { fit } from "jgdina";
import { fitInNodeWorker } from "@jgdina/node";
import { input } from "./fixture.mjs";

const directResult = await fit(input);
const workerResult = await fitInNodeWorker(input);
assert.equal(workerResult.backendId, "node-worker:js");
assert.ok(Math.abs(directResult.statistics.logLikelihood - workerResult.statistics.logLikelihood) < 1e-12);
console.log("Installed-tarball Node worker fit smoke passed.");
`,
  );
}

export const SMOKE_COMMANDS = Object.freeze([
  Object.freeze({ id: "esm-imports", file: "esm-imports.mjs" }),
  Object.freeze({ id: "cjs-require", file: "cjs-require.cjs" }),
  Object.freeze({ id: "direct-fit", file: "direct-fit.mjs" }),
  Object.freeze({ id: "node-worker-fit", file: "node-worker-fit.mjs" }),
]);

export const RELEASE_VERIFICATIONS = Object.freeze([
  ...SMOKE_COMMANDS.map(({ id, file }) => Object.freeze({ id, command: `node ${file}` })),
  Object.freeze({ id: "tree-shaken-side-effects", command: "esbuild Node and browser side-effect entry bundles" }),
  Object.freeze({ id: "source-rebuild", command: "npm run build:source in all seven installed packages" }),
  Object.freeze({ id: "rebuilt-runtime", command: "repeat four runtime smokes against rebuilt dist" }),
]);

export function installReleaseTarballsOffline({ artifacts, directory, cacheDirectory }) {
  const offlineEnvironment = {
    npm_config_audit: "false",
    npm_config_cache: cacheDirectory,
    npm_config_fund: "false",
    npm_config_offline: "true",
    npm_config_prefer_offline: "true",
    npm_config_registry: "http://127.0.0.1:9/",
  };
  runCommand(
    npm,
    [
      "install",
      "--offline",
      "--prefer-offline",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      ...artifacts.map(({ path }) => path),
    ],
    { cwd: directory, env: offlineEnvironment },
  );
}

async function verifyTreeShakenSideEffects(root, installDirectory) {
  const esbuild = join(root, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");
  await Promise.all([
    writeFile(join(installDirectory, "node-side-effect-entry.mjs"), 'import "@jgdina/node";\nconsole.log("node side effect loaded");\n'),
    writeFile(join(installDirectory, "browser-side-effect-entry.mjs"), 'import "@jgdina/browser/worker";\n'),
  ]);
  runCommand(
    esbuild,
    ["node-side-effect-entry.mjs", "--bundle", "--platform=node", "--format=esm", "--tree-shaking=true", "--outfile=node-side-effect-bundle.mjs"],
    { cwd: installDirectory },
  );
  runCommand(
    esbuild,
    ["browser-side-effect-entry.mjs", "--bundle", "--platform=browser", "--format=esm", "--tree-shaking=true", "--outfile=browser-side-effect-bundle.mjs"],
    { cwd: installDirectory },
  );
  const [nodeBundle, browserBundle] = await Promise.all([
    readFile(join(installDirectory, "node-side-effect-bundle.mjs"), "utf8"),
    readFile(join(installDirectory, "browser-side-effect-bundle.mjs"), "utf8"),
  ]);
  if (!nodeBundle.includes("configureDefaultNodeWorkerFactory") || !nodeBundle.includes("worker-entry.js")) {
    fail("Tree-shaken @jgdina/node bundle dropped essential default Worker initialization.");
  }
  if (!browserBundle.includes("onmessage") || !browserBundle.includes("browser-worker:js")) {
    fail("Tree-shaken @jgdina/browser/worker bundle dropped essential Worker message initialization.");
  }
  runCommand(node, ["node-side-effect-bundle.mjs"], { cwd: installDirectory });
  console.log("Installed-tarball tree-shaken side-effect smoke passed.");
}

async function rebuildInstalledSources(root, installDirectory) {
  const typesDirectory = join(installDirectory, "node_modules", "@types");
  await Promise.all([
    mkdir(typesDirectory, { recursive: true }),
    mkdir(join(installDirectory, "source-rebuild"), { recursive: true }),
  ]);
  await Promise.all([
    cp(join(root, "node_modules", "@types", "node"), join(typesDirectory, "node"), { recursive: true }),
    cp(join(root, "node_modules", "typescript"), join(installDirectory, "node_modules", "typescript"), { recursive: true }),
    cp(join(root, "node_modules", "undici-types"), join(installDirectory, "node_modules", "undici-types"), { recursive: true }),
  ]);
  const sourceBuildEnvironment = {
    PATH: `${join(root, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
  };
  const rebuiltPackages = [];
  for (const { name } of RELEASE_PACKAGES) {
    const parts = name.startsWith("@") ? name.split("/") : [name];
    const installedPackage = join(installDirectory, "node_modules", ...parts);
    const rebuildPackage = join(installDirectory, "source-rebuild", name.replaceAll("@", "").replaceAll("/", "-"));
    await cp(installedPackage, rebuildPackage, { recursive: true });
    runCommand(npm, ["run", "build:source", "--ignore-scripts"], {
      cwd: rebuildPackage,
      env: sourceBuildEnvironment,
    });
    const [installedDistFiles, rebuiltDistFiles] = await Promise.all([
      listFiles(join(installedPackage, "dist")),
      listFiles(join(rebuildPackage, "dist")),
    ]);
    if (JSON.stringify(installedDistFiles) !== JSON.stringify(rebuiltDistFiles)) {
      fail(`${name} preferred-source rebuild produced a different dist file set.`);
    }
    for (const file of installedDistFiles) {
      const [installedContents, rebuiltContents] = await Promise.all([
        readFile(join(installedPackage, "dist", file)),
        readFile(join(rebuildPackage, "dist", file)),
      ]);
      if (!installedContents.equals(rebuiltContents)) {
        fail(`${name} preferred-source rebuild differs from packed dist/${file}.`);
      }
    }
    rebuiltPackages.push({ installedPackage, rebuildPackage });
  }
  for (const { installedPackage, rebuildPackage } of rebuiltPackages) {
    await rm(join(installedPackage, "dist"), { recursive: true, force: true });
    await cp(join(rebuildPackage, "dist"), join(installedPackage, "dist"), { recursive: true });
  }
  console.log("Installed-tarball preferred-source rebuild is byte-identical for all seven packages.");
}

export async function smokeInstalledTarballs({ root, targetVersion, artifacts, installDirectory, cacheDirectory }) {
  await Promise.all([
    mkdir(installDirectory, { recursive: true }),
    mkdir(cacheDirectory, { recursive: true }),
  ]);
  const [installEntries, cacheEntries] = await Promise.all([
    readdir(installDirectory),
    readdir(cacheDirectory),
  ]);
  if (installEntries.length !== 0) fail("Installed-tarball smoke project must start empty.");
  if (cacheEntries.length !== 0) fail("Installed-tarball smoke npm cache must start empty.");
  await writeSmokeProject(installDirectory, targetVersion);

  installReleaseTarballsOffline({ artifacts, directory: installDirectory, cacheDirectory });

  for (const smoke of SMOKE_COMMANDS) {
    runCommand(node, [smoke.file], { cwd: installDirectory });
  }
  await verifyTreeShakenSideEffects(root, installDirectory);
  await rebuildInstalledSources(root, installDirectory);
  for (const smoke of SMOKE_COMMANDS) {
    runCommand(node, [smoke.file], { cwd: installDirectory });
  }
  console.log("Installed-tarball rebuilt-distribution runtime smokes passed.");
}
