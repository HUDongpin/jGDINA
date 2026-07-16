export const RELEASE_PACKAGES = Object.freeze([
  Object.freeze({ directory: "packages/core", name: "@jgdina/core" }),
  Object.freeze({ directory: "packages/kernels-js", name: "@jgdina/kernels-js" }),
  Object.freeze({ directory: "packages/worker-protocol", name: "@jgdina/worker-protocol" }),
  Object.freeze({ directory: "packages/jgdina", name: "jgdina" }),
  Object.freeze({ directory: "packages/browser", name: "@jgdina/browser" }),
  Object.freeze({ directory: "packages/node", name: "@jgdina/node" }),
  Object.freeze({ directory: "packages/next", name: "@jgdina/next" }),
]);

export const REQUIRED_PACKAGE_FILES = Object.freeze([
  "package.json",
  "README.md",
  "LICENSE",
  "NOTICE",
  "UPSTREAM.md",
]);
