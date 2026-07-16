# jGDINA v1 architecture

## Design goals

jGDINA is a standalone numerical package. Its computational packages do not
depend on React, Next.js, R, or a running server. The same request and result
contracts are used in direct Node.js execution, a browser Web Worker, and a
Node worker thread.

```text
@jgdina/core
  public types, validation, limits, errors, backend contract

@jgdina/kernels-js
  Float64Array/Int32Array reference kernels and closed-form EM

jgdina
  default standalone facade and JSON conversion helpers

@jgdina/browser
  browser Worker RPC, transferable buffers, progress, cancellation

@jgdina/node
  worker_threads execution and reusable worker pool

@jgdina/next
  small Route Handler and client integration helpers
```

An optional `@jgdina/kernels-wasm` backend can implement the core backend
contract later. It is not part of v1: profiling, not assumption, decides which
kernels are worth moving to WebAssembly.

## Numerical representation

Hot numerical buffers use flat typed arrays:

- response data: `Float64Array`, with `NaN` representing missing responses;
- Q-matrix and model/group indices: integer typed arrays;
- parameters, priors, likelihoods, and posteriors: `Float64Array`.

Canonical attribute patterns and the public JSON result remain nested JavaScript
arrays. The memory preflight accounts for those object/slot costs and for the
temporary nested location maps used during compilation.

Public requests accept normal JavaScript matrices and return JSON-friendly
objects. Runtime adapters flatten large matrices before crossing a worker
boundary and transfer their `ArrayBuffer`s rather than cloning them.

## Execution model

The direct engine is synchronous and supports a cooperative abort predicate.
The browser and Node APIs are asynchronous:

- progress is emitted after initialization and EM iterations;
- cancellation terminates the active worker, guaranteeing prompt cancellation
  even while a CPU-bound iteration is running; and
- a cancelled pooled Node worker is replaced before another job is accepted.

Browser fitting must not run on React's main thread. Server fitting must not
run on Node's request/event-loop thread.

## Complexity and limits

With `K` attributes, the engine enumerates `L = 2^K` latent classes. The
dominant E-step cost is approximately `O(N * J * 2^K)`. Memory guards estimate
the request's peak working set before allocation. The default browser and Node
limits are deliberately conservative and can be lowered by an application,
but exceeding a hard safe-integer or addressability limit is always rejected.

The preflight follows the current implementation rather than treating the
posterior as the only large allocation. It models normalized and worker-side
input copies, aggregation keys, canonical JavaScript pattern arrays, compiled
locations, the selected initialization state and candidate summaries, E-step buffers, score/result
arrays, and the UTF-8 JSON worker-result envelope. Before Q is available, every
item is conservatively assumed to require all attributes; validated fits use
the exact `2^Kj` counts. Unknown unique-row count is taken as `U = N`.
JavaScript object sizes vary, so the modeled envelope receives a default 2x
runtime/allocator reserve. `blockSize` currently controls abort polling cadence
and does not create a `blockSize x 2^K` allocation.

Repeated response patterns are aggregated before fitting. Posterior results are
expanded back to the original respondent order.

## Stability rules

- Posterior normalization uses log-sum-exp.
- Item probabilities are clamped to configured strict-interior bounds.
- Estimated saturated priors are floored at `Number.MIN_VALUE` and renormalized;
  fixed priors retain explicit zero classes unchanged.
- Missing responses add zero to the conditional log-likelihood.
- Initialization is controlled by a documented deterministic PRNG and seed.
- Candidate starts are compared using their initial observed-data likelihood;
  the best candidate is then run through EM, matching upstream GDINA behavior.
  Explicit candidate arrays take precedence over the legacy start-0 shorthand.
- Attribute profiles follow GDINA ordering: zero profile, singletons,
  increasing-order combinations, then the all-ones profile.

## Versioning and licensing

The compatibility oracle is frozen in [`UPSTREAM.md`](../UPSTREAM.md). A close
port of GPL-3 GDINA is distributed under `GPL-3.0-only`; browser bundles and
npm distributions must retain copyright, license, and corresponding-source
notices.

## Related guides

- [Public API and result contract](./api-reference.md)
- [Next.js production boundaries](./nextjs-production.md)
- [Statistical responsibility and diagnostics gap](./statistical-responsibility.md)
- [Numerical oracle](../validation/README.md)
