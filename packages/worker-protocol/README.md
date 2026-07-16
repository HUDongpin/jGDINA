# @jgdina/worker-protocol

Internal, environment-neutral typed-array wire protocol shared by the jGDINA
browser and Node worker adapters. Most applications should use `jgdina`,
`@jgdina/browser`, `@jgdina/node`, or `@jgdina/next` instead.

The wire format is implementation infrastructure, not a persistence or public
network protocol. Persist the JSON-safe `FitResult` together with its
`schemaVersion` and package version instead.

License: GPL-3.0-only; see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
Compatibility provenance is in [UPSTREAM.md](./UPSTREAM.md). The preferred
TypeScript source and exact package-local rebuild procedure are in
[SOURCE.md](./SOURCE.md).
