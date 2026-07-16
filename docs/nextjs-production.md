# Next.js production and deployment guide

jGDINA can fit in a browser Worker, in a Next.js Node Route Handler, or behind
an application-owned durable job system. Choose the boundary from workload
duration, data governance, and operational requirements—not merely from where
the button is rendered.

This guide describes controls that exist in jGDINA v1 and controls the host
application must supply. The runnable layouts are in
[`examples/next-app`](../examples/next-app/README.md).

## Choose the execution boundary

| Boundary | Use when | Main trade-off |
|---|---|---|
| Browser Worker | Data should remain on-device, workloads fit target browsers, and a tab lifetime is acceptable | Device memory/CPU varies; results disappear if the page closes unless the app saves them |
| Node Route Handler | Fits reliably finish inside one provider request and server-side data handling is required | Request duration, instance memory, and worker packaging are provider-dependent |
| Durable application job | Fits may outlive a request, need retries/idempotency, or must survive deploys and disconnects | jGDINA supplies the fitting engine, not the queue, storage, or job-state API |

An Edge function is not a supported execution target. The Node adapter uses
`worker_threads`; explicitly export `runtime = "nodejs"`.

## Recommended Route Handler baseline

Keep the reusable handler in a module, so the pool is shared by requests handled
by the same module instance:

```ts
// lib/jgdina-route.ts
import { createJGDINARouteHandler } from "@jgdina/next";

const route = createJGDINARouteHandler({
  maxBodyBytes: 1_048_576,
  node: {
    size: 1,
    maxConcurrentEstimatedBytes: 384 * 1024 * 1024,
  },
});

export const handleJGDINAPost = route.POST;
export const closeJGDINARoute = route.close;
```

```ts
// app/api/jgdina/route.ts
import { handleJGDINAPost } from "../../../lib/jgdina-route";

export const runtime = "nodejs";
export const maxDuration = 300; // provider configuration, not a jGDINA timeout
export const POST = handleJGDINAPost;
```

Keep the Node package external so its adjacent compiled worker remains a real
file at runtime:

```js
// next.config.mjs
const nextConfig = {
  serverExternalPackages: ["@jgdina/node"],
};

export default nextConfig;
```

Do not create and close a pool for every request. Call `close()` only during a
controlled process shutdown or test teardown. It is idempotent and permanently
closes that handler instance.

## Make score-only the application default

The package default is `posteriorStorage: "full"` for analytical completeness.
For a production endpoint, normalize or require requests to use:

```ts
estimation: {
  posteriorStorage: "scores-only",
}
```

Score-only mode still returns MAP/MLE indices and tie flags, EAP mastery
probabilities, and EAP classifications. It omits only the dense `N x 2^K`
posterior matrix. This lowers retained result memory and the worker-to-server
JSON envelope, but it does not remove the exponential latent-class computation.

If full posteriors are a business requirement, treat that as a separate
workload class with lower dimensions, explicit output-retention policy, and a
measured response-size limit.

## Layer the resource controls

No single limit protects all stages. Configure all of these:

1. **Raw request bytes.** `maxBodyBytes` bounds the streamed UTF-8 request body
   before a worker starts. The default is 1 MiB. This is distinct from the
   provider's request limit and from heap usage after JSON parsing.
2. **Validated-fit estimate.** Set per-request
   `estimation.resourceLimits.maxEstimatedBytes` and appropriate dimension,
   start, and iteration limits. The validator rejects before numerical
   allocation when its conservative estimate exceeds the cap.
3. **Active pool estimate.** Set `node.maxConcurrentEstimatedBytes` below the
   memory available to one application instance. The pool admits work only
   while the sum of active estimates fits that budget.
4. **Pool size.** Start with `size: 1`. Increase only after representative
   concurrency tests because each additional worker may allocate another full
   `2^K` working set.
5. **Provider memory and concurrency.** Account for the Next.js process,
   framework, parsed JSON, worker, result serialization, and simultaneous
   instances. A 512 MiB jGDINA estimate is not safe inside a 512 MiB function.
6. **Response/storage bytes.** Enforce an application policy for result size,
   retention, and downloads. The route adapter does not impose a response-body
   cap.

Lowering limits is safe. Raising them only changes admission and should follow
benchmark evidence from the same runtime and instance shape. `K` is the primary
risk because classes grow as `2^K`; `N`, `J`, starts, and full posterior output
then multiply work or memory.

The memory estimate is intentionally conservative and includes a runtime
reserve, but it is not a hard RSS prediction. Log the estimate and compare it
with observed process/container memory in staging.

## Timeouts and cancellation

jGDINA has no wall-clock `timeout` setting. `maxIterations` bounds EM work but
does not predict duration. Define a deadline at the application boundary with
an `AbortController` for direct Node/browser calls or with the provider's
request-duration configuration for a route.

The Route Handler passes `request.signal` into the Node engine. When the signal
is propagated by the host, cancellation terminates and replaces the active
worker. Do not assume every provider reports a client disconnect promptly;
verify cancellation behavior in the deployed environment.

Client-side usage should cancel work when the user explicitly stops it and
when the owning component no longer needs the result:

```ts
const controller = new AbortController();
const pending = engine.fit(input, { signal: controller.signal });

// User action or application deadline:
controller.abort(new Error("Fit deadline exceeded"));
await pending;
```

Cancellation is not a resumable checkpoint. Retrying starts a new fit. When
retries matter, use the same explicit initialization and a stable application
job ID so the statistical request is reproducible and duplicate result writes
can be suppressed.

## When to cross into a durable job system

Use a durable queue before production—not after the first timeout—when any of
these are true:

- representative p95 duration approaches the provider request limit;
- work must survive browser closure, request disconnect, process restart, or
  deployment;
- automatic retries or scheduled execution are required;
- per-user fairness, backpressure, or an auditable job history is required;
- inputs or outputs exceed comfortable synchronous HTTP sizes; or
- CPU work should run on dedicated compute rather than web instances.

A durable design is application-owned:

1. The API authenticates and validates metadata, stores an immutable input or
   encrypted reference, and enqueues a job with an idempotency key.
2. A Node worker service claims the job, runs `createNodeJGDINA({ size: 1 })`,
   records progress/heartbeats, and writes the versioned `FitResult` atomically.
3. The UI polls or subscribes to job state and downloads the authorized result.
4. Cancellation marks the job and aborts the active fit; a lease/heartbeat
   policy recovers abandoned jobs.

The bundled `NodeWorkerPool` is an in-process CPU/memory admission queue. It is
not durable: queued work is lost when the process exits, and multiple serverless
instances do not share its state.

## HTTP contract and boundaries

The Route Handler accepts only a JSON object containing `FitInput`.

Successful response:

```json
{ "ok": true, "result": { "schemaVersion": "1.0" } }
```

Error response:

```json
{
  "ok": false,
  "error": {
    "code": "RESOURCE_LIMIT_EXCEEDED",
    "message": "...",
    "details": { "limit": "estimatedBytes", "actual": 1, "maximum": 1 }
  }
}
```

| Status | Adapter condition |
|---:|---|
| `400` | Invalid content length, malformed UTF-8/JSON, or non-object body |
| `405` | Non-POST method |
| `408` | Request or fit aborted |
| `413` | Raw body exceeds `maxBodyBytes` |
| `415` | Content type is not `application/json` or `application/*+json` |
| `422` | Invalid fit input, resource limit, or numerical failure |
| `500` | Invalid backend result or unexpected failure |
| `503` | Handler has been permanently closed |

Unexpected error messages and stacks are not exposed. Still treat validation
details as potentially sensitive operational metadata and do not reflect raw
input in custom errors.

The adapter does not provide authentication, authorization, tenancy, quotas,
CSRF/CORS policy, rate limiting, audit logs, encryption, persistence, or schema
migration. Add those at the application boundary.

## Observability without leaking response data

Create an application request/job ID outside `FitInput`. Log structured fields
at admission and completion:

- application job ID, authenticated tenant/user pseudonym, and package version;
- `N`, `J`, `K`, latent classes, per-item model counts, missing count, starts,
  posterior mode, and estimated bytes;
- queue wait, fit duration, selected start, iterations, convergence reason,
  final change, and final log likelihood;
- backend ID, worker-pool size, runtime/provider identity, abort/error code, and
  measured process/container memory when available.

Do not log the response matrix, individual posterior vectors, classifications,
or small-cell row patterns by default. Metrics labels must have bounded
cardinality; keep request IDs in traces/logs rather than metric dimensions.

Alert separately on:

- invalid/resource-rejected requests;
- non-convergence and numerical failure;
- cancellation/deadline rate;
- queue wait and p95/p99 fit duration;
- estimated-versus-observed memory drift; and
- worker replacement or unexpected process exit.

Convergence is a statistical status, not merely an operational success. A
`200` response may contain `convergence.converged === false` when maximum
iterations were reached.

## Browser/static deployment controls

Import only `@jgdina/next/client` from a client component. Each fit creates a
module Worker and keeps estimation off React's main thread. Verify that the
deployment emits and serves the worker asset with the correct module MIME type.

For a Content Security Policy, permit the actual Worker source with
`worker-src`; a custom `workerFactory` can support an application-specific
asset URL. Avoid broad CSP exceptions merely to make the default URL work.

Browser mode moves compute and raw responses off the server, but it is not an
automatic privacy guarantee. The application can still transmit inputs through
analytics, error reporting, persistence, or custom code. Document whether
results stay local and test on the lowest-memory supported devices.

## Provider and packaging checklist

Before deployment, verify in the actual provider environment:

- Node.js 20 or newer and Next.js 15 or 16;
- Node runtime, not Edge;
- `@jgdina/node` remains external and `worker-entry.js` is present in the
  deployed artifact;
- worker threads are permitted by the host;
- function/container memory exceeds the application admission budget with
  framework headroom;
- configured duration exceeds measured p99 or the request has been replaced by
  a durable job;
- instance concurrency and horizontal scaling cannot multiply pools beyond the
  CPU/memory budget;
- request and response limits accommodate the selected contract;
- cancellation is observed after client disconnect and application deadlines;
- CSP serves the browser worker when client fitting is enabled; and
- GPL-3.0-only source and notice obligations are satisfied for server and
  distributed browser bundles.

Run a production build and one real worker fit after packaging. A successful
TypeScript build alone does not prove the adjacent worker file will be present
or executable in the deployed artifact.

## Release and rollback discipline

Pin all jGDINA packages to the same release version. Persist
`FitResult.schemaVersion`, the package version, normalized options, and a hash
or version of the Q-matrix with every durable result. Do not persist only the
classification array.

Canary a new package version on frozen acceptance datasets and compare
parameters, likelihood, convergence, memory, and duration before increasing
traffic. Rollback should restore both code and the normalized default options;
changing probability bounds, starts, or posterior mode can alter results even
when the package version is unchanged.

## Related guides

- [API and result-field reference](./api-reference.md)
- [Statistical responsibility and diagnostics gap](./statistical-responsibility.md)
- [R migration and parity checklist](./migration-from-r.md)
- [Runnable Next.js example](../examples/next-app/README.md)
