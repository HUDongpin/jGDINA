# jGDINA

jGDINA is a standalone TypeScript implementation of the closed-form,
single-group binary subset of the GDINA framework. It runs without R in
Node.js, browser Web Workers, and Next.js applications.

The numerical compatibility target is GDINA 2.12.3 at commit
[`ac5eca223a1ee32b6c2f595cfeaef9b330451425`](https://github.com/Wenchao-Ma/GDINA/commit/ac5eca223a1ee32b6c2f595cfeaef9b330451425).
See [UPSTREAM.md](./UPSTREAM.md) for the frozen scope and provenance.

## Documentation

| Guide | Use it for |
|---|---|
| [API and result-field reference](./docs/api-reference.md) | Inputs, defaults, starts, limits, result semantics, and errors |
| [R `GDINA` migration](./docs/migration-from-r.md) | Argument/result mapping, ordering differences, and parity acceptance |
| [Next.js production deployment](./docs/nextjs-production.md) | Worker packaging, score-only policy, limits, timeouts, queues, and observability |
| [Statistical responsibility](./docs/statistical-responsibility.md) | What convergence proves, missing diagnostics, and reporting requirements |
| [v1.1 roadmap](./docs/roadmap-v1.1.md) | Evidence gates that prioritize fit and diagnostics before model expansion |
| [Architecture](./docs/architecture.md) | Package boundaries, typed arrays, execution, stability, and memory design |
| [Numerical validation](./validation/README.md) | Independent oracle, fixtures, equations, tolerances, and benchmark cases |
| [Real-data acceptance report](./validation/real-data/report/report.html) | RC decision, ECPE/Tatsuoka evidence, exact differences, and remaining validation gaps |
| [Private user-data acceptance](./validation/user-data/README.md) | Local de-identified case preflight, frozen R parity, privacy rules, and aggregate reports |

## v1 scope

jGDINA v1 supports:

- binary item responses and binary attributes;
- one respondent group;
- GDINA, DINA, and DINO, including a different supported model per item;
- estimated saturated or fixed latent-class proportions;
- `null` or `NaN` missing responses;
- supplied starting parameters or seeded deterministic multiple starts;
- stable, row-aggregated EM with a row-wise streaming E-step;
- full posterior probabilities or memory-saving score-only mode;
- item/group/class probabilities and delta parameters;
- log likelihood, deviance, AIC, AICc, BIC, CAIC, and sample-adjusted BIC;
- MAP, MLE, and EAP classifications, including tie flags; and
- pre-allocation resource and memory guards.

It intentionally does not claim support for multiple groups, sequential or
polytomous models, constrained optimization, higher-order distributions,
standard errors, DIF, Q-matrix validation, bootstrap procedures, or the
experimental GDINA estimators. Those features require separate numerical and
validation phases.

AICc uses the conventional `AIC + 2q(q+1)/(N-q-1)` definition and is `null`
when `N <= q + 1`. This intentionally corrects the different AICc expression
in the frozen GDINA 2.12.3 source; AIC and BIC remain oracle-parity fields.

## Install from npm

The public release candidate is
[`1.0.0-rc.1`](https://www.npmjs.com/package/jgdina/v/1.0.0-rc.1). All seven
packages are published to npm's `next` dist-tag; `latest` is intentionally
unchanged. Install `@next` (or pin the exact RC version) until a stable release
is announced.

Choose the runtime entry point for your application—its internal jGDINA
dependencies are installed automatically:

```sh
# Direct, in-process TypeScript engine
npm install jgdina@next

# Node.js worker_threads adapter
npm install @jgdina/node@next

# Browser Web Worker adapter
npm install @jgdina/browser@next

# Next.js App Router server and client adapters
npm install @jgdina/next@next
```

## Packages

| Package | Purpose | Install when |
|---|---|---|
| [`jgdina`](https://www.npmjs.com/package/jgdina) | Standalone default TypeScript engine | fitting directly on the calling thread |
| [`@jgdina/core`](https://www.npmjs.com/package/@jgdina/core) | Public contracts, validation, backend interface, memory guards | implementing a custom backend or advanced integration |
| [`@jgdina/kernels-js`](https://www.npmjs.com/package/@jgdina/kernels-js) | Typed-array reference kernels and closed-form EM | using the low-level pure-JS backend directly |
| [`@jgdina/browser`](https://www.npmjs.com/package/@jgdina/browser) | Dedicated browser Worker adapter | fitting in a browser or static client application |
| [`@jgdina/node`](https://www.npmjs.com/package/@jgdina/node) | Node `worker_threads` backend and reusable pool | fitting from a Node.js server or process |
| [`@jgdina/next`](https://www.npmjs.com/package/@jgdina/next) | Next.js Route Handler and client entry points | integrating with a Next.js App Router application |
| [`@jgdina/worker-protocol`](https://www.npmjs.com/package/@jgdina/worker-protocol) | Shared typed-array worker wire protocol | implementing a compatible custom worker transport |

## Standalone usage

```ts
import { fit } from "jgdina";

const result = await fit({
  responses: [
    [1, 0, 1],
    [0, 1, 1],
    [0, 0, null],
    [1, 1, 0],
  ],
  qMatrix: [
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  model: ["DINA", "DINO", "GDINA"],
  estimation: {
    initialization: { starts: 3, seed: 123_456 },
    posteriorStorage: "full",
  },
});

console.log(result.estimates.items);
console.log(result.estimates.classProbabilities);
console.log(result.statistics);
console.log(result.scores.eapAttributeClassifications);
```

The direct engine returns a Promise for API consistency, but its numerical work
runs on the calling thread. Use a runtime adapter in UI or request-serving code.

## Browser Worker

```ts
import { createBrowserJGDINA } from "@jgdina/browser";

const engine = createBrowserJGDINA();
const controller = new AbortController();

const result = await engine.fit(input, {
  signal: controller.signal,
  onProgress(progress) {
    console.log(progress.phase, progress.fraction);
  },
});
```

Each fit uses a dedicated module Worker. Response and Q matrices are flattened
into transferable buffers. Results are transferred as one UTF-8 JSON buffer.
Aborting terminates the active Worker, so cancellation remains prompt during a
CPU-bound iteration. A bundler must preserve the emitted `worker-entry.js`
asset; a custom `workerFactory` can be supplied for restrictive CSP or asset
layouts.

## Node workers

```ts
import { createNodeJGDINA } from "@jgdina/node";

const engine = createNodeJGDINA({ size: 2 });
try {
  const result = await engine.fit(input, { signal: controller.signal });
} finally {
  await engine.close();
}
```

Pool size defaults to one because each `2^K` fit may use substantial memory.
The pool queues jobs, admits active fits only while their combined estimates
remain within `maxConcurrentEstimatedBytes` (512 MiB by default), replaces
aborted or failed workers, and keeps CPU-heavy estimation off Node's event loop.

## Next.js App Router

Server Route Handler:

```ts
// app/api/jgdina/route.ts
import { createJGDINARouteHandler } from "@jgdina/next";

export const runtime = "nodejs";
export const maxDuration = 300; // deployment-provider limit, not a jGDINA setting

const handler = createJGDINARouteHandler({
  maxBodyBytes: 2 * 1024 * 1024,
  node: { size: 1 },
});

export const POST = handler.POST;
```

Client/static-export execution:

```tsx
"use client";

import { createJGDINAClient } from "@jgdina/next/client";

const engine = createJGDINAClient();
const result = await engine.fit(input);
```

The client path is compatible with a static Next.js export because fitting is
performed locally. The server path requires the Node runtime; Edge is not a v1
target. For managed functions, configure provider duration/memory limits or use
a durable job queue when fits can outlive a request.

## Priors and supplied starts

```ts
const input = {
  responses,
  qMatrix,
  prior: {
    type: "fixed",
    probabilities: [0.1, 0.2, 0.3, 0.4],
  },
  estimation: {
    initialization: {
      starts: 1,
      initialItemProbabilities: [
        [0.1, 0.9],       // one-attribute GDINA
        [0.2, 0.8],       // DINA: nonmaster, all-master
        [0.1, 0.2, 0.3, 0.8], // two-attribute GDINA local groups
      ],
    },
  },
};
```

With multiple starts, jGDINA evaluates each initial candidate under the initial
prior, selects the highest initial observed-data likelihood, and runs EM from
that candidate. Ties select the lowest start index, matching GDINA's fast path.
Use `initialItemProbabilityCandidates` to supply every candidate explicitly;
`initialItemProbabilities` remains the backward-compatible start-0 shorthand.
Configured probability bounds must remain strictly inside `(0, 1)` so every
item log likelihood is well-defined.

## Complexity and memory

For `K` attributes there are `2^K` latent classes. The dominant work is roughly
`O(N * J * 2^K)`. The validator estimates the working set before numerical
allocation and rejects unsafe requests by default.

```ts
import { estimateFitMemory } from "jgdina";

const estimate = estimateFitMemory({
  respondents: 3_000,
  items: 30,
  attributes: 15,
  posteriorStorage: "full",
});
```

Dimension-only estimates conservatively assume every item requires all
attributes. Callers that already have Q-derived counts can pass
`reducedClassCounts`, plus `starts` and `suppliedCandidateCount`, for a sharper
estimate. Worker packing/unpacking and result JSON serialization are included by
default; set `workerTransport: false` only when planning a direct in-process
kernel call. `blockSize` does not change the current engine's allocation.

One dense `3,000 x 32,768` Float64 posterior alone is 786,432,000 bytes, and its
JSON worker transfer needs substantially more temporary memory. Use
`posteriorStorage: "scores-only"`, lower application limits, and representative
benchmarks rather than silently raising memory caps. The diagnostic breakdown
separates validated/worker input, aggregation, compilation, starts, E-step,
scores, posterior, and serialization costs.

## Verification

```sh
npm ci
npm run verify
npm run accept:real-data
npm run test:user-data
npm run benchmark -- --case smoke
Rscript validation/compare-fast-kernel.R
npm run release:bundle -- 1.0.0-rc.1
```

`release:bundle` retains all seven candidate tarballs plus a deterministic
manifest, fixed-tarball Next production evidence, and `SHA256SUMS` under
`.release/<version>/`. It verifies packed preferred source and byte-identical
source rebuilds, installs all seven tarballs with an empty npm cache in forced
offline mode, and runs ESM, CommonJS, direct-fit, Node-worker, and tree-shaking
smokes. A second temporary lock installs the fixed app tarballs plus committed
Next dependencies from a prewarmed cache in forced-offline mode for the Next 16
browser E2E. A formal bundle requires a clean local commit and
records its Git/tree, lockfile hashes, toolchain, and unused tag target. It does
not use GitHub, create a tag, or publish to npm; see the
[release-candidate runbook](./scripts/release/README.md).

The independent base-R oracle generates nine versioned fixtures. The optional
compiled comparison matches the upstream fast C++ kernel's iteration counts and
final item/prior probabilities to approximately `4.6e-15`. Details and explicit
tolerances are in [validation/README.md](./validation/README.md). The real-data
gate covers ECPE GDINA/DINO, Tatsuoka DINA, and deterministic ECPE missingness;
the generated [acceptance report](./validation/real-data/report/report.html)
records the exact case-level evidence and optional full-package wrapper audit.
For a new instrument, the local
[private user-data workflow](./validation/user-data/README.md) accepts only a
de-identified case stored outside this workspace, forces score-only processing,
and writes aggregate technical-parity evidence. It does not use GitHub or send
the case over a network, and it does not replace full-package diagnostics or
psychometric review.

## Statistical responsibility

Successful numerical convergence does not establish model fit, Q-matrix
validity, identifiability, or appropriate interpretation. jGDINA v1 does not yet
implement the diagnostics available in the full R package. Review convergence,
sample size, design, and substantive assumptions with a qualified
psychometrician. The required review, result-reporting checklist, and current
diagnostics gap are documented in
[Statistical responsibility](./docs/statistical-responsibility.md).

## Maintainer

- [HUDongpin](https://github.com/HUDongpin)

## License

jGDINA is distributed under the GNU General Public License version 3 only.
See [LICENSE](./LICENSE) and [NOTICE](./NOTICE). A direct browser bundle is a
distributed copy of the software and must retain the applicable source and
license obligations.
