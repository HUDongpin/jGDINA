export const RELEASE_PACKAGES = Object.freeze([
  Object.freeze({ directory: "packages/core", name: "@jgdina/core", sideEffects: false }),
  Object.freeze({ directory: "packages/kernels-js", name: "@jgdina/kernels-js", sideEffects: false }),
  Object.freeze({ directory: "packages/worker-protocol", name: "@jgdina/worker-protocol", sideEffects: false }),
  Object.freeze({ directory: "packages/jgdina", name: "jgdina", sideEffects: false }),
  Object.freeze({
    directory: "packages/browser",
    name: "@jgdina/browser",
    sideEffects: Object.freeze(["./dist/worker-entry.js"]),
  }),
  Object.freeze({
    additionalSourceEntries: Object.freeze(["scripts"]),
    additionalSourceFiles: Object.freeze(["scripts/normalize-source-maps.mjs"]),
    directory: "packages/node",
    name: "@jgdina/node",
    nodeTypes: true,
    sideEffects: Object.freeze([
      "./dist/index.js",
      "./dist/cjs.cjs",
      "./dist/worker-entry.js",
      "./dist/worker-entry.cjs",
    ]),
  }),
  Object.freeze({
    directory: "packages/next",
    name: "@jgdina/next",
    nodeEngine: ">=20.9",
    nodeTypes: true,
    peerDependencies: Object.freeze({ next: ">=16 <17" }),
    sideEffects: false,
  }),
]);

export const REQUIRED_PACKAGE_FILES = Object.freeze([
  "package.json",
  "README.md",
  "SOURCE.md",
  "tsconfig.json",
  "tsconfig.source.json",
  "LICENSE",
  "NOTICE",
  "UPSTREAM.md",
]);

export const ROOT_SHARED_PACKAGE_FILES = Object.freeze([
  "LICENSE",
  "NOTICE",
  "UPSTREAM.md",
]);

export const PACKAGE_SOURCE_ENTRIES = Object.freeze([
  "src",
  "SOURCE.md",
  "tsconfig.json",
  "tsconfig.source.json",
]);

export const SOURCE_BUILD_TOOL_VERSIONS = Object.freeze({
  "@types/node": "26.1.1",
  tsup: "8.5.1",
  typescript: "5.9.3",
});

export const RELEASE_TOOL_VERSIONS = Object.freeze({
  "@playwright/cli": "0.1.17",
  "@types/node": SOURCE_BUILD_TOOL_VERSIONS["@types/node"],
  esbuild: "0.28.1",
  rollup: "4.62.2",
  tsup: SOURCE_BUILD_TOOL_VERSIONS.tsup,
  typescript: SOURCE_BUILD_TOOL_VERSIONS.typescript,
});
