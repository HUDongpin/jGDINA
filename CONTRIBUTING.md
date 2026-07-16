# Contributing to jGDINA

Contributions are welcome when they preserve the stated compatibility boundary
and include evidence proportional to their numerical or runtime risk.

## Prerequisites

- Node.js 20, 22, or 24 and the npm version bundled with that runtime.
- R plus `jsonlite` when changing or validating numerical fixtures.
- Rcpp, RcppArmadillo, and a C++/Fortran toolchain only for the optional frozen
  upstream fast-kernel comparison.

Install exactly from the root lock and run the ordinary gates:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run verify:runtime
Rscript validation/validate-fixtures.R
```

For the Next.js integration, build the packages first, then use the example's
independent lock:

```sh
npm ci --prefix examples/next-app
npm run typecheck --prefix examples/next-app
npm run build --prefix examples/next-app
```

Do not commit `node_modules/`, `dist/`, coverage, `.next/`, logs, or temporary
tarballs.

## Numerical changes

Numerical behavior requires the strongest review. Describe the governing
equation, canonical ordering, expected impact, and source provenance. Add a
focused TypeScript test and, where the result contract changes, an independently
calculated base-R fixture. Do not loosen a tolerance merely to make a test pass.

`npm run oracle` only checks that committed fixtures reproduce byte-for-byte.
To intentionally regenerate them, run `npm run oracle:generate`, inspect every
JSON diff, update `fixtures/v1/manifest.json` provenance when appropriate, and
then rerun the validator. Changes to `GDINA-master/` are outside normal jGDINA
development and must never be mixed into an implementation pull request.

New model families or diagnostics need an explicit scope, independent oracle,
upstream comparison where possible, resource analysis, public contract, and
documentation. Passing existing v1 fixtures alone is not sufficient evidence.

## Runtime and API changes

Test direct and worker execution, structured errors, cancellation, transfer
boundaries, and both posterior-storage modes as applicable. Public results must
remain JSON-safe. Browser changes need a real-browser smoke; Node worker changes
need ESM and CommonJS installed-package coverage; Next.js changes need a
production build using the locked example.

Keep package dependencies acyclic. Internal release dependencies use an exact
prerelease version so the seven tarballs are tested as one release set.

## Pull requests

Keep changes focused and preserve unrelated work. Explain the user-visible
outcome, compatibility or statistical implications, tests run, and remaining
limitations. Update documentation and `CHANGELOG.md` for user-visible changes.
Never include real respondent data unless it is demonstrably public, licensed,
minimal, and documented.

By contributing, you affirm that you have the right to provide the work under
the repository's GNU GPL version 3 only license and that applicable third-party
notices and provenance are retained.

Before proposing a release candidate, follow `scripts/release/README.md` and
run `npm run release:check` from a clean commit. The checker validates, audits,
builds, and packs locally; it does not publish, commit, or create a tag.
