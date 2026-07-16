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
  independent R oracle, the Next.js 16 production build, and npm audits pass.
- Every tarball contains only `dist/`, `package.json`, `README.md`, `LICENSE`,
  `NOTICE`, and `UPSTREAM.md`.
- All tarballs install together in an empty project; ESM, supported CommonJS
  exports, a direct fit, and a Node worker fit succeed from installed content.

Install the locked root dependencies, then run the complete non-publishing
preflight from a clean commit:

```sh
npm ci
npm run release:check -- 1.0.0-rc.1
```

The strict command checks Git before doing work, then serially runs the Node
type/unit/build/runtime gates, independent R oracle, real-data R comparison,
both npm audits, a locked Next example install, Next typecheck and production
build, and the seven-package pack/install smoke. It rechecks the clean
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
