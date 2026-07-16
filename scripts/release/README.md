# Release-candidate runbook

This runbook prepares a jGDINA release candidate without making registry or Git
changes. The canonical package order is defined in `config.mjs` and checked
from the actual dependency graph before any tarball is created.

## Required gates

- All seven package manifests, exact internal dependency versions, the root
  lock, and the Next.js example lock use the same `x.y.z-rc.n` version.
- `CHANGELOG.md` contains an entry for that exact version.
- Git has a valid `HEAD`, the worktree is clean (including untracked files),
  and the corresponding `v<version>` tag does not exist.
- Type checking, unit tests, production builds, Node runtime smoke tests, the
  frozen-upstream and benchmark-data reproducibility checks, independent R
  oracle, the Next.js 16 production build, and npm audits pass.
- Every tarball contains generated `dist/`, its complete preferred TypeScript
  `src/`, `package.json`, `README.md`, `SOURCE.md`, standalone source-build
  TypeScript controls, `LICENSE`, `NOTICE`, and `UPSTREAM.md` (plus the Node
  source-map normalization control).
- All tarballs install together in an empty project; ESM, supported CommonJS
  exports, a direct fit, and a Node worker fit succeed from installed content.
- Every package rebuilds outside `node_modules` from its packed source with the
  pinned toolchain; the rebuilt `dist/` is byte-identical and repeats all
  runtime smokes. Source-map `sourcesContent` must equal packed source.
- Tree-shaken Node and browser-worker entry bundles retain their required
  initialization side effects.
- The actual installed tsup, TypeScript, esbuild, Rollup, Node types, and
  Playwright CLI versions exactly match the committed root lock before build.

Install the locked root dependencies, then run the complete non-publishing
preflight from a clean commit:

```sh
npm ci
npm ci --prefix examples/next-app
npm run smoke:next-production:install-browser # one-time online browser preparation
npm run release:check -- 1.0.0-rc.1
```

Instead of installing bundled Chromium, a maintainer with a compatible local
browser may set `PLAYWRIGHT_CLI_BROWSER=chrome` (or another explicitly prepared
Playwright CLI browser id) on the production-smoke and bundle commands. Browser
installation is preparation; release commands do not download a browser or
fall back to an unpinned `npx` package.

The strict command checks Git before doing work, then serially runs the Node
type/unit/build/runtime gates, independent R oracle, real-data R comparison,
the frozen source/data evidence checks, both npm audits, a locked Next example
install, Next typecheck and production build, and the seven-package
pack/install smoke. It rechecks the clean
worktree and tag availability after generated-output gates and once more after
packaging. This catches stale committed oracle evidence or tooling that edits a
tracked file during verification.

The current uncommitted development tree can exercise the fast package-only
path with `npm run release:pack-smoke`. It validates metadata and publish order,
builds the packages, checks every tarball's contents, and runs the clean-install
smoke. It deliberately skips Git checks and does not repeat unit tests, R gates,
audits, or the Next production build, so it is not evidence that a release
commit is ready.

Use `--keep-packs` when a human needs to inspect the generated `.tgz` files.
By default they are created under the operating-system temporary directory and
deleted after the smoke tests.

## Retained local offline bundle

After the desired source tree passes the relevant gates, create a fixed local
release bundle without publishing, tagging, committing, contacting GitHub, or
requiring a registry login:

```sh
npm run release:bundle -- 1.0.0-rc.1
```

The command requires a local Git `HEAD`, a clean worktree, and an unused local
`v<version>` tag; GitHub and a Git remote are not required. It validates the
same manifest, lockfile, package-content, and publication-order contracts used
by `release:check`; builds all seven packages; and replaces only
`.release/<version>/`. It deliberately leaves `.release/` ignored by Git so
binary candidates cannot be committed accidentally.

The retained directory contains seven `.tgz` files, `manifest.json`,
`next-production-e2e.json`, and `SHA256SUMS`. The deterministic manifest records each package directory, name,
version, filename, packed and unpacked byte sizes, SHA-256, npm integrity,
npm shasum, and complete packed file list. It contains no timestamps or
machine-local absolute paths. `SHA256SUMS` covers all tarballs, the manifest,
and the fixed-tarball Next.js evidence.
For provenance, it also records the local Git `HEAD` and tree, clean-worktree
result, root and Next-example lockfile SHA-256 values, Node/npm versions, and
the intended local tag's availability. Those provenance values are checked
again after packing and smoke tests, so a concurrent source, lockfile,
toolchain, commit, or tag change prevents replacement of the retained bundle.

Each packed `LICENSE`, `NOTICE`, and `UPSTREAM.md` is extracted from the
tarball and required to match its root counterpart byte-for-byte; checking the
filename or npm file list alone is not accepted as evidence.

The bundle rewrites only the six local jGDINA resolutions in a temporary copy
of the committed Next lock to the fixed staged tarballs. It then runs
`npm ci --offline` with an unreachable registry: tarball integrity comes from
the staged pack metadata, while every non-jGDINA package retains the committed
version and integrity and must already exist in the npm cache. A cache miss
fails with no network fallback. The separate seven-package smoke still starts
with a new empty cache and proves all release tarballs install together.

The temporary Next.js 16 application then runs typecheck, production
build/start, and browser E2E for the Node API worker, browser Worker asset,
cancellation/recovery, and structured errors. The sanitized result is retained
as `next-production-e2e.json` with the committed lock hash and actual pinned
Playwright/browser versions. A deterministic path/type/mode/content tree hash
must also remain identical before and after the production build and E2E.

Before replacing an older bundle of the same version, the command stages all
new output and requires two successive `npm pack` attempts to produce
byte-identical SHA-256 values. These checksums identify the current compiled
build; rerun the command after any source, build-tool, dependency, Node, or npm
change instead of assuming cross-toolchain reproducibility.

The seven staged tarballs are installed together into a newly created empty
project with a newly created empty npm cache. npm is forced into `--offline`
mode, uses a deliberately unreachable registry URL, ignores lifecycle scripts,
and does not resolve the `next` peer from the registry. Separate ESM import,
supported CommonJS require, direct fit, and Node worker fit smokes must all pass
before the staged directory can replace the retained bundle.

For the strict preflight plus retained bundle, use this sequence from the
intended clean release commit:

```sh
npm run release:check -- 1.0.0-rc.1
npm run release:bundle -- 1.0.0-rc.1
```

The second command is intentionally independent: it can also be used locally
when GitHub is not in scope, and neither command publishes to npm.

During development, `npm run release:bundle -- --allow-dirty 1.0.0-rc.1`
explicitly bypasses only the clean-source gate and writes to the isolated
`.release/1.0.0-rc.1-dev/` directory. Its manifest is marked
`local-evaluation`; it cannot replace or qualify as the official RC bundle.

## Publication order

If the release candidate is approved later, publish manually in this order:

1. `@jgdina/core`
2. `@jgdina/kernels-js`
3. `@jgdina/worker-protocol`
4. `jgdina`
5. `@jgdina/browser`
6. `@jgdina/node`
7. `@jgdina/next`

This repository intentionally contains no script that invokes `npm publish`,
creates a commit, or creates/pushes a tag. Publication requires an authorized
maintainer to review the retained tarballs, confirm npm scope ownership and
two-factor authentication, publish with the `next` dist-tag, and create the Git
tag only after all seven registry records are verified.
