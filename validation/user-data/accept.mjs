#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { resourceUsage } from "node:process";

import {
  DEFAULT_RESOURCE_LIMITS,
  assertWithinResourceLimits,
  validateFitInput,
} from "../../packages/core/dist/index.js";
import { fitInNodeWorker } from "../../packages/node/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const caseSchemaVersion = "jgdina-user-case/1";
const oracleSchemaVersion = "jgdina-user-oracle/1";
const maxCaseBytes = 16 * 1024 ** 2;
const frozenUpstreamCommit = "ac5eca223a1ee32b6c2f595cfeaef9b330451425";
const frozenUpstreamTreeSha256 = "22c560cd3d1839ee2803a74923af9e34154cd2f6bc2294a2482392aa90247008";
const frozenKernelRelativePath = "GDINA-master/src/Lik2.cpp";
const frozenKernelSha256 = "d798410e134db64882666d997344130a6eb43fe3918e2b92ccd4c5f4681f2788";
const equationsRelativePath = "validation/generate-fixtures.R";
const equationsSha256 = "ad7a59752f75852a03e988f38a6ac05ae67a56fe284923907110d12ff3a884b9";
const oracleRelativePath = "validation/user-data/oracle.R";
const oracleSha256 = "7c1d575ce465cd5fbab3fc0a877fed1f82c263a6feb0171874ee866fad3ea50b";
const compilerConfigurationKeys = Object.freeze([
  "CPPFLAGS",
  "CXX",
  "CXXFLAGS",
  "FLIBS",
  "LDFLAGS",
  "MAKEVARS_USER",
]);
const defaultTolerances = Object.freeze({
  probabilityAbsolute: 1e-8,
  probabilityRelative: 1e-12,
  logLikelihoodAbsolute: 1e-7,
  logLikelihoodRelative: 1e-12,
  classificationAgreement: 1,
});
const toleranceNames = Object.freeze(Object.keys(defaultTolerances));
const jgdinaVersion = JSON.parse(
  await readFile(join(root, "packages/node/package.json"), "utf8"),
).version;

let activeOracleChild = null;
let activeOracleClosed = null;
let activeSensitiveDirectory = null;
let activeEvidenceStaging = null;
let handlingSignal = false;

function killOracleProcess(child) {
  if (child === null) return;
  if (process.platform !== "win32" && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct child when its process group is already gone.
    }
  }
  child.kill("SIGKILL");
}

for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => {
    if (handlingSignal) return;
    handlingSignal = true;
    const child = activeOracleChild;
    const closed = activeOracleClosed;
    killOracleProcess(child);
    void (async () => {
      if (closed !== null) {
        await Promise.race([
          closed,
          new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
        ]);
      }
      if (activeSensitiveDirectory !== null) {
        await rm(activeSensitiveDirectory, { recursive: true, force: true }).catch(() => {});
      }
      if (activeEvidenceStaging !== null) {
        await rm(activeEvidenceStaging, { recursive: true, force: true }).catch(() => {});
      }
      process.exit(exitCode);
    })();
  });
}

class AcceptanceError extends Error {
  constructor(code, message, exitCode = 64) {
    super(message);
    this.name = "AcceptanceError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, message, exitCode = 64) {
  throw new AcceptanceError(code, message, exitCode);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readVerifiedFrozenKernel() {
  let snapshot;
  try {
    snapshot = JSON.parse(
      await readFile(join(root, "validation/upstream-snapshot.json"), "utf8"),
    );
  } catch {
    fail("FROZEN_SOURCE", "The canonical frozen-upstream snapshot is unreadable.", 66);
  }
  const recordedKernel = snapshot?.files?.find?.(
    (entry) => entry?.path === frozenKernelRelativePath,
  );
  if (
    snapshot.upstream?.recordedCommit !== frozenUpstreamCommit ||
    snapshot.treeSha256 !== frozenUpstreamTreeSha256 ||
    recordedKernel?.sha256 !== frozenKernelSha256
  ) {
    fail("FROZEN_SOURCE", "The canonical frozen-upstream snapshot identity is inconsistent.", 66);
  }
  let source;
  try {
    source = await readFile(join(root, frozenKernelRelativePath));
  } catch {
    fail("FROZEN_SOURCE", "The frozen C++ kernel source is unavailable.", 66);
  }
  if (sha256(source) !== frozenKernelSha256) {
    fail("FROZEN_SOURCE", "The frozen C++ kernel source does not match its audited SHA-256.", 66);
  }
  return source;
}

async function readVerifiedOracleSources(includeKernel) {
  let oracleSource;
  let equationsSource;
  try {
    [oracleSource, equationsSource] = await Promise.all([
      readFile(join(root, oracleRelativePath)),
      readFile(join(root, equationsRelativePath)),
    ]);
  } catch {
    fail("ORACLE_SOURCE", "A pinned local R oracle source is unavailable.", 66);
  }
  if (sha256(oracleSource) !== oracleSha256 || sha256(equationsSource) !== equationsSha256) {
    fail("ORACLE_SOURCE", "A pinned local R oracle source failed its SHA-256 check.", 66);
  }
  return {
    oracleSource,
    equationsSource,
    kernelSource: includeKernel ? await readVerifiedFrozenKernel() : null,
  };
}

async function localGitMetadata() {
  const run = (arguments_) => new Promise((resolvePromise) => {
    const child = spawn("git", arguments_, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (output.length < 64 * 1024) output += chunk;
    });
    child.once("error", () => resolvePromise(null));
    child.once("close", (code) => resolvePromise(code === 0 ? output.trim() : null));
  });
  const [head, trackedStatus] = await Promise.all([
    run(["rev-parse", "HEAD"]),
    run(["status", "--porcelain=v1", "--untracked-files=no"]),
  ]);
  return {
    head: typeof head === "string" && /^[a-f0-9]{40}$/u.test(head) ? head : null,
    trackedWorkingTreeClean: trackedStatus === null ? null : trackedStatus.length === 0,
  };
}

async function runtimeArtifactFingerprint() {
  const runtimePaths = [
    "package-lock.json",
    "packages/core/package.json",
    "packages/core/dist/index.js",
    "packages/kernels-js/package.json",
    "packages/kernels-js/dist/index.js",
    "packages/node/package.json",
    "packages/node/dist/index.js",
    "packages/node/dist/worker-entry.js",
    "packages/worker-protocol/package.json",
    "packages/worker-protocol/dist/index.js",
  ];
  const tree = createHash("sha256");
  let totalBytes = 0;
  for (const path of runtimePaths) {
    let contents;
    try {
      contents = await readFile(join(root, path));
    } catch {
      fail("RUNTIME_ARTIFACT", "A required built runtime artifact is unavailable.", 66);
    }
    const fileHash = sha256(contents);
    totalBytes += contents.byteLength;
    tree.update(path, "utf8");
    tree.update("\0");
    tree.update(String(contents.byteLength), "ascii");
    tree.update("\0");
    tree.update(fileHash, "ascii");
    tree.update("\n");
  }
  return {
    algorithm: "sha256(path+NUL+bytes+NUL+fileSha256+LF)-ordered-v1",
    fileCount: runtimePaths.length,
    totalBytes,
    treeSha256: tree.digest("hex"),
    acceptCliSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    localGit: await localGitMetadata(),
  };
}

function sanitizedLocalPath(value) {
  let sanitized = value;
  for (const [sensitive, replacement] of [
    [root, "<workspace>"],
    [process.env.HOME, "<home>"],
  ]) {
    if (typeof sensitive === "string" && sensitive.length > 0) {
      sanitized = sanitized.replaceAll(sensitive, replacement);
    }
  }
  return sanitized;
}

async function directoryTreeFingerprint(value) {
  let directory;
  try {
    directory = await realpath(value);
  } catch {
    fail("ORACLE_TOOLCHAIN", "An R package directory is unavailable.", 66);
  }
  const rootMetadata = await lstat(directory);
  if (!rootMetadata.isDirectory()) {
    fail("ORACLE_TOOLCHAIN", "An R package path is not a directory.", 66);
  }
  const tree = createHash("sha256");
  let fileCount = 0;
  let totalBytes = 0;
  const visit = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) {
        fail("ORACLE_TOOLCHAIN", "R package fingerprints reject symlink/special entries.", 66);
      }
      const metadata = await lstat(path);
      if (
        !metadata.isFile() ||
        metadata.size < 0 ||
        metadata.size > 64 * 1024 ** 2 ||
        totalBytes + metadata.size > 512 * 1024 ** 2
      ) {
        fail("ORACLE_TOOLCHAIN", "An R package file exceeds the fingerprint safety limit.", 66);
      }
      const contents = await readFile(path);
      if (contents.byteLength !== metadata.size) {
        fail("ORACLE_TOOLCHAIN", "An R package file changed during fingerprinting.", 66);
      }
      fileCount += 1;
      totalBytes += contents.byteLength;
      if (fileCount > 50_000) {
        fail("ORACLE_TOOLCHAIN", "An R package tree exceeds the fingerprint safety limit.", 66);
      }
      const relativePath = relative(directory, path).replaceAll("\\", "/");
      tree.update(relativePath, "utf8");
      tree.update("\0");
      tree.update(String(contents.byteLength), "ascii");
      tree.update("\0");
      tree.update(sha256(contents), "ascii");
      tree.update("\n");
    }
  };
  await visit(directory);
  return {
    path: sanitizedLocalPath(directory),
    fileCount,
    totalBytes,
    treeSha256: tree.digest("hex"),
  };
}

async function fingerprintROraclePackages(packages) {
  const output = {};
  for (const name of ["jsonlite", "Rcpp", "RcppArmadillo"]) {
    const metadata = packages[name];
    if (metadata === null) {
      output[name] = null;
      continue;
    }
    output[name] = {
      version: metadata.version,
      ...(await directoryTreeFingerprint(metadata.path)),
    };
  }
  return output;
}

function stableSha256(value) {
  const hash = createHash("sha256");
  let buffer = "";
  const append = (text) => {
    buffer += text;
    if (buffer.length >= 64 * 1024) {
      hash.update(buffer);
      buffer = "";
    }
  };
  const visit = (current) => {
    if (Array.isArray(current)) {
      append("[");
      current.forEach((entry, index) => {
        if (index > 0) append(",");
        visit(entry);
      });
      append("]");
      return;
    }
    if (isRecord(current)) {
      append("{");
      Object.keys(current).sort().forEach((key, index) => {
        if (index > 0) append(",");
        append(`${JSON.stringify(key)}:`);
        visit(current[key]);
      });
      append("}");
      return;
    }
    const encoded = JSON.stringify(current);
    if (encoded === undefined) fail("INTERNAL", "Cannot hash a non-JSON value.", 70);
    append(encoded);
  };
  visit(value);
  if (buffer.length > 0) hash.update(buffer);
  return hash.digest("hex");
}

function parseArguments(arguments_) {
  if (arguments_.length === 1 && ["--help", "-h"].includes(arguments_[0])) {
    return { help: true };
  }
  const options = { oracle: "kernel", preflight: false };
  const seen = new Set();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--preflight") {
      if (seen.has(argument)) fail("CLI_ARGUMENT", "Each option may be supplied only once.");
      seen.add(argument);
      options.preflight = true;
      continue;
    }
    if (!["--case", "--out", "--oracle"].includes(argument)) {
      fail("CLI_ARGUMENT", "Unknown argument. Use --help for the accepted syntax.");
    }
    if (seen.has(argument)) fail("CLI_ARGUMENT", "Each option may be supplied only once.");
    seen.add(argument);
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("CLI_ARGUMENT", `${argument} requires a value.`);
    }
    index += 1;
    if (argument === "--case") options.casePath = value;
    if (argument === "--out") options.outputPath = value;
    if (argument === "--oracle") options.oracle = value;
  }
  if (options.casePath === undefined) fail("CLI_ARGUMENT", "--case is required.");
  if (!options.preflight && options.outputPath === undefined) {
    fail("CLI_ARGUMENT", "--out is required unless --preflight is used.");
  }
  if (!["kernel", "base-r", "none"].includes(options.oracle)) {
    fail("CLI_ARGUMENT", "--oracle must be kernel, base-r, or none.");
  }
  return options;
}

function isWithin(parent, candidate) {
  const normalizedParent = process.platform === "win32" ? parent.toLowerCase() : parent;
  const normalizedCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const path = relative(normalizedParent, normalizedCandidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function assertNoExtendedAcl(path, code) {
  const modeToken = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("/bin/ls", ["-ld", path], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (output.length < 4_096) output += chunk;
    });
    child.once("error", rejectPromise);
    child.once("close", (exitCode) => {
      if (exitCode !== 0) rejectPromise(new Error("ACL probe failed"));
      else resolvePromise(output.trimStart().split(/\s+/u)[0] ?? "");
    });
  }).catch(() => {
    fail("PLATFORM_PRIVACY", "The local filesystem ACL state could not be verified.", 69);
  });
  if (typeof modeToken !== "string" || !/^[dl-]/u.test(modeToken) || modeToken.includes("+")) {
    fail(code, "Extended filesystem ACLs are not accepted for private workflow paths.", 65);
  }
}

async function readPrivateCaseFile(value) {
  const requestedPath = resolve(value);
  if (isWithin(root, requestedPath)) {
    fail(
      "INPUT_INSIDE_WORKSPACE",
      "Private user data must be stored outside the jGDINA workspace.",
      65,
    );
  }
  let handle;
  try {
    const flags = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW;
    handle = await open(requestedPath, flags);
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(error?.code)) {
      fail("INPUT_PATH", "Private case JSON is missing or inaccessible.", 65);
    }
    if (["ELOOP", "ENXIO"].includes(error?.code)) {
      fail("INPUT_TYPE", "Private case JSON must be a regular non-symlink file.", 65);
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) {
      fail("INPUT_TYPE", "Private case JSON must be a singly linked regular non-symlink file.", 65);
    }
    if (before.size <= 0 || before.size > maxCaseBytes) {
      fail("INPUT_SIZE", `Private case JSON must be 1-${maxCaseBytes} bytes.`, 65);
    }
    const mode = before.mode & 0o777;
    if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
      fail("INPUT_OWNER", "Private case JSON must be owned by the current local user.", 65);
    }
    if (mode !== 0o400 && mode !== 0o600) {
      fail(
        "INPUT_PERMISSIONS",
        "Private case JSON must use owner-only non-executable mode 0400 or 0600.",
        65,
      );
    }
    let resolvedPath;
    let pathMetadata;
    try {
      resolvedPath = await realpath(requestedPath);
      pathMetadata = await stat(resolvedPath);
    } catch (error) {
      if (["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(error?.code)) {
        fail("INPUT_CHANGED", "Private case JSON changed during its safety check.", 65);
      }
      throw error;
    }
    if (isWithin(root, resolvedPath)) {
      fail(
        "INPUT_INSIDE_WORKSPACE",
        "Private user data must be stored outside the jGDINA workspace.",
        65,
      );
    }
    const inputParent = dirname(resolvedPath);
    const inputParentMetadata = await stat(inputParent);
    if (
      !inputParentMetadata.isDirectory() ||
      (typeof process.getuid === "function" && inputParentMetadata.uid !== process.getuid()) ||
      ((inputParentMetadata.mode & 0o777) & 0o022) !== 0
    ) {
      fail(
        "INPUT_PARENT_SECURITY",
        "The private input parent must be current-user-owned and not group/world writable.",
        65,
      );
    }
    await assertNoExtendedAcl(inputParent, "INPUT_PARENT_ACL");
    await assertNoExtendedAcl(resolvedPath, "INPUT_ACL");
    if (before.dev !== pathMetadata.dev || before.ino !== pathMetadata.ino) {
      fail("INPUT_CHANGED", "Private case JSON changed during its safety check.", 65);
    }
    const contents = await handle.readFile();
    const after = await handle.stat();
    if (
      contents.byteLength !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== 1
    ) {
      fail("INPUT_CHANGED", "Private case JSON changed while it was being read.", 65);
    }
    return contents;
  } finally {
    await handle.close();
  }
}

async function resolveProspectivePath(value) {
  const absolute = resolve(value);
  let ancestor = absolute;
  const suffix = [];
  while (true) {
    try {
      const resolvedAncestor = await realpath(ancestor);
      return resolve(resolvedAncestor, ...suffix.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

function rethrowOutputPathError(error) {
  if (error instanceof AcceptanceError) throw error;
  if (error?.code === "EEXIST") {
    fail("OUTPUT_EXISTS", "The private output path must not already exist.", 65);
  }
  if (["EACCES", "EPERM", "EROFS", "ENOTDIR", "ELOOP"].includes(error?.code)) {
    fail("OUTPUT_PATH", "The private output path is inaccessible or not writable.", 65);
  }
  if (["ENOSPC", "EDQUOT", "EIO"].includes(error?.code)) {
    fail("OUTPUT_IO", "The private output filesystem cannot create the evidence directory.", 74);
  }
  throw error;
}

async function privateOutputPath(value) {
  if (isWithin(root, resolve(value))) {
    fail(
      "OUTPUT_INSIDE_WORKSPACE",
      "User-data acceptance output must be stored outside the jGDINA workspace.",
      65,
    );
  }
  let prospective;
  try {
    prospective = await resolveProspectivePath(value);
  } catch (error) {
    rethrowOutputPathError(error);
  }
  if (isWithin(root, prospective)) {
    fail(
      "OUTPUT_INSIDE_WORKSPACE",
      "User-data acceptance output must be stored outside the jGDINA workspace.",
      65,
    );
  }
  try {
    await lstat(prospective);
    fail("OUTPUT_EXISTS", "The private output path must not already exist.", 65);
  } catch (error) {
    if (error?.code !== "ENOENT") rethrowOutputPathError(error);
  }
  const unresolvedParent = dirname(prospective);
  let resolvedParent;
  let parentBefore;
  try {
    await mkdir(unresolvedParent, { recursive: true, mode: 0o700 });
    resolvedParent = await realpath(unresolvedParent);
    parentBefore = await stat(resolvedParent);
  } catch (error) {
    rethrowOutputPathError(error);
  }
  if (
    !parentBefore.isDirectory() ||
    (typeof process.getuid === "function" && parentBefore.uid !== process.getuid()) ||
    ((parentBefore.mode & 0o777) & 0o022) !== 0
  ) {
    fail(
      "OUTPUT_PARENT_SECURITY",
      "The output parent must be current-user-owned and not group/world writable.",
      65,
    );
  }
  await assertNoExtendedAcl(resolvedParent, "OUTPUT_PARENT_ACL");
  const path = resolve(resolvedParent, basename(prospective));
  if (isWithin(root, path)) {
    fail(
      "OUTPUT_INSIDE_WORKSPACE",
      "User-data acceptance output must be stored outside the jGDINA workspace.",
      65,
    );
  }
  try {
    await mkdir(path, { recursive: false, mode: 0o700 });
    await chmod(path, 0o700);
    const [parentAfter, outputMetadata] = await Promise.all([stat(resolvedParent), stat(path)]);
    if (
      parentAfter.dev !== parentBefore.dev ||
      parentAfter.ino !== parentBefore.ino ||
      !outputMetadata.isDirectory() ||
      (typeof process.getuid === "function" && outputMetadata.uid !== process.getuid()) ||
      (outputMetadata.mode & 0o777) !== 0o700
    ) {
      fail("OUTPUT_PATH_CHANGED", "The private output path changed during creation.", 65);
    }
    await assertNoExtendedAcl(path, "OUTPUT_ACL");
  } catch (error) {
    rethrowOutputPathError(error);
  }
  return path;
}

function rejectUnknownKeys(record, allowed, path) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail("SCHEMA", `${path} contains unsupported field ${key}.`, 65);
  }
}

function validateLabelVector(value, expectedLength, path) {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    fail("SCHEMA", `${path} must have exactly ${expectedLength} entries.`, 65);
  }
  if (
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.length > 80 ||
        /[\r\n\t]/u.test(entry),
    )
  ) {
    fail("SCHEMA", `${path} entries must be 1-80 character single-line strings.`, 65);
  }
  if (new Set(value).size !== value.length) {
    fail("SCHEMA", `${path} entries must be unique.`, 65);
  }
}

function validateQMatrixBeforeInitialization(qMatrix) {
  if (qMatrix.length === 0 || !Array.isArray(qMatrix[0]) || qMatrix[0].length === 0) {
    fail("SCHEMA", "fitInput.qMatrix must be a non-empty rectangular matrix.", 65);
  }
  const attributeCount = qMatrix[0].length;
  if (attributeCount > DEFAULT_RESOURCE_LIMITS.maxAttributes) {
    fail(
      "RESOURCE_LIMIT",
      `The private acceptance workflow supports at most ${DEFAULT_RESOURCE_LIMITS.maxAttributes} attributes.`,
      65,
    );
  }
  const usedAttributes = Array(attributeCount).fill(false);
  for (let rowIndex = 0; rowIndex < qMatrix.length; rowIndex += 1) {
    const row = qMatrix[rowIndex];
    if (!Array.isArray(row) || row.length !== attributeCount) {
      fail("SCHEMA", "fitInput.qMatrix must be rectangular.", 65);
    }
    let required = 0;
    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      const value = row[columnIndex];
      if (value !== 0 && value !== 1) {
        fail("SCHEMA", "fitInput.qMatrix accepts only exact numeric 0 and 1 values.", 65);
      }
      if (value === 1) {
        required += 1;
        usedAttributes[columnIndex] = true;
      }
    }
    if (required === 0) {
      fail("SCHEMA", "Every fitInput.qMatrix row must require at least one attribute.", 65);
    }
  }
  if (usedAttributes.some((used) => !used)) {
    fail("SCHEMA", "Every fitInput.qMatrix column must be used by at least one item.", 65);
  }
}

function validateEnvelope(value) {
  if (!isRecord(value)) fail("SCHEMA", "Case JSON must contain an object.", 65);
  rejectUnknownKeys(
    value,
    ["$schema", "schemaVersion", "caseId", "privacy", "fitInput", "itemIds", "attributeIds", "acceptance"],
    "case",
  );
  if (
    value.$schema !== undefined &&
    (typeof value.$schema !== "string" || value.$schema.length === 0)
  ) {
    fail("SCHEMA", "case.$schema must be a non-empty string when supplied.", 65);
  }
  if (value.schemaVersion !== caseSchemaVersion) {
    fail("SCHEMA", `schemaVersion must be ${caseSchemaVersion}.`, 65);
  }
  if (typeof value.caseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value.caseId)) {
    fail("SCHEMA", "caseId must be 1-80 safe ASCII identifier characters.", 65);
  }
  if (!isRecord(value.privacy)) fail("PRIVACY", "privacy acknowledgement is required.", 65);
  rejectUnknownKeys(
    value.privacy,
    ["directIdentifiersRemoved", "respondentIdsExcluded", "freeTextExcluded"],
    "privacy",
  );
  for (const field of ["directIdentifiersRemoved", "respondentIdsExcluded", "freeTextExcluded"]) {
    if (value.privacy[field] !== true) {
      fail("PRIVACY", `privacy.${field} must be true before this workflow will run.`, 65);
    }
  }
  if (!isRecord(value.fitInput)) fail("SCHEMA", "fitInput must be an object.", 65);
  rejectUnknownKeys(
    value.fitInput,
    ["responses", "qMatrix", "model", "prior", "estimation"],
    "fitInput",
  );
  if ("respondentIds" in value || "respondentIds" in value.fitInput) {
    fail("PRIVACY", "Respondent identifiers are intentionally unsupported.", 65);
  }
  if (!Array.isArray(value.fitInput.responses) || !Array.isArray(value.fitInput.qMatrix)) {
    fail("SCHEMA", "fitInput.responses and fitInput.qMatrix must be JSON matrices.", 65);
  }
  if (
    value.fitInput.responses.length > DEFAULT_RESOURCE_LIMITS.maxRespondents ||
    value.fitInput.qMatrix.length > DEFAULT_RESOURCE_LIMITS.maxItems ||
    (Array.isArray(value.fitInput.responses[0]) &&
      value.fitInput.responses[0].length > DEFAULT_RESOURCE_LIMITS.maxItems)
  ) {
    fail("RESOURCE_LIMIT", "Private case matrix dimensions exceed the safe workflow defaults.", 65);
  }
  validateQMatrixBeforeInitialization(value.fitInput.qMatrix);
  if (value.fitInput.model !== undefined) {
    const models = typeof value.fitInput.model === "string"
      ? [value.fitInput.model]
      : value.fitInput.model;
    if (
      !Array.isArray(models) ||
      models.length === 0 ||
      models.some((model) => !["GDINA", "DINA", "DINO"].includes(model))
    ) {
      fail("SCHEMA", "fitInput.model accepts only uppercase GDINA, DINA, or DINO.", 65);
    }
  }
  if (value.fitInput.prior !== undefined) {
    if (!isRecord(value.fitInput.prior)) {
      fail("SCHEMA", "fitInput.prior must be an object.", 65);
    }
    const priorKeys = value.fitInput.prior.type === "fixed"
      ? ["type", "probabilities"]
      : ["type", "initialProbabilities"];
    rejectUnknownKeys(value.fitInput.prior, priorKeys, "fitInput.prior");
  }
  if (value.fitInput.estimation !== undefined) {
    if (!isRecord(value.fitInput.estimation)) {
      fail("SCHEMA", "fitInput.estimation must be an object.", 65);
    }
    rejectUnknownKeys(
      value.fitInput.estimation,
      [
        "maxIterations",
        "convergenceTolerance",
        "probabilityBounds",
        "smallSampleCorrection",
        "initialization",
        "aggregateRows",
        "posteriorStorage",
        "blockSize",
        "resourceLimits",
      ],
      "fitInput.estimation",
    );
    const initialization = value.fitInput.estimation.initialization;
    if (initialization !== undefined) {
      if (!isRecord(initialization)) {
        fail("SCHEMA", "fitInput.estimation.initialization must be an object.", 65);
      }
      rejectUnknownKeys(
        initialization,
        [
          "strategy",
          "starts",
          "seed",
          "initialItemProbabilities",
          "initialItemProbabilityCandidates",
        ],
        "fitInput.estimation.initialization",
      );
      if (
        initialization.strategy !== undefined &&
        initialization.strategy !== "deterministic"
      ) {
        fail("SCHEMA", 'fitInput.estimation.initialization.strategy must be "deterministic".', 65);
      }
      if (
        initialization.initialItemProbabilities !== undefined &&
        initialization.initialItemProbabilityCandidates !== undefined
      ) {
        fail(
          "SCHEMA",
          "Supply initialItemProbabilities or initialItemProbabilityCandidates, not both.",
          65,
        );
      }
    }
    const limits = value.fitInput.estimation.resourceLimits;
    if (limits !== undefined) {
      if (!isRecord(limits)) {
        fail("SCHEMA", "fitInput.estimation.resourceLimits must be an object.", 65);
      }
      rejectUnknownKeys(limits, Object.keys(DEFAULT_RESOURCE_LIMITS), "fitInput.estimation.resourceLimits");
      for (const [name, limit] of Object.entries(limits)) {
        if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) {
          fail("SCHEMA", `fitInput.estimation.resourceLimits.${name} must be a positive safe integer.`, 65);
        }
        if (limit > DEFAULT_RESOURCE_LIMITS[name]) {
          fail(
            "RESOURCE_LIMIT",
            `fitInput.estimation.resourceLimits.${name} may make the private workflow stricter but not exceed its safe default.`,
            65,
          );
        }
      }
    }
  }
  if (value.itemIds !== undefined) {
    validateLabelVector(value.itemIds, value.fitInput.qMatrix.length, "itemIds");
  }
  const attributes = value.fitInput.qMatrix[0]?.length;
  if (value.attributeIds !== undefined) {
    validateLabelVector(value.attributeIds, attributes, "attributeIds");
  }
  if (value.acceptance !== undefined) {
    if (!isRecord(value.acceptance)) {
      fail("SCHEMA", "acceptance must be an object when supplied.", 65);
    }
    rejectUnknownKeys(value.acceptance, ["tolerances"], "acceptance");
    if (value.acceptance.tolerances !== undefined) {
      if (!isRecord(value.acceptance.tolerances)) {
        fail("SCHEMA", "acceptance.tolerances must be an object.", 65);
      }
      rejectUnknownKeys(value.acceptance.tolerances, toleranceNames, "acceptance.tolerances");
    }
  }
  return value;
}

function expandedModels(model, items) {
  if (model === undefined) return Array(items).fill("GDINA");
  if (typeof model === "string") return Array(items).fill(model.toUpperCase());
  if (!Array.isArray(model) || model.length !== items) {
    fail("SCHEMA", "fitInput.model must be a scalar or one entry per item.", 65);
  }
  return model.map((value) => typeof value === "string" ? value.toUpperCase() : value);
}

function canonicalInitialItems(qMatrix, models) {
  return qMatrix.map((row, item) => {
    const groupCount = 2 ** row.reduce((sum, value) => sum + Number(value), 0);
    if (models[item] === "DINA") return [...Array(groupCount - 1).fill(0.2), 0.8];
    if (models[item] === "DINO") return [0.2, ...Array(groupCount - 1).fill(0.8)];
    if (groupCount === 1) return [0.5];
    return Array.from({ length: groupCount }, (_, index) => 0.2 + 0.6 * index / (groupCount - 1));
  });
}

function expandInitialItemsForOracle(validated) {
  return validated.estimation.initialization.initialItemProbabilities.map((values, item) => {
    const fullLength = 2 ** validated.qMatrix[item].reduce((sum, value) => sum + value, 0);
    if (values.length === fullLength || validated.models[item] === "GDINA") return values;
    if (validated.models[item] === "DINA") {
      return [...Array(fullLength - 1).fill(values[0]), values[1]];
    }
    return [values[0], ...Array(fullLength - 1).fill(values[1])];
  });
}

function validateFitInputOrFail(input) {
  try {
    return validateFitInput(input);
  } catch (error) {
    const issues = Array.isArray(error?.issues) ? error.issues : [];
    const locations = issues
      .slice(0, 5)
      .map((issue) => `${issue.path}:${issue.code}`)
      .join(", ");
    const suffix = locations.length > 0 ? ` Affected fields: ${locations}.` : "";
    fail(
      "FIT_INPUT_INVALID",
      `jGDINA rejected the private fit input (${Math.max(1, issues.length)} validation issue(s)).${suffix}`,
      65,
    );
  }
}

function normalizeCase(envelope, oracleMode) {
  const original = envelope.fitInput;
  const itemCount = original.qMatrix.length;
  const attributeCount = original.qMatrix[0]?.length ?? 0;
  const classCount = 2 ** attributeCount;
  const models = expandedModels(original.model, itemCount);
  const originalEstimation = original.estimation ?? {};
  const originalInitialization = originalEstimation.initialization ?? {};
  const candidates = originalInitialization.initialItemProbabilityCandidates;
  if (candidates !== undefined && (!Array.isArray(candidates) || candidates.length !== 1)) {
    fail("INITIALIZATION", "Strict parity accepts exactly one explicit initial candidate.", 65);
  }
  const starts = originalInitialization.starts === undefined
    ? (candidates === undefined ? 1 : candidates.length)
    : originalInitialization.starts;
  if (oracleMode !== "none" && starts !== 1) {
    fail("INITIALIZATION", "R parity requires initialization.starts = 1.", 65);
  }
  const suppliedItems = candidates === undefined
    ? originalInitialization.initialItemProbabilities
    : candidates[0];
  const prior = original.prior ?? { type: "saturated" };
  if (!isRecord(prior) || !["saturated", "fixed"].includes(prior.type)) {
    fail("SCHEMA", "fitInput.prior must be saturated or fixed.", 65);
  }
  if (oracleMode === "kernel" && prior.type !== "saturated") {
    fail(
      "ORACLE_SCOPE",
      "The frozen fast-kernel oracle supports saturated priors only; use --oracle base-r for a fixed prior.",
      65,
    );
  }
  const normalizedPrior = prior.type === "fixed"
    ? prior
    : {
        type: "saturated",
        initialProbabilities: prior.initialProbabilities === undefined
          ? Array(classCount).fill(1 / classCount)
          : prior.initialProbabilities,
      };
  const aggregateRows = originalEstimation.aggregateRows === undefined
    ? false
    : originalEstimation.aggregateRows;
  if (oracleMode !== "none" && aggregateRows !== false) {
    fail("ORACLE_SCOPE", "Strict R parity requires estimation.aggregateRows = false.", 65);
  }
  if (
    originalEstimation.posteriorStorage !== undefined &&
    originalEstimation.posteriorStorage !== "scores-only"
  ) {
    fail(
      "PRIVACY",
      'The private acceptance workflow requires estimation.posteriorStorage = "scores-only".',
      65,
    );
  }
  const preliminary = {
    responses: original.responses,
    qMatrix: original.qMatrix,
    model: models,
    prior: normalizedPrior,
    estimation: {
      ...originalEstimation,
      aggregateRows,
      maxIterations: originalEstimation.maxIterations === undefined
        ? 5_000
        : originalEstimation.maxIterations,
      convergenceTolerance: originalEstimation.convergenceTolerance === undefined
        ? 1e-8
        : originalEstimation.convergenceTolerance,
      posteriorStorage: "scores-only",
      probabilityBounds: originalEstimation.probabilityBounds === undefined
        ? [0.0001, 0.9999]
        : originalEstimation.probabilityBounds,
      smallSampleCorrection: originalEstimation.smallSampleCorrection === undefined
        ? [0.0005, 0.001]
        : originalEstimation.smallSampleCorrection,
      initialization: {
        strategy: "deterministic",
        starts,
        seed: originalInitialization.seed === undefined ? 123_456 : originalInitialization.seed,
        ...(suppliedItems === undefined ? {} : { initialItemProbabilities: suppliedItems }),
      },
    },
  };
  const preliminaryValidated = validateFitInputOrFail(preliminary);
  if (suppliedItems === undefined) {
    try {
      assertWithinResourceLimits(
        {
          respondents: preliminaryValidated.dimensions.respondents,
          items: preliminaryValidated.dimensions.items,
          attributes: preliminaryValidated.dimensions.attributes,
          reducedClassCounts: preliminaryValidated.qMatrix.map(
            (row) => 2 ** row.reduce((sum, value) => sum + value, 0),
          ),
          starts,
          suppliedCandidateCount: 1,
          posteriorStorage: "scores-only",
          blockSize: preliminaryValidated.estimation.blockSize,
        },
        preliminaryValidated.estimation.resourceLimits,
      );
    } catch {
      fail("RESOURCE_LIMIT", "Canonical initialization would exceed a safe resource limit.", 65);
    }
  }
  const initialItems = suppliedItems === undefined
    ? canonicalInitialItems(preliminaryValidated.qMatrix, preliminaryValidated.models)
    : preliminaryValidated.estimation.initialization.initialItemProbabilities;
  const normalized = {
    ...preliminary,
    estimation: {
      ...preliminary.estimation,
      initialization: {
        ...preliminary.estimation.initialization,
        initialItemProbabilities: initialItems,
      },
    },
  };
  const tolerances = { ...defaultTolerances, ...(envelope.acceptance?.tolerances ?? {}) };
  for (const [name, value] of Object.entries(tolerances)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      fail("SCHEMA", `acceptance.tolerances.${name} must be a non-negative finite number.`, 65);
    }
    if (name === "classificationAgreement" && value !== 1) {
      fail("SCHEMA", "acceptance.tolerances.classificationAgreement must remain exactly 1.", 65);
    }
    if (name !== "classificationAgreement" && value > defaultTolerances[name]) {
      fail(
        "SCHEMA",
        `acceptance.tolerances.${name} may make the gate stricter but not looser than ${defaultTolerances[name]}.`,
        65,
      );
    }
  }
  return {
    input: normalized,
    initializationSource: suppliedItems === undefined ? "canonical-linear-0.2-to-0.8-v1" : "case-supplied",
    tolerances,
  };
}

function counts(values) {
  return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((entry) => entry === value).length]));
}

function estimateROracleMemory(validated, oracleMode) {
  if (oracleMode === "none") return null;
  const respondents = BigInt(validated.dimensions.respondents);
  const items = BigInt(validated.dimensions.items);
  const attributes = BigInt(validated.dimensions.attributes);
  const classes = BigInt(validated.dimensions.latentClasses);
  const reducedGroups = validated.qMatrix.reduce(
    (total, row) => total + 2 ** row.reduce((sum, value) => sum + value, 0),
    0,
  );
  const denseRespondentClassBytes = respondents * classes * 8n;
  const denseItemClassBytes = items * classes * 8n;
  const respondentClassMatrixMultiplier = 16n;
  const itemClassMatrixMultiplier = 8n;
  const fixedRuntimeReserveBytes = 96n * 1024n ** 2n;
  const parsedResponseReserveBytes = respondents * items * 64n;
  const parsedQReserveBytes = items * attributes * 32n;
  const scoringReserveBytes = respondents * attributes * 64n;
  const modelReserveBytes = (classes + BigInt(reducedGroups)) * 64n;
  const estimated =
    fixedRuntimeReserveBytes +
    denseRespondentClassBytes * respondentClassMatrixMultiplier +
    denseItemClassBytes * itemClassMatrixMultiplier +
    parsedResponseReserveBytes +
    parsedQReserveBytes +
    scoringReserveBytes +
    modelReserveBytes;
  if (estimated > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("ORACLE_RESOURCE_LIMIT", "The projected R oracle working set is not safely representable.", 65);
  }
  const estimatedBytes = Number(estimated);
  const limitBytes = Math.min(
    DEFAULT_RESOURCE_LIMITS.maxEstimatedBytes,
    validated.estimation.resourceLimits.maxEstimatedBytes,
  );
  if (estimatedBytes > limitBytes) {
    fail(
      "ORACLE_RESOURCE_LIMIT",
      `The projected R oracle working set exceeds its ${limitBytes}-byte private-workflow limit.`,
      65,
    );
  }
  return {
    estimatedBytes,
    limitBytes,
    denseRespondentClassBytes: Number(denseRespondentClassBytes),
    respondentClassMatrixMultiplier: Number(respondentClassMatrixMultiplier),
    denseItemClassBytes: Number(denseItemClassBytes),
    itemClassMatrixMultiplier: Number(itemClassMatrixMultiplier),
    fixedRuntimeReserveBytes: Number(fixedRuntimeReserveBytes),
    method: "conservative-full-R-scoring-v1",
  };
}

function aggregatePreflight(
  caseId,
  validated,
  initializationSource,
  initializationHash,
  oracleMemoryEstimate,
  runtimeFingerprint,
) {
  return {
    schemaVersion: "jgdina-user-preflight/1",
    status: "PREFLIGHT",
    caseId,
    privacy: {
      containsRawResponses: false,
      containsQMatrix: false,
      containsRespondentIdentifiers: false,
      containsPersonScores: false,
    },
    dimensions: validated.dimensions,
    missingResponseCount: validated.missingResponseCount,
    modelCounts: counts(validated.models),
    priorType: validated.prior.type,
    estimation: {
      aggregateRows: validated.estimation.aggregateRows,
      maxIterations: validated.estimation.maxIterations,
      convergenceTolerance: validated.estimation.convergenceTolerance,
      posteriorStorage: validated.estimation.posteriorStorage,
      starts: validated.estimation.initialization.starts,
      initializationSource,
      initializationSha256: initializationHash,
    },
    memoryEstimate: validated.memoryEstimate,
    rOracleMemoryEstimate: oracleMemoryEstimate,
    runtimeFingerprint,
  };
}

async function runROracle(mode, oracleScriptPath, requestPath, referencePath) {
  const controlledMakevars = join(dirname(requestPath), "Makevars.controlled");
  await writeFile(controlledMakevars, "# Controlled empty user Makevars for the private oracle.\n", {
    mode: 0o600,
    flag: "wx",
  });
  return await new Promise((resolvePromise, rejectPromise) => {
    const environment = {};
    for (const key of [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "R_HOME",
      "R_ARCH",
      "R_LIBS",
      "R_LIBS_USER",
      "R_LIBS_SITE",
      "LD_LIBRARY_PATH",
      "DYLD_LIBRARY_PATH",
      "DYLD_FALLBACK_LIBRARY_PATH",
    ]) {
      if (typeof process.env[key] === "string") environment[key] = process.env[key];
    }
    Object.assign(environment, {
      JGDINA_FIXTURE_LIBRARY: "1",
      JGDINA_WORKSPACE_ROOT: root,
      R_MAKEVARS_USER: controlledMakevars,
      TMPDIR: dirname(requestPath),
      TMP: dirname(requestPath),
      TEMP: dirname(requestPath),
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      http_proxy: "",
      https_proxy: "",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      NO_PROXY: "*",
    });
    const child = spawn("Rscript", ["--vanilla", oracleScriptPath, mode, requestPath, referencePath], {
      cwd: root,
      detached: process.platform !== "win32",
      env: environment,
      stdio: "ignore",
    });
    activeOracleChild = child;
    activeOracleClosed = new Promise((resolveClosed) => child.once("close", resolveClosed));
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killOracleProcess(child);
    }, 30 * 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (activeOracleChild === child) activeOracleChild = null;
      activeOracleClosed = null;
      rejectPromise(new AcceptanceError("R_UNAVAILABLE", `Could not start Rscript: ${error.message}`, 69));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (activeOracleChild === child) activeOracleChild = null;
      activeOracleClosed = null;
      if (timedOut) {
        rejectPromise(new AcceptanceError("R_TIMEOUT", "R oracle exceeded 30 minutes.", 69));
        return;
      }
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new AcceptanceError("R_ORACLE_FAILED", `R oracle failed (exit ${code}).`, 69));
      }
    });
  });
}

function flatten(values) {
  return values.flatMap((value) => Array.isArray(value) ? flatten(value) : [value]);
}

function compareNumeric(actual, expected, absoluteTolerance, relativeTolerance) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) {
    return { passed: false, count: expected.length, maxAbsoluteDifference: null, violationCount: 1 };
  }
  let maximum = 0;
  let violations = 0;
  for (let index = 0; index < actual.length; index += 1) {
    if (
      typeof actual[index] !== "number" ||
      !Number.isFinite(actual[index]) ||
      typeof expected[index] !== "number" ||
      !Number.isFinite(expected[index])
    ) {
      violations += 1;
      continue;
    }
    const difference = Math.abs(actual[index] - expected[index]);
    maximum = Math.max(maximum, difference);
    const allowed = absoluteTolerance + relativeTolerance * Math.max(Math.abs(actual[index]), Math.abs(expected[index]));
    if (!Number.isFinite(difference) || difference > allowed) violations += 1;
  }
  return { passed: violations === 0, count: expected.length, maxAbsoluteDifference: maximum, violationCount: violations };
}

function exactAgreement(actual, expected) {
  if (actual.length !== expected.length || expected.length === 0) return 0;
  let matches = 0;
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] === expected[index]) matches += 1;
  }
  return matches / expected.length;
}

function tieCompatibleAgreement(actual, expectedTieSets) {
  if (actual.length !== expectedTieSets.length || actual.length === 0) return 0;
  let matches = 0;
  for (let index = 0; index < actual.length; index += 1) {
    const set = Array.isArray(expectedTieSets[index]) ? expectedTieSets[index] : [expectedTieSets[index]];
    if (set.includes(actual[index])) matches += 1;
  }
  return matches / actual.length;
}

function oracleSchema(condition, path) {
  if (!condition) fail("ORACLE_SCHEMA", `R oracle returned an invalid ${path} field.`, 70);
}

function validateOracleNumber(value, path, options = {}) {
  oracleSchema(typeof value === "number" && Number.isFinite(value), path);
  if (options.integer) oracleSchema(Number.isSafeInteger(value), path);
  if (options.minimum !== undefined) oracleSchema(value >= options.minimum, path);
  if (options.maximum !== undefined) oracleSchema(value <= options.maximum, path);
}

function validateOracleVector(value, length, path, options = {}) {
  oracleSchema(Array.isArray(value) && value.length === length, path);
  value.forEach((entry, index) => validateOracleNumber(entry, `${path}[${index}]`, options));
}

function validateOracleMatrix(value, rows, columns, path, options = {}) {
  oracleSchema(Array.isArray(value) && value.length === rows, path);
  value.forEach((row, index) => validateOracleVector(row, columns, `${path}[${index}]`, options));
}

function validateOracleReference(reference, validated, requestedMode, result) {
  oracleSchema(isRecord(reference), "root");
  oracleSchema(reference.schema_version === oracleSchemaVersion, "schema_version");
  oracleSchema(isRecord(reference.oracle), "oracle");
  oracleSchema(reference.oracle.mode === requestedMode, "oracle.mode");
  const expectedImplementation = requestedMode === "kernel"
    ? "frozen-GDINA-2.12.3-fast_GDINA_EM-plus-independent-base-R-scoring"
    : "independent-base-R-closed-form-equations";
  oracleSchema(reference.oracle.implementation === expectedImplementation, "oracle.implementation");
  oracleSchema(reference.oracle.upstream_version === "2.12.3", "oracle.upstream_version");
  oracleSchema(
    reference.oracle.upstream_commit === frozenUpstreamCommit,
    "oracle.upstream_commit",
  );
  oracleSchema(
    reference.oracle.upstream_tree_sha256 === frozenUpstreamTreeSha256,
    "oracle.upstream_tree_sha256",
  );
  oracleSchema(reference.oracle.oracle_sha256 === oracleSha256, "oracle.oracle_sha256");
  oracleSchema(reference.oracle.equations_sha256 === equationsSha256, "oracle.equations_sha256");
  oracleSchema(
    requestedMode === "kernel"
      ? reference.oracle.kernel_sha256 === frozenKernelSha256
      : reference.oracle.kernel_sha256 === null,
    "oracle.kernel_sha256",
  );
  validateOracleNumber(reference.oracle.warning_count, "oracle.warning_count", {
    integer: true,
    minimum: 0,
  });
  validateOracleNumber(reference.oracle.elapsed_seconds, "oracle.elapsed_seconds", { minimum: 0 });
  for (const name of ["r_version", "platform"]) {
    const value = reference.oracle[name];
    oracleSchema(
      typeof value === "string" &&
        value.length > 0 &&
        value.length <= 256 &&
        !/[\r\n\0]/u.test(value),
      `oracle.${name}`,
    );
  }
  oracleSchema(isRecord(reference.oracle.toolchain), "oracle.toolchain");
  oracleSchema(
    JSON.stringify(Object.keys(reference.oracle.toolchain).sort()) ===
      JSON.stringify(["compiler", "packages"]),
    "oracle.toolchain",
  );
  oracleSchema(isRecord(reference.oracle.toolchain.packages), "oracle.toolchain.packages");
  const packageMetadata = reference.oracle.toolchain.packages;
  oracleSchema(
    JSON.stringify(Object.keys(packageMetadata).sort()) ===
      JSON.stringify(["Rcpp", "RcppArmadillo", "jsonlite"]),
    "oracle.toolchain.packages",
  );
  for (const name of ["jsonlite", "Rcpp", "RcppArmadillo"]) {
    const value = packageMetadata[name];
    oracleSchema(
      value === null ||
        (isRecord(value) &&
          JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["path", "version"]) &&
          typeof value.version === "string" &&
          /^[0-9]+(?:\.[0-9A-Za-z-]+)*$/u.test(value.version) &&
          typeof value.path === "string" &&
          isAbsolute(value.path) &&
          value.path.length <= 4_096 &&
          !/[\r\n\0]/u.test(value.path)),
      `oracle.toolchain.packages.${name}`,
    );
  }
  oracleSchema(isRecord(packageMetadata.jsonlite), "oracle.toolchain.packages.jsonlite");
  if (requestedMode === "kernel") {
    oracleSchema(isRecord(packageMetadata.Rcpp), "oracle.toolchain.packages.Rcpp");
    oracleSchema(
      isRecord(packageMetadata.RcppArmadillo),
      "oracle.toolchain.packages.RcppArmadillo",
    );
    oracleSchema(isRecord(reference.oracle.toolchain.compiler), "oracle.toolchain.compiler");
    oracleSchema(
      JSON.stringify(Object.keys(reference.oracle.toolchain.compiler).sort()) ===
        JSON.stringify(compilerConfigurationKeys),
      "oracle.toolchain.compiler",
    );
    for (const name of compilerConfigurationKeys) {
      const value = reference.oracle.toolchain.compiler[name];
      oracleSchema(
        typeof value === "string" && value.length <= 4_096 && !/[\r\n\0]/u.test(value),
        `oracle.toolchain.compiler.${name}`,
      );
    }
  } else {
    oracleSchema(reference.oracle.toolchain.compiler === null, "oracle.toolchain.compiler");
  }

  oracleSchema(isRecord(reference.configuration), "configuration");
  oracleSchema(
    JSON.stringify(reference.configuration.models) === JSON.stringify(validated.models),
    "configuration.models",
  );
  oracleSchema(reference.configuration.prior_mode === validated.prior.type, "configuration.prior_mode");
  oracleSchema(
    reference.configuration.max_iterations === validated.estimation.maxIterations,
    "configuration.max_iterations",
  );
  oracleSchema(
    reference.configuration.convergence_tolerance === validated.estimation.convergenceTolerance,
    "configuration.convergence_tolerance",
  );
  oracleSchema(
    JSON.stringify(reference.configuration.probability_bounds) ===
      JSON.stringify(validated.estimation.probabilityBounds),
    "configuration.probability_bounds",
  );
  oracleSchema(
    JSON.stringify(reference.configuration.small_sample_correction) ===
      JSON.stringify(validated.estimation.smallSampleCorrection),
    "configuration.small_sample_correction",
  );

  oracleSchema(isRecord(reference.dimensions), "dimensions");
  const dimensionPairs = [
    ["respondents", validated.dimensions.respondents],
    ["items", validated.dimensions.items],
    ["attributes", validated.dimensions.attributes],
    ["latent_classes", validated.dimensions.latentClasses],
    ["missing_responses", validated.missingResponseCount],
  ];
  for (const [name, expected] of dimensionPairs) {
    validateOracleNumber(reference.dimensions[name], `dimensions.${name}`, {
      integer: true,
      minimum: 0,
    });
    oracleSchema(reference.dimensions[name] === expected, `dimensions.${name}`);
  }

  oracleSchema(isRecord(reference.expected), "expected");
  const expected = reference.expected;
  validateOracleMatrix(
    expected.attribute_patterns,
    validated.dimensions.latentClasses,
    validated.dimensions.attributes,
    "expected.attribute_patterns",
    { integer: true, minimum: 0, maximum: 1 },
  );
  oracleSchema(typeof expected.converged === "boolean", "expected.converged");
  validateOracleNumber(expected.iterations, "expected.iterations", {
    integer: true,
    minimum: 0,
    maximum: validated.estimation.maxIterations,
  });
  if (expected.convergence_probe_iterations !== null) {
    validateOracleNumber(
      expected.convergence_probe_iterations,
      "expected.convergence_probe_iterations",
      {
        integer: true,
        minimum: 0,
        maximum: validated.estimation.maxIterations + 1,
      },
    );
  }
  if (expected.final_change !== null) {
    validateOracleNumber(expected.final_change, "expected.final_change", { minimum: 0 });
  }
  validateOracleNumber(expected.initial_log_likelihood, "expected.initial_log_likelihood");
  validateOracleNumber(expected.log_likelihood, "expected.log_likelihood");
  oracleSchema(
    Array.isArray(expected.item_group_probabilities) &&
      expected.item_group_probabilities.length === validated.dimensions.items,
    "expected.item_group_probabilities",
  );
  expected.item_group_probabilities.forEach((values, item) => {
    validateOracleVector(
      values,
      result.estimates.items[item].groupSuccessProbabilities.length,
      `expected.item_group_probabilities[${item}]`,
      { minimum: 0, maximum: 1 },
    );
  });
  validateOracleVector(
    expected.class_prior,
    validated.dimensions.latentClasses,
    "expected.class_prior",
    { minimum: 0, maximum: 1 },
  );
  for (const name of ["map_class_indices", "mle_class_indices"]) {
    validateOracleVector(expected[name], validated.dimensions.respondents, `expected.${name}`, {
      integer: true,
      minimum: 0,
      maximum: validated.dimensions.latentClasses - 1,
    });
  }
  for (const name of ["map_tie_sets", "mle_tie_sets"]) {
    const sets = expected[name];
    oracleSchema(Array.isArray(sets) && sets.length === validated.dimensions.respondents, `expected.${name}`);
    sets.forEach((set, row) => {
      oracleSchema(Array.isArray(set) && set.length > 0, `expected.${name}[${row}]`);
      set.forEach((index, tie) => validateOracleNumber(index, `expected.${name}[${row}][${tie}]`, {
        integer: true,
        minimum: 0,
        maximum: validated.dimensions.latentClasses - 1,
      }));
      oracleSchema(new Set(set).size === set.length, `expected.${name}[${row}]`);
    });
  }
  validateOracleMatrix(
    expected.eap_attribute_probabilities,
    validated.dimensions.respondents,
    validated.dimensions.attributes,
    "expected.eap_attribute_probabilities",
    { minimum: 0, maximum: 1 },
  );
  validateOracleMatrix(
    expected.eap_attribute_classifications,
    validated.dimensions.respondents,
    validated.dimensions.attributes,
    "expected.eap_attribute_classifications",
    { integer: true, minimum: 0, maximum: 1 },
  );
}

async function compareWithOracle(result, validated, reference, tolerances, requestedMode) {
  const expected = reference.expected;
  const packageFingerprints = await fingerprintROraclePackages(
    reference.oracle.toolchain.packages,
  );
  const compiler = reference.oracle.toolchain.compiler;
  const sanitizedCompiler = compiler === null
    ? null
    : Object.fromEntries(compilerConfigurationKeys.map((name) => {
        const value = compiler[name];
        let sanitized = value;
        for (const [sensitive, replacement] of [
          [root, "<workspace>"],
          [process.env.HOME, "<home>"],
        ]) {
          if (typeof sensitive === "string" && sensitive.length > 0) {
            sanitized = sanitized.replaceAll(sensitive, replacement);
          }
        }
        return [name, sanitized];
      }));
  const itemComparison = compareNumeric(
    flatten(result.estimates.items.map((item) => item.groupSuccessProbabilities)),
    flatten(expected.item_group_probabilities),
    tolerances.probabilityAbsolute,
    tolerances.probabilityRelative,
  );
  const priorComparison = compareNumeric(
    result.estimates.classProbabilities,
    expected.class_prior,
    tolerances.probabilityAbsolute,
    tolerances.probabilityRelative,
  );
  const eapComparison = compareNumeric(
    flatten(result.scores.eapAttributeProbabilities),
    flatten(expected.eap_attribute_probabilities),
    tolerances.probabilityAbsolute,
    tolerances.probabilityRelative,
  );
  const likelihoodComparison = compareNumeric(
    [result.statistics.logLikelihood],
    [expected.log_likelihood],
    tolerances.logLikelihoodAbsolute,
    tolerances.logLikelihoodRelative,
  );
  const initialLikelihoodComparison = compareNumeric(
    [result.convergence.starts[0].initialLogLikelihood],
    [expected.initial_log_likelihood],
    tolerances.logLikelihoodAbsolute,
    tolerances.logLikelihoodRelative,
  );
  const finalChangeComparison = expected.final_change === null
    ? null
    : compareNumeric(
        [result.convergence.finalChange],
        [expected.final_change],
        tolerances.probabilityAbsolute,
        tolerances.probabilityRelative,
      );
  const mapStrict = exactAgreement(result.scores.mapClassIndices, expected.map_class_indices);
  const mleStrict = exactAgreement(result.scores.mleClassIndices, expected.mle_class_indices);
  const mapTieCompatible = tieCompatibleAgreement(result.scores.mapClassIndices, expected.map_tie_sets);
  const mleTieCompatible = tieCompatibleAgreement(result.scores.mleClassIndices, expected.mle_tie_sets);
  const eapClassAgreement = exactAgreement(
    flatten(result.scores.eapAttributeClassifications),
    flatten(expected.eap_attribute_classifications),
  );
  const gates = {
    bothConverged: result.convergence.converged && expected.converged,
    jgdinaToleranceStop: result.convergence.reason === "tolerance",
    iterationsExact: result.convergence.iterations === expected.iterations,
    initializationExact:
      result.convergence.selectedStartIndex === 0 &&
      result.convergence.starts.length === 1 &&
      result.convergence.starts[0].selectedForEstimation,
    attributePatternOrderExact: JSON.stringify(result.attributePatterns) === JSON.stringify(expected.attribute_patterns),
    dimensionsExact:
      reference.dimensions.respondents === validated.dimensions.respondents &&
      reference.dimensions.items === validated.dimensions.items &&
      reference.dimensions.attributes === validated.dimensions.attributes &&
      reference.dimensions.latent_classes === validated.dimensions.latentClasses,
    missingCountExact: reference.dimensions.missing_responses === validated.missingResponseCount,
    itemProbabilities: itemComparison.passed,
    classPrior: priorComparison.passed,
    eapProbabilities: eapComparison.passed,
    initialLogLikelihood: initialLikelihoodComparison.passed,
    finalLogLikelihood: likelihoodComparison.passed,
    finalChange: finalChangeComparison === null ? null : finalChangeComparison.passed,
    mapStrict: mapStrict >= tolerances.classificationAgreement,
    mleStrict: mleStrict >= tolerances.classificationAgreement,
    eapClassifications: eapClassAgreement >= tolerances.classificationAgreement,
  };
  return {
    passed: Object.values(gates).every((value) => value === true || value === null),
    gates,
    differences: {
      itemProbabilities: itemComparison,
      classPrior: priorComparison,
      eapProbabilities: eapComparison,
      initialLogLikelihood: initialLikelihoodComparison,
      finalLogLikelihood: likelihoodComparison,
      finalChange: finalChangeComparison,
    },
    agreements: {
      mapStrict,
      mleStrict,
      mapTieCompatible,
      mleTieCompatible,
      eapClassifications: eapClassAgreement,
    },
    r: {
      mode: reference.oracle.mode,
      implementation: reference.oracle.implementation,
      upstreamVersion: reference.oracle.upstream_version,
      upstreamCommit: reference.oracle.upstream_commit,
      upstreamTreeSha256: reference.oracle.upstream_tree_sha256,
      oracleSha256: reference.oracle.oracle_sha256,
      equationsSha256: reference.oracle.equations_sha256,
      kernelSha256: reference.oracle.kernel_sha256,
      converged: expected.converged,
      iterations: expected.iterations,
      convergenceProbeIterations: expected.convergence_probe_iterations,
      logLikelihood: expected.log_likelihood,
      warningCount: reference.oracle.warning_count,
      mapNearTieCount: expected.map_tie_sets.filter((set) => set.length > 1).length,
      mleNearTieCount: expected.mle_tie_sets.filter((set) => set.length > 1).length,
      rVersion: reference.oracle.r_version,
      platform: reference.oracle.platform,
      toolchain: {
        packages: packageFingerprints,
        compiler: sanitizedCompiler,
        compilerConfigurationSha256: compiler === null ? null : stableSha256(compiler),
      },
      elapsedSeconds: reference.oracle.elapsed_seconds,
    },
  };
}

function privacyAudit(summary) {
  const forbidden = new Set([
    "responses",
    "qMatrix",
    "q_matrix",
    "posteriorProbabilities",
    "posterior_probabilities",
    "mapClassIndices",
    "map_class_indices",
    "mleClassIndices",
    "mle_class_indices",
    "eapAttributeProbabilities",
    "eap_attribute_probabilities",
    "eapAttributeClassifications",
    "eap_attribute_classifications",
    "personScores",
    "person_scores",
    "itemIds",
    "attributeIds",
    "respondentIds",
    "respondent_ids",
  ]);
  const allowedArrays = new Set([
    "summary.configuration.probabilityBounds",
    "summary.configuration.smallSampleCorrection",
    "summary.review.warnings",
    "summary.limitations",
  ]);
  const visit = (value, path) => {
    if (Array.isArray(value)) {
      if (!allowedArrays.has(path)) {
        fail("PRIVACY_AUDIT", `Aggregate summary contains an unsupported array at ${path}.`, 70);
      }
      if (path === "summary.configuration.probabilityBounds" || path === "summary.configuration.smallSampleCorrection") {
        if (value.length !== 2 || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
          fail("PRIVACY_AUDIT", `Aggregate summary contains an invalid control vector at ${path}.`, 70);
        }
      }
      if (path === "summary.limitations") {
        if (value.length > 10 || value.some((entry) => typeof entry !== "string" || entry.length > 500)) {
          fail("PRIVACY_AUDIT", "Aggregate summary contains invalid limitation text.", 70);
        }
      }
      if (path === "summary.review.warnings") {
        if (value.length > 20 || value.some((warning) => {
          if (!isRecord(warning)) return true;
          const keys = Object.keys(warning).sort();
          return (
            JSON.stringify(keys) !== JSON.stringify(["code", "count"]) ||
            typeof warning.code !== "string" ||
            !/^[A-Z][A-Z0-9_]{0,63}$/u.test(warning.code) ||
            !Number.isSafeInteger(warning.count) ||
            warning.count < 0 ||
            warning.count > Math.max(
              summary.dimensions.respondents * Math.max(1, summary.dimensions.items),
              summary.dimensions.items * summary.dimensions.latentClasses,
            )
          );
        })) {
          fail("PRIVACY_AUDIT", "Aggregate summary contains invalid warning records.", 70);
        }
      }
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      if (forbidden.has(key)) fail("PRIVACY_AUDIT", `Summary contains forbidden field ${key}.`, 70);
      visit(nested, `${path}.${key}`);
    }
  };
  visit(summary, "summary");
}

function reviewWarnings(result, validated, comparison) {
  const warnings = [];
  const [lower, upper] = validated.estimation.probabilityBounds;
  const boundaryReviewBand = Math.max(1e-6, 10 * validated.estimation.convergenceTolerance);
  const boundaryCount = flatten(result.estimates.items.map((item) => item.groupSuccessProbabilities))
    .filter((value) => value - lower <= boundaryReviewBand || upper - value <= boundaryReviewBand)
    .length;
  if (boundaryCount > 0) warnings.push({ code: "BOUNDARY_ITEM_PROBABILITY", count: boundaryCount });
  const smallClassCount = result.estimates.classProbabilities.filter((value) => value < 1e-8).length;
  if (smallClassCount > 0) warnings.push({ code: "VERY_SMALL_CLASS_PROBABILITY", count: smallClassCount });
  const mapTieCount = result.scores.mapHasTies.filter(Boolean).length;
  const mleTieCount = result.scores.mleHasTies.filter(Boolean).length;
  if (mapTieCount > 0) warnings.push({ code: "MAP_TIES", count: mapTieCount });
  if (mleTieCount > 0) warnings.push({ code: "MLE_TIES", count: mleTieCount });
  if ((comparison?.r.warningCount ?? 0) > 0) {
    warnings.push({ code: "R_WARNINGS", count: comparison.r.warningCount });
  }
  if ((comparison?.r.mapNearTieCount ?? 0) > 0) {
    warnings.push({ code: "R_MAP_NEAR_TIES", count: comparison.r.mapNearTieCount });
  }
  if ((comparison?.r.mleNearTieCount ?? 0) > 0) {
    warnings.push({ code: "R_MLE_NEAR_TIES", count: comparison.r.mleNearTieCount });
  }
  return {
    warnings,
    boundaryCount,
    boundaryReviewBand,
    smallClassCount,
    mapTieCount,
    mleTieCount,
  };
}

function summaryMarkdown(summary) {
  const lines = [
    "# Private user-data jGDINA technical acceptance",
    "",
    `Status: **${summary.status}**`,
    "",
    `Case: \`${summary.caseId}\``,
    "",
    `Dimensions: ${summary.dimensions.respondents} respondents × ${summary.dimensions.items} items × ${summary.dimensions.attributes} attributes (${summary.dimensions.latentClasses} latent classes).`,
    "",
    `jGDINA: ${summary.jgdina.converged ? "converged" : "not converged"} in ${summary.jgdina.iterations} iterations; log likelihood ${summary.jgdina.logLikelihood}.`,
    "",
  ];
  if (summary.parity === null) {
    lines.push("R parity: not run.", "");
  } else {
    lines.push(
      `R parity: **${summary.parity.passed ? "PASS" : "FAIL"}** via \`${summary.parity.r.implementation}\`.`,
      "",
      `Maximum differences: item probability ${summary.parity.differences.itemProbabilities.maxAbsoluteDifference}, class prior ${summary.parity.differences.classPrior.maxAbsoluteDifference}, EAP ${summary.parity.differences.eapProbabilities.maxAbsoluteDifference}, log likelihood ${summary.parity.differences.finalLogLikelihood.maxAbsoluteDifference}.`,
      "",
    );
  }
  if (summary.review.warnings.length > 0) {
    lines.push("Review warnings:", "", ...summary.review.warnings.map((warning) => `- ${warning.code}: ${warning.count}`), "");
  }
  lines.push(
    "This summary intentionally contains no response/Q matrix, respondent identifier, posterior, or person-level classification.",
    "",
    "Passing numerical parity does not validate the Q-matrix or replace model/item fit, uncertainty, or substantive psychometric review.",
    "",
    "The frozen kernel/base-R oracle is not the complete public GDINA() wrapper; final instrument acceptance remains false.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

async function atomicWrite(path, contents) {
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    rethrowOutputPathError(error);
  }
}

async function writeEvidenceSet(outputPath, contentsByName) {
  const commitOrder = ["provenance.private.json", "SUMMARY.md", "summary.json"];
  if (
    JSON.stringify(Object.keys(contentsByName).sort()) !==
    JSON.stringify([...commitOrder].sort())
  ) {
    fail("INTERNAL", "Evidence set has an unexpected file contract.", 70);
  }
  const staging = await mkdtemp(join(outputPath, ".jgdina-evidence-staging-"));
  await chmod(staging, 0o700);
  activeEvidenceStaging = staging;
  try {
    for (const name of commitOrder) {
      await atomicWrite(join(staging, name), contentsByName[name]);
    }
    for (const name of commitOrder) {
      await rename(join(staging, name), join(outputPath, name));
    }
    for (const name of commitOrder) {
      const path = join(outputPath, name);
      const metadata = await stat(path);
      if (
        !metadata.isFile() ||
        (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
        (metadata.mode & 0o777) !== 0o600
      ) {
        fail("OUTPUT_FILE_SECURITY", "A private evidence file violated its owner/mode contract.", 65);
      }
      await assertNoExtendedAcl(path, "OUTPUT_FILE_ACL");
    }
  } catch (error) {
    await Promise.all(
      commitOrder.map((name) => rm(join(outputPath, name), { force: true }).catch(() => {})),
    );
    rethrowOutputPathError(error);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (activeEvidenceStaging === staging) activeEvidenceStaging = null;
  }
}

function privateProvenance(envelope, caseFileHash, normalized, initializationHash) {
  const provenance = {
    schemaVersion: "jgdina-user-provenance/1",
    caseId: envelope.caseId,
    private: true,
    caseFileSha256: caseFileHash,
    normalizedFitInputSha256: stableSha256(normalized.input),
    initializationSha256: initializationHash,
    note: "Hashes are linkage metadata for the private case and should not be published by default.",
  };
  const expectedKeys = [
    "caseFileSha256",
    "caseId",
    "initializationSha256",
    "normalizedFitInputSha256",
    "note",
    "private",
    "schemaVersion",
  ];
  if (
    JSON.stringify(Object.keys(provenance).sort()) !== JSON.stringify(expectedKeys) ||
    ![provenance.caseFileSha256, provenance.normalizedFitInputSha256, provenance.initializationSha256]
      .every((value) => /^[a-f0-9]{64}$/u.test(value))
  ) {
    fail("PRIVACY_AUDIT", "Private provenance violated its aggregate-only contract.", 70);
  }
  return provenance;
}

async function writeNumericalFailureEvidence({
  outputPath,
  envelope,
  caseFileHash,
  normalized,
  validated,
  preflight,
  initializationHash,
  elapsedMilliseconds,
}) {
  const summary = {
    schemaVersion: "jgdina-user-acceptance/1",
    status: "FAIL",
    caseId: envelope.caseId,
    generatedBy: "validation/user-data/accept.mjs",
    acceptanceScope: "technical-frozen-kernel-or-independent-equations-parity",
    finalInstrumentAcceptance: false,
    privacy: preflight.privacy,
    dimensions: validated.dimensions,
    missingResponseCount: validated.missingResponseCount,
    modelCounts: preflight.modelCounts,
    priorType: validated.prior.type,
    rOracleMemoryEstimate: preflight.rOracleMemoryEstimate,
    runtimeFingerprint: preflight.runtimeFingerprint,
    configuration: {
      aggregateRows: validated.estimation.aggregateRows,
      maxIterations: validated.estimation.maxIterations,
      convergenceTolerance: validated.estimation.convergenceTolerance,
      posteriorStorage: validated.estimation.posteriorStorage,
      probabilityBounds: validated.estimation.probabilityBounds,
      smallSampleCorrection: validated.estimation.smallSampleCorrection,
      starts: validated.estimation.initialization.starts,
      initializationSource: normalized.initializationSource,
      initializationSha256: initializationHash,
    },
    failure: {
      stage: "jgdina-fit",
      code: "NUMERICAL_FAILURE",
      elapsedMilliseconds,
    },
    parity: null,
    limitations: [
      "No R parity decision is possible because the local jGDINA fit failed numerically.",
      "This aggregate report intentionally omits the worker error message and every person-level value.",
    ],
  };
  privacyAudit(summary);
  const markdown = [
    "# Private user-data jGDINA technical acceptance",
    "",
    "Status: **FAIL**",
    "",
    `Case: \`${envelope.caseId}\``,
    "",
    "The local jGDINA worker reported a numerical failure before an R parity decision could be made.",
    "",
    "The aggregate evidence intentionally contains no raw response/Q matrix or person-level score.",
    "",
  ].join("\n");
  const provenance = privateProvenance(
    envelope,
    caseFileHash,
    normalized,
    initializationHash,
  );
  await writeEvidenceSet(outputPath, {
    "summary.json": `${JSON.stringify(summary, null, 2)}\n`,
    "SUMMARY.md": `${markdown}\n`,
    "provenance.private.json": `${JSON.stringify(provenance, null, 2)}\n`,
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node validation/user-data/accept.mjs --case <private.json> [--preflight] [--out <new-private-directory>] [--oracle kernel|base-r|none]\n",
    );
    return 0;
  }
  if (process.platform === "win32") {
    fail(
      "PLATFORM_PRIVACY",
      "This private acceptance workflow requires POSIX file-permission semantics; Windows ACL validation is not yet implemented.",
      69,
    );
  }
  const caseContents = await readPrivateCaseFile(options.casePath);
  const caseFileHash = sha256(caseContents);
  let envelope;
  try {
    envelope = validateEnvelope(JSON.parse(caseContents.toString("utf8")));
  } catch (error) {
    if (error instanceof AcceptanceError) throw error;
    fail("INVALID_JSON", "Case file is not valid JSON.", 65);
  }
  const normalized = normalizeCase(envelope, options.oracle);
  const validated = validateFitInputOrFail(normalized.input);
  const initializationHash = stableSha256(
    validated.estimation.initialization.initialItemProbabilities,
  );
  const rOracleMemoryEstimate = estimateROracleMemory(validated, options.oracle);
  const runtimeFingerprint = await runtimeArtifactFingerprint();
  const verifiedOracleSources = options.oracle !== "none"
    ? await readVerifiedOracleSources(options.oracle === "kernel")
    : null;
  const preflight = aggregatePreflight(
    envelope.caseId,
    validated,
    normalized.initializationSource,
    initializationHash,
    rOracleMemoryEstimate,
    runtimeFingerprint,
  );
  privacyAudit(preflight);
  if (options.preflight) {
    process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`);
    return 0;
  }

  const outputPath = await privateOutputPath(options.outputPath);
  const sensitiveDirectory = await mkdtemp(join(outputPath, ".jgdina-work-"));
  await chmod(sensitiveDirectory, 0o700);
  activeSensitiveDirectory = sensitiveDirectory;
  let sensitiveCleaned = false;
  const cleanupSensitiveDirectory = async () => {
    await rm(sensitiveDirectory, { recursive: true, force: true });
    sensitiveCleaned = true;
    if (activeSensitiveDirectory === sensitiveDirectory) activeSensitiveDirectory = null;
  };
  try {
    process.stderr.write("[1/3] Running the local jGDINA worker fit...\n");
    const beforeRss = process.memoryUsage().rss;
    const started = performance.now();
    let result;
    try {
      result = await fitInNodeWorker(normalized.input);
    } catch (error) {
      const elapsedMilliseconds = performance.now() - started;
      if (error?.code === "NUMERICAL_FAILURE") {
        await cleanupSensitiveDirectory();
        await writeNumericalFailureEvidence({
          outputPath,
          envelope,
          caseFileHash,
          normalized,
          validated,
          preflight,
          initializationHash,
          elapsedMilliseconds,
        });
        process.stdout.write(
          `FAIL ${envelope.caseId}: aggregate numerical-failure evidence written to the private output directory.\n`,
        );
        return 2;
      }
      if (error?.code === "RESOURCE_LIMIT_EXCEEDED") {
        fail("RESOURCE_LIMIT", "The isolated Node worker rejected a safe resource limit.", 65);
      }
      if (error?.code === "ABORTED" || error?.name === "AbortError") {
        fail("ABORTED", "The local jGDINA fit was interrupted.", 130);
      }
      throw error;
    }
    const jgdinaMilliseconds = performance.now() - started;
    const afterRss = process.memoryUsage().rss;

    let comparison = null;
    if (options.oracle !== "none") {
      process.stderr.write("[2/3] Running the private local R numerical oracle...\n");
      const requestPath = join(sensitiveDirectory, "request.json");
      const referencePath = join(sensitiveDirectory, "reference.json");
      const oracleScriptPath = join(sensitiveDirectory, "oracle.R");
      const equationsPath = join(sensitiveDirectory, "equations.R");
      const kernelPath = options.oracle === "kernel"
        ? join(sensitiveDirectory, "frozen-Lik2.cpp")
        : null;
      const initialPrior = validated.prior.type === "fixed"
        ? validated.prior.probabilities
        : validated.prior.initialProbabilities;
      const request = {
        responses: validated.responses,
        q_matrix: validated.qMatrix,
        models: validated.models,
        prior_mode: validated.prior.type,
        initial_prior: initialPrior,
        initial_item_group_probabilities: expandInitialItemsForOracle(validated),
        estimation: {
          max_iterations: validated.estimation.maxIterations,
          convergence_tolerance: validated.estimation.convergenceTolerance,
          probability_bounds: validated.estimation.probabilityBounds,
          small_sample_correction: validated.estimation.smallSampleCorrection,
        },
        kernel_source_path: kernelPath,
        kernel_sha256: options.oracle === "kernel" ? frozenKernelSha256 : null,
        oracle_sha256: oracleSha256,
        equations_source_path: equationsPath,
        equations_sha256: equationsSha256,
        upstream_tree_sha256: frozenUpstreamTreeSha256,
      };
      const sourcesToWrite = [
        [oracleScriptPath, verifiedOracleSources.oracleSource],
        [equationsPath, verifiedOracleSources.equationsSource],
      ];
      if (kernelPath !== null) {
        sourcesToWrite.push([kernelPath, verifiedOracleSources.kernelSource]);
      }
      for (const [path, source] of sourcesToWrite) {
        await writeFile(path, source, { mode: 0o600, flag: "wx" });
      }
      await writeFile(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600, flag: "wx" });
      await runROracle(options.oracle, oracleScriptPath, requestPath, referencePath);
      await chmod(referencePath, 0o600);
      const reference = JSON.parse(await readFile(referencePath, "utf8"));
      validateOracleReference(reference, validated, options.oracle, result);
      await cleanupSensitiveDirectory();
      comparison = await compareWithOracle(
        result,
        validated,
        reference,
        normalized.tolerances,
        options.oracle,
      );
    }
    if (!sensitiveCleaned) await cleanupSensitiveDirectory();
    process.stderr.write("[3/3] Writing aggregate-only private evidence...\n");

    const review = reviewWarnings(result, validated, comparison);
    const failed = !result.convergence.converged || result.convergence.reason !== "tolerance" || comparison?.passed === false;
    const status = failed
      ? "FAIL"
      : options.oracle === "none"
        ? "FIT_ONLY"
        : review.warnings.length > 0
          ? "REVIEW"
          : "PASS";
    const summary = {
      schemaVersion: "jgdina-user-acceptance/1",
      status,
      caseId: envelope.caseId,
      generatedBy: "validation/user-data/accept.mjs",
      acceptanceScope: "technical-frozen-kernel-or-independent-equations-parity",
      finalInstrumentAcceptance: false,
      privacy: preflight.privacy,
      dimensions: validated.dimensions,
      missingResponseCount: validated.missingResponseCount,
      modelCounts: preflight.modelCounts,
      priorType: validated.prior.type,
      rOracleMemoryEstimate,
      runtimeFingerprint,
      configuration: {
        aggregateRows: validated.estimation.aggregateRows,
        maxIterations: validated.estimation.maxIterations,
        convergenceTolerance: validated.estimation.convergenceTolerance,
        posteriorStorage: validated.estimation.posteriorStorage,
        probabilityBounds: validated.estimation.probabilityBounds,
        smallSampleCorrection: validated.estimation.smallSampleCorrection,
        starts: validated.estimation.initialization.starts,
        initializationSource: normalized.initializationSource,
        initializationSha256: initializationHash,
      },
      jgdina: {
        version: jgdinaVersion,
        backendId: result.backendId,
        converged: result.convergence.converged,
        reason: result.convergence.reason,
        iterations: result.convergence.iterations,
        finalChange: result.convergence.finalChange,
        logLikelihood: result.statistics.logLikelihood,
        elapsedMilliseconds: jgdinaMilliseconds,
        rssDeltaBytes: afterRss - beforeRss,
        processPeakResidentBytes: resourceUsage().maxRSS * 1024,
        estimatedBytes: result.diagnostics.memoryEstimate.estimatedBytes,
      },
      parity: comparison,
      tolerances: normalized.tolerances,
      review,
      limitations: [
        "Numerical parity validates this closed-form fit configuration, not the substantive Q-matrix.",
        "The technical oracle is not the complete public GDINA() wrapper.",
        "jGDINA v1 does not replace model/item fit, Q validation, standard errors, DIF, or uncertainty analysis.",
      ],
    };
    privacyAudit(summary);
    const provenance = privateProvenance(
      envelope,
      caseFileHash,
      normalized,
      initializationHash,
    );
    await writeEvidenceSet(outputPath, {
      "summary.json": `${JSON.stringify(summary, null, 2)}\n`,
      "SUMMARY.md": summaryMarkdown(summary),
      "provenance.private.json": `${JSON.stringify(provenance, null, 2)}\n`,
    });
    process.stdout.write(`${status} ${envelope.caseId}: summary written to the private output directory.\n`);
    if (status === "PASS") return 0;
    if (status === "FAIL") return 2;
    return 3;
  } finally {
    if (!sensitiveCleaned) await cleanupSensitiveDirectory();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  const accepted = error instanceof AcceptanceError
    ? error
    : new AcceptanceError("INTERNAL", "Unexpected internal acceptance failure.", 70);
  console.error(`${accepted.code}: ${accepted.message}`);
  process.exitCode = accepted.exitCode;
}
