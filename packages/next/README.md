# @jgdina/next

Thin Next.js App Router adapters for jGDINA v1. The package is licensed under
GPL-3.0-only, like the rest of jGDINA.

The root entry point is server-only and uses `@jgdina/node`. The
`@jgdina/next/client` entry point is browser-only and re-exports
`@jgdina/browser`; neither entry point imports `next` at runtime.

Next.js 16 is the tested and supported RC target. Keep the Node worker package external so its
compiled worker entry remains adjacent to the adapter at runtime:

```js
// next.config.mjs
const nextConfig = {
  serverExternalPackages: ["@jgdina/node"],
};

export default nextConfig;
```

## Node Route Handler

Keep the reusable handler in a normal module so tests or a controlled server
shutdown can call its cleanup API:

```ts
// lib/jgdina-route.ts
import { createJGDINARouteHandler } from "@jgdina/next";

const route = createJGDINARouteHandler({
  maxBodyBytes: 1_048_576,
  node: { size: 1 },
});

export const handleJGDINAPost = route.POST;
export const closeJGDINARoute = route.close;
```

```ts
// app/api/jgdina/route.ts
import { handleJGDINAPost } from "../../../lib/jgdina-route";

// jGDINA uses worker_threads and therefore must not run at the Edge.
export const runtime = "nodejs";

export const POST = handleJGDINAPost;
```

The worker pool is not created until the first well-formed request and is then
reused by later requests in the same module instance. `close()` is idempotent;
after it runs, the handler returns `503` and does not create another pool.

Send a JSON `FitInput`:

```ts
const response = await fetch("/api/jgdina", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    responses: [[0, 0], [0, 1], [1, 0], [1, 1]],
    qMatrix: [[1], [1]],
    model: "DINA",
  }),
});

const payload = await response.json();
if (!payload.ok) throw new Error(payload.error.message);
console.log(payload.result);
```

Successful responses are `{ ok: true, result }`. Errors are
`{ ok: false, error: { code, message, details? } }`. The adapter rejects wrong
methods (`405`), non-JSON content (`415`), malformed JSON (`400`), and bodies
over the configured byte limit (`413`) before it starts a worker. Valid jGDINA
input/resource errors return `422`; aborts return `408`; unexpected failures
return a generic `500` response without internal messages or stacks.

## Fully client-side and static

No API route is required when the fit should remain in the browser. Put the
client code behind the browser-only subpath:

```tsx
// components/client-fit.tsx
"use client";

import { createJGDINAClient } from "@jgdina/next/client";

const jgdina = createJGDINAClient();

export function ClientFit() {
  async function run() {
    const result = await jgdina.fit({
      responses: [[0, 0], [0, 1], [1, 0], [1, 1]],
      qMatrix: [[1], [1]],
      model: "DINA",
    });
    console.log(result);
  }

  return <button onClick={run}>Fit in this browser</button>;
}
```

```tsx
// app/client/page.tsx
import { ClientFit } from "../../components/client-fit";

export const dynamic = "force-static";

export default function ClientPage() {
  return <ClientFit />;
}
```

Each browser fit runs CPU-heavy numerical estimation in a dedicated Web Worker.
Input validation/copying and transport packing still run synchronously on the
main thread before the Worker starts, and result parsing/assertion run there
after it finishes. Worker-phase cancellation is prompt because it terminates
the active Worker; it cannot interrupt those synchronous pre/post phases. The
complete runnable layout is in `examples/next-app`.

## Production boundary

The adapter supplies a bounded JSON body, a lazy worker pool, request-signal
cancellation, and structured errors. It does not supply authentication,
tenancy, quotas, a wall-clock deadline, a durable queue, persistence, or
statistical model-fit diagnostics.

For production, make `posteriorStorage: "scores-only"` the application default,
start with a one-worker pool, set both request and active-memory budgets, and
verify worker packaging and cancellation in the target provider. Move fits to
an application-owned durable job system when they can approach a request
deadline or must survive a disconnect/restart.

The complete local jGDINA workspace contains the production and API guides.
This archive includes the preferred TypeScript source and exact package-local
rebuild procedure in [SOURCE.md](./SOURCE.md), compatibility provenance in
[UPSTREAM.md](./UPSTREAM.md), and the [GPL-3.0-only license](./LICENSE) with
[NOTICE](./NOTICE).
