# Source and rebuilding @jgdina/core

This npm archive includes this package's preferred form for modification under
`src/**`, together with the package-local build controls needed to regenerate
`dist/**`. The generated JavaScript and declarations are not a substitute for
the included TypeScript source.

## Included build inputs

- `src/**`: complete TypeScript source for this package;
- `tsconfig.source.json`: standalone compiler settings;
- `tsconfig.json`: package-local TypeScript entry that extends those settings;
- `package.json`: the exact `build:source` command and pinned development
  tools; and
- `LICENSE`, `NOTICE`, and `UPSTREAM.md`: license and provenance.

The RC was verified with Node.js `v24.15.0`, npm `11.12.1`, tsup `8.5.1`,
and TypeScript `5.9.3`. The package contract remains Node.js `>=20`.

## Rebuild this package

Extract the archive so that its `package/` directory is the project root.
After the same-version internal dependencies are available to npm, run:

```sh
npm install --include=dev
npm run build:source
```

The build uses exact direct development-tool versions from `package.json` and
regenerates `dist/**` from `src/**`. This package has no internal runtime dependencies.

The release bundle records and verifies the workspace-locked tsup, TypeScript,
esbuild, Rollup, and Node type versions used for the byte-identical rebuild.
A later standalone `npm install` may resolve different transitive tool versions,
so byte-identical output is claimed only for that recorded release toolchain.

Source maps are emitted with embedded `sourcesContent`; the release checks
compare that embedded content byte-for-byte with the packaged TypeScript files.

## Full-project evidence

This per-package archive does not duplicate the complete jGDINA workspace.
The local jGDINA project contains the cross-package tests, numerical fixtures,
real-data acceptance evidence, benchmark corpus, release tooling, documentation,
and frozen `GDINA-master/` upstream snapshot. Those materials validate the
package but are not required to compile this package's included source.
