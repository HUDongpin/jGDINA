# @jgdina/node

Node `worker_threads` execution and a reusable worker pool for jGDINA v1. Both
ES modules and CommonJS are supported on Node.js 20 or newer.

```ts
import { createNodeJGDINA } from "@jgdina/node";

const engine = createNodeJGDINA({ size: 1 });
try {
  const result = await engine.fit(input);
} finally {
  await engine.close();
}
```

Pool size defaults to one because latent-class memory grows as `2^K`. The pool
also limits the sum of active-fit estimates to 512 MiB by default; set
`maxConcurrentEstimatedBytes` only after measuring the target process.

The pool queue is in-process and is not durable. Use an application-owned job
system when work must survive a restart, deployment, request disconnect, or
retry. Prefer `posteriorStorage: "scores-only"` for production requests and
close the pool only during controlled shutdown or test teardown.

License: GPL-3.0-only. Provenance is in `UPSTREAM.md`.

Source-repository guides: [Next.js/Node production operations](../../docs/nextjs-production.md)
and [resource-limit API](../../docs/api-reference.md#resource-limits).
