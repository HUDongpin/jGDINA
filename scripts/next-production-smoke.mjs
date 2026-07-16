#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants, existsSync } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const example = path.resolve(
  root,
  process.env.JGDINA_NEXT_EXAMPLE_DIR ?? path.join("examples", "next-app"),
);
const output = path.resolve(
  root,
  process.env.JGDINA_NEXT_SMOKE_OUTPUT ?? path.join("output", "playwright", "next-production-smoke"),
);
const dependencyModeOverride = process.env.JGDINA_NEXT_DEPENDENCY_MODE;
const dependencyMode = dependencyModeOverride ??
  "npm file: dependencies packed by install-links=true (not fixed release tarballs)";
const session = `jgdina-production-${process.pid}`;
const cliPackage = process.env.PLAYWRIGHT_CLI_PACKAGE ?? "@playwright/cli@0.1.17";
const localCliBinary = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "playwright-cli.cmd" : "playwright-cli",
);
const cliBinary = process.env.PLAYWRIGHT_CLI_BIN ?? localCliBinary;
const report = {
  schemaVersion: "1.0",
  status: "running",
  generatedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    playwrightCliPackage: cliPackage,
    playwrightCliBinary: path.relative(root, cliBinary),
    playwrightCliVersion: null,
    browser: process.env.PLAYWRIGHT_CLI_BROWSER ?? "bundled Chromium",
  },
  checks: {},
};

let nextProcess;
let sessionOpened = false;
let serverLog = "";
let cliLog = "";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? await listFiles(absolute) : [absolute];
    }),
  );
  return nested.flat();
}

async function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: {
        ...process.env,
        npm_config_ignore_scripts: "true",
        npm_config_prefer_offline: "true",
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(
          `${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`}).\n${stdout}${stderr}`,
        ));
      }
    });
  });
}

async function runCli(label, args, options = {}) {
  const result = await run(cliBinary, ["--session", session, ...args], { cwd: output, ...options });
  const combined = `${result.stdout}${result.stderr}`;
  cliLog += `\n## ${label}\n${combined}`;
  await writeFile(path.join(output, `${label}.txt`), combined);
  return result.stdout.trim();
}

function parseCliJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}\n${value}`);
  }
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string", "Could not reserve a TCP port.");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (nextProcess?.exitCode !== null) {
      throw new Error(`next start exited before becoming ready.\n${serverLog}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // next start is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`next start did not become ready at ${url}.\n${serverLog}`);
}

async function stopServer() {
  if (nextProcess === undefined || nextProcess.exitCode !== null) return;
  nextProcess.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => nextProcess.once("close", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited) nextProcess.kill("SIGKILL");
}

async function inspectBuild() {
  const buildIdPath = path.join(example, ".next", "BUILD_ID");
  const buildStat = await stat(buildIdPath);
  const sourceRoots = [
    path.join(example, "app"),
    path.join(example, "components"),
    path.join(example, "lib"),
  ];
  const sourceFiles = [
    ...(await Promise.all(sourceRoots.map(listFiles))).flat(),
    path.join(example, "next.config.mjs"),
    path.join(example, "package.json"),
  ];
  const newerSources = [];
  for (const file of sourceFiles) {
    if ((await stat(file)).mtimeMs > buildStat.mtimeMs + 1) newerSources.push(path.relative(root, file));
  }
  assert(
    newerSources.length === 0,
    `The Next.js production build is stale. Re-run npm run build in ${example}. Newer files: ${newerSources.join(", ")}`,
  );

  const staticFiles = await listFiles(path.join(example, ".next", "static"));
  const browserWorkerAssets = staticFiles
    .filter((file) => /[/\\]worker-entry\.[^/\\]+\.js$/.test(file))
    .map((file) => path.relative(root, file));
  assert(browserWorkerAssets.length > 0, "No hashed browser worker-entry asset was emitted.");

  const routeTracePath = path.join(example, ".next", "server", "app", "api", "jgdina", "route.js.nft.json");
  const routeTrace = JSON.parse(await readFile(routeTracePath, "utf8"));
  const nodeWorkerTrace = routeTrace.files.find((file) =>
    file.endsWith("node/dist/worker-entry.js"),
  );
  assert(nodeWorkerTrace !== undefined, "The API route trace does not include the Node worker entry.");
  const tracedNodeWorker = path.resolve(path.dirname(routeTracePath), nodeWorkerTrace);
  await access(tracedNodeWorker, fsConstants.R_OK);

  if (dependencyModeOverride === undefined) {
    const npmrc = await readFile(path.join(example, ".npmrc"), "utf8");
    assert(/install-links\s*=\s*true/.test(npmrc), "The example must exercise packed file: dependencies with install-links=true.");
  }

  return {
    buildId: (await readFile(buildIdPath, "utf8")).trim(),
    browserWorkerAssets,
    nodeRouteTrace: path.relative(root, routeTracePath),
    tracedNodeWorker: path.relative(root, tracedNodeWorker),
    dependencyMode,
  };
}

async function checkApiErrors(baseUrl) {
  const request = async (body, contentType = "application/json") => {
    const response = await fetch(`${baseUrl}/api/jgdina`, {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });
    return { status: response.status, payload: await response.json() };
  };
  const cases = {
    unsupportedMediaType: await request("hello", "text/plain"),
    malformedJson: await request("{"),
    invalidInput: await request(JSON.stringify({ responses: [], qMatrix: [] })),
  };
  const expected = {
    unsupportedMediaType: [415, "UNSUPPORTED_MEDIA_TYPE"],
    malformedJson: [400, "INVALID_JSON"],
    invalidInput: [422, "INVALID_INPUT"],
  };
  for (const [name, [status, code]] of Object.entries(expected)) {
    assert(cases[name].status === status, `${name} returned ${cases[name].status}, expected ${status}.`);
    assert(cases[name].payload?.ok === false, `${name} did not return the error envelope.`);
    assert(cases[name].payload?.error?.code === code, `${name} returned the wrong error code.`);
    assert(!JSON.stringify(cases[name].payload).includes("stack"), `${name} exposed a stack.`);
  }
  return cases;
}

function assertCleanBrowserResult(result, label) {
  assert(result.consoleErrors.length === 0, `${label} emitted console errors: ${result.consoleErrors.join(" | ")}`);
  assert(result.pageErrors.length === 0, `${label} emitted page errors: ${result.pageErrors.join(" | ")}`);
  assert(result.failedRequests.length === 0, `${label} had failed requests: ${JSON.stringify(result.failedRequests)}`);
}

const apiFitCode = String.raw`async (page) => {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const onConsole = (message) => { if (message.type() === "error") consoleErrors.push(message.text()); };
  const onPageError = (error) => pageErrors.push(error.message);
  const onRequestFailed = (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? "unknown" });
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/jgdina") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Fit through API route" }).click();
  const response = await responsePromise;
  await page.waitForFunction(() => {
    try { return JSON.parse(document.querySelector("pre")?.textContent ?? "").ok === true; }
    catch { return false; }
  }, null, { timeout: 30_000 });
  const payload = JSON.parse(await page.locator("pre").innerText());
  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  page.off("requestfailed", onRequestFailed);
  return {
    httpStatus: response.status(),
    backendId: payload.result.backendId,
    converged: payload.result.convergence.converged,
    consoleErrors,
    pageErrors,
    failedRequests,
  };
}`;

const clientFitCode = String.raw`async (page) => {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const workerResponses = [];
  const onConsole = (message) => { if (message.type() === "error") consoleErrors.push(message.text()); };
  const onPageError = (error) => pageErrors.push(error.message);
  const onRequestFailed = (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? "unknown" });
  const onResponse = (response) => {
    if (/worker-entry|turbopack-worker/.test(response.url())) workerResponses.push({ url: response.url(), status: response.status() });
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);
  await page.getByRole("button", { name: "Fit entirely in browser" }).click();
  await page.locator('pre[data-fit-state="succeeded"]').waitFor({ timeout: 30_000 });
  const payload = JSON.parse(await page.locator("pre").innerText());
  await page.waitForTimeout(100);
  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  page.off("requestfailed", onRequestFailed);
  page.off("response", onResponse);
  const workerResources = await page.evaluate(() => performance.getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => /worker-entry|turbopack-worker/.test(name)));
  return {
    backendId: payload.backendId,
    converged: payload.convergence.converged,
    workerResponses,
    workerResources,
    consoleErrors,
    pageErrors,
    failedRequests,
  };
}`;

const cancellationCode = String.raw`async (page) => {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const workerResponses = [];
  const onConsole = (message) => { if (message.type() === "error") consoleErrors.push(message.text()); };
  const onPageError = (error) => pageErrors.push(error.message);
  const onRequestFailed = (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? "unknown" });
  const onResponse = (response) => {
    if (/worker-entry|turbopack-worker/.test(response.url())) workerResponses.push({ url: response.url(), status: response.status() });
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);
  const startedAt = Date.now();
  await page.getByRole("button", { name: "Start cancellation demo" }).click();
  await page.locator('pre[data-fit-state="running"]').waitFor({ timeout: 10_000 });
  const workerDeadline = Date.now() + 5_000;
  while (!workerResponses.some(({ status }) => status === 200) && Date.now() < workerDeadline) {
    await page.waitForTimeout(25);
  }
  if (!workerResponses.some(({ status }) => status === 200)) {
    throw new Error("The cancellation workload did not start a production Worker.");
  }
  await page.waitForTimeout(100);
  if (await page.locator("pre").getAttribute("data-fit-state") !== "running") {
    throw new Error("The cancellation workload finished before it could be cancelled.");
  }
  await page.getByRole("button", { name: "Cancel fit" }).click();
  await page.locator('pre[data-fit-state="cancelled"]').waitFor({ timeout: 10_000 });
  const cancelledText = await page.locator("pre").innerText();
  const recoveryButton = page.getByRole("button", { name: "Fit entirely in browser" });
  if (!(await recoveryButton.isEnabled())) throw new Error("The normal-fit control did not recover after cancellation.");
  await recoveryButton.click();
  await page.locator('pre[data-fit-state="succeeded"]').waitFor({ timeout: 30_000 });
  const recovery = JSON.parse(await page.locator("pre").innerText());
  await page.waitForTimeout(100);
  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  page.off("requestfailed", onRequestFailed);
  page.off("response", onResponse);
  return {
    cancelledText,
    cancellationAndRecoveryMs: Date.now() - startedAt,
    recoveryBackendId: recovery.backendId,
    recoveryConverged: recovery.convergence.converged,
    workerResponses,
    consoleErrors,
    pageErrors,
    failedRequests,
  };
}`;

async function main() {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  assert(existsSync(cliBinary), `Missing pinned Playwright CLI at ${cliBinary}; run npm ci first.`);
  await access(cliBinary, fsConstants.X_OK);
  const cliVersion = await run(cliBinary, ["--version"], { timeoutMs: 10_000 });
  report.runtime.playwrightCliVersion = `${cliVersion.stdout}${cliVersion.stderr}`.trim();

  report.checks.build = await inspectBuild();
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  report.baseUrl = baseUrl;
  const nextBinary = path.join(example, "node_modules", "next", "dist", "bin", "next");
  nextProcess = spawn(process.execPath, [nextBinary, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: example,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  nextProcess.stdout.setEncoding("utf8");
  nextProcess.stderr.setEncoding("utf8");
  nextProcess.stdout.on("data", (chunk) => { serverLog += chunk; });
  nextProcess.stderr.on("data", (chunk) => { serverLog += chunk; });
  await waitForServer(baseUrl);

  const browserArgs = process.env.PLAYWRIGHT_CLI_BROWSER
    ? ["--browser", process.env.PLAYWRIGHT_CLI_BROWSER]
    : [];
  await runCli("01-open-home", ["open", baseUrl, ...browserArgs], { timeoutMs: 90_000 });
  sessionOpened = true;
  await runCli("02-home-snapshot", ["snapshot"]);
  const home = parseCliJson(await runCli("03-home-assert", [
    "--raw",
    "run-code",
    'async (page) => ({ title: await page.title(), heading: await page.getByRole("heading", { name: "jGDINA in Next.js" }).innerText(), links: await page.getByRole("link").allTextContents(), browserVersion: page.context().browser()?.version() ?? null })',
  ]), "home assertion");
  assert(home.heading === "jGDINA in Next.js", "The production home page heading is missing.");
  assert(home.links.length === 2, "The production home page does not expose both fit paths.");
  report.checks.home = home;

  await runCli("04-api-goto", ["goto", `${baseUrl}/api-fit`]);
  await runCli("05-api-snapshot", ["snapshot"]);
  const apiFit = parseCliJson(await runCli("06-api-fit", ["--raw", "run-code", apiFitCode]), "API fit");
  assert(apiFit.httpStatus === 200, `The API fit returned HTTP ${apiFit.httpStatus}.`);
  assert(apiFit.backendId === "node-worker:js", `Unexpected API backendId: ${apiFit.backendId}.`);
  assert(apiFit.converged === true, "The API fit did not converge.");
  assertCleanBrowserResult(apiFit, "API fit");
  report.checks.apiFit = apiFit;
  report.checks.apiErrors = await checkApiErrors(baseUrl);

  await runCli("07-client-goto", ["goto", `${baseUrl}/client`]);
  await runCli("08-client-snapshot", ["snapshot"]);
  const clientFit = parseCliJson(await runCli("09-client-fit", ["--raw", "run-code", clientFitCode]), "client fit");
  assert(clientFit.backendId === "browser-worker:js", `Unexpected browser backendId: ${clientFit.backendId}.`);
  assert(clientFit.converged === true, "The browser fit did not converge.");
  assert(clientFit.workerResponses.some(({ url, status }) => /turbopack-worker/.test(url) && status === 200), "No successful hashed Turbopack Worker response was observed.");
  assertCleanBrowserResult(clientFit, "browser fit");
  report.checks.clientFit = clientFit;
  await runCli("10-client-result-snapshot", ["snapshot"]);

  const cancellation = parseCliJson(await runCli("11-client-cancellation", ["--raw", "run-code", cancellationCode]), "client cancellation");
  assert(cancellation.cancelledText.startsWith("Cancelled:"), "The client did not report an AbortError cancellation.");
  assert(cancellation.recoveryBackendId === "browser-worker:js", "The browser backend did not recover after cancellation.");
  assert(cancellation.recoveryConverged === true, "The recovery fit did not converge.");
  assert(cancellation.workerResponses.some(({ url, status }) => /turbopack-worker/.test(url) && status === 200), "Cancellation did not exercise a real production Worker asset.");
  assertCleanBrowserResult(cancellation, "browser cancellation");
  report.checks.clientCancellation = cancellation;

  await runCli("12-final-snapshot", ["snapshot"]);
  const consoleSummary = await runCli("13-console-errors", ["console", "error"]);
  assert(/Errors:\s*0\b/.test(consoleSummary), `The full browser session recorded a console error.\n${consoleSummary}`);
  report.checks.fullSessionConsole = { errors: 0 };
  await runCli("14-network-requests", ["requests"]);
  await runCli("15-screenshot", ["screenshot"]);
  report.status = "passed";
}

try {
  await main();
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
  process.exitCode = 1;
} finally {
  if (sessionOpened) {
    try { await runCli("16-close", ["close"], { timeoutMs: 15_000 }); }
    catch (error) { report.closeError = error instanceof Error ? error.message : String(error); }
  }
  await stopServer();
  await appendFile(path.join(output, "server.log"), serverLog);
  await appendFile(path.join(output, "playwright-cli.log"), cliLog);
  await writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Next.js production smoke: ${report.status}`);
  console.log(`Evidence: ${path.relative(root, path.join(output, "report.json"))}`);
  if (report.status === "failed") console.error(report.error?.message ?? "Unknown failure");
}
