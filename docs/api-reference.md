# jGDINA v1 API reference

This document describes the public, JSON-oriented v1 contract. It is a guide
to the current implementation, not a claim of parity with every R `GDINA`
feature. The accepted statistical scope is listed in the
[project README](../README.md#v1-scope), and the numerical conventions are
documented in [the validation guide](../validation/README.md).

## Choose an entry point

| Environment | Import | Execution |
|---|---|---|
| Script or controlled Node process | `jgdina` | Pure TypeScript kernel on the calling thread |
| Browser or React client | `@jgdina/browser` | One dedicated module Worker per fit |
| Node service | `@jgdina/node` | Reusable `worker_threads` pool |
| Next.js Route Handler | `@jgdina/next` | Lazy reusable Node worker pool |
| Next.js client component | `@jgdina/next/client` | Browser Worker |
| Custom backend | `@jgdina/core` | Environment-neutral validation and orchestration |

The direct `jgdina` API returns a Promise for consistency, but fitting still
occupies its caller. Use a worker adapter for an interactive UI or a server
request path.

## Primary fitting API

Every high-level engine implements:

```ts
interface JGDINA {
  readonly backendId: string;
  validate(input: FitInput): ValidatedFitInput;
  fit(input: FitInput, options?: FitOptions): Promise<FitResult>;
}
```

The default facade also exports a shared convenience function:

```ts
import { fit } from "jgdina";

const result = await fit(input, {
  signal: controller.signal,
  onProgress(progress) {
    console.log(progress.phase, progress.fraction);
  },
});
```

`validate()` normalizes and defensively copies the request, resolves defaults,
and runs dimension and memory guards. Application code normally calls `fit()`
directly because it performs the same validation automatically.

## `FitInput`

```ts
interface FitInput {
  responses: readonly (readonly (number | null)[])[];
  qMatrix: readonly (readonly number[])[];
  model?: "GDINA" | "DINA" | "DINO" |
    readonly ("GDINA" | "DINA" | "DINO")[];
  prior?:
    | { type: "saturated"; initialProbabilities?: readonly number[] }
    | { type: "fixed"; probabilities: readonly number[] };
  estimation?: EstimationOptions;
}
```

### Data and Q-matrix rules

- `responses` is `N x J`. Values must be `0`, `1`, `null`, or, for a local
  JavaScript call, `NaN`. JSON requests must use `null` for missing values.
- Every item must contain at least one observed `0` and one observed `1`.
- `qMatrix` is `J x K`, rectangular, and binary. Every item must require at
  least one attribute, and every attribute must be required by at least one
  item.
- `model` defaults to `"GDINA"`. A scalar applies to all items; an array must
  contain exactly `J` entries. Model names are uppercase and case-sensitive.
- v1 does not accept case weights. Expand weighted rows before fitting and
  retain the external row-to-case mapping if individual results are needed.

All public indices are zero-based. Item `j` is `result.estimates.items[j]`;
class index `c` refers to `result.attributePatterns[c]` everywhere.

### Latent-class prior

If `prior` is omitted, jGDINA estimates a saturated class distribution from a
uniform initial distribution.

```ts
// Estimated saturated prior with a supplied starting distribution.
prior: {
  type: "saturated",
  initialProbabilities: [0.1, 0.2, 0.3, 0.4],
}

// Distribution remains fixed during EM.
prior: {
  type: "fixed",
  probabilities: [0.1, 0.2, 0.3, 0.4],
}
```

Prior vectors have length `2^K`, contain finite values in `[0, 1]`, and sum to
one within `1e-8`. Fixed priors may contain explicit zero-probability classes.

## `EstimationOptions`

| Field | Default | Meaning |
|---|---:|---|
| `maxIterations` | `2000` | Maximum EM iterations |
| `convergenceTolerance` | `1e-4` | Maximum accepted parameter change |
| `probabilityBounds` | `[1e-4, 0.9999]` | Strict-interior item-probability bounds |
| `smallSampleCorrection` | `[0.0005, 0.001]` | Numerator and denominator correction in the closed-form M-step |
| `aggregateRows` | `true` | Combine identical response rows during fitting, then restore input order |
| `posteriorStorage` | `"full"` | Store `N x 2^K` posteriors or retain scores only |
| `blockSize` | `256` | Respondent interval for cooperative abort checks; not an allocation block |
| `initialization.starts` | `3` | Number of deterministic candidates |
| `initialization.seed` | `123456` | Unsigned 32-bit seed |
| `initialization.strategy` | `"deterministic"` | The only v1 initialization strategy |

Production services should normally set `posteriorStorage: "scores-only"`
unless individual class posterior vectors are an explicit output requirement.
All MAP, MLE, and EAP fields remain available in score-only mode; only
`scores.posteriorProbabilities` becomes `null`.

Convergence is the largest absolute change across item-group probabilities and,
for a saturated prior, class probabilities. jGDINA v1 does not expose R's
alternative `conv.type` rules.

### Deterministic starts

```ts
estimation: {
  initialization: {
    starts: 3,
    seed: 123456,
    initialItemProbabilities: [
      [0.1, 0.9],
      [0.2, 0.8],
    ],
  },
}
```

`initialItemProbabilities` supplies start 0. To supply every candidate, use
`initialItemProbabilityCandidates`, an ordered array of candidate matrices.
Explicit candidates take precedence over the start-0 shorthand. If `starts`
exceeds the number supplied, deterministic seeded candidates fill the
remainder.

Each candidate contains one probability vector per item:

- GDINA requires `2^Kj` local probabilities.
- DINA and DINO accept either their two compact probabilities or a full
  `2^Kj` vector with the required groups tied.
- Values must lie inside the configured `probabilityBounds`.

Every candidate is scored under the initial prior. EM runs only from the
candidate with the highest initial observed-data likelihood; a tie selects the
lowest candidate index. The JavaScript PRNG is reproducible across JavaScript
runtimes, but it does not reproduce R's random-number stream. Supply candidates
explicitly for an R-to-jGDINA start-by-start comparison.

### Resource limits

The default pre-allocation limits are:

| Limit | Default |
|---|---:|
| `maxRespondents` | `100000` |
| `maxItems` | `10000` |
| `maxAttributes` | `20` |
| `maxLatentClasses` | `1048576` |
| `maxEstimatedBytes` | `512 MiB` |
| `maxStarts` | `32` |
| `maxIterations` | `100000` |

Override them per request under `estimation.resourceLimits`. Raising a limit
does not make a workload safe; it only changes the admission rule. Estimate
the target workload and benchmark it in the deployment runtime first.

```ts
import { estimateFitMemory, formatBytes } from "jgdina";

const memory = estimateFitMemory({
  respondents: 3_000,
  items: 30,
  attributes: 10,
  posteriorStorage: "scores-only",
});

console.log(formatBytes(memory.estimatedBytes), memory.breakdown);
```

The dimension-only estimate assumes every item requires all `K` attributes.
Pass `reducedClassCounts`, where entry `j` is `2^Kj`, for a sharper estimate.
The estimate includes worker transport by default and reserves a 2x
runtime/allocator envelope. It is a conservative admission aid, not a measured
peak-RSS guarantee.

## `FitOptions`

```ts
interface FitOptions {
  signal?: { readonly aborted: boolean; readonly reason?: unknown };
  onProgress?: (progress: FitProgress) => void;
}
```

Normal browser and Node `AbortSignal` objects satisfy the structural signal
contract. Browser and Node adapters terminate an active worker on cancellation;
the direct backend can check only between cooperative checkpoints.

Progress phases are `validation`, `initialization`, `estimation`, `scoring`,
and `complete`. `FitProgress` contains `phase` and overall `fraction`; optional
fields are `startIndex`, `totalStarts`, `iteration`, `maxIterations`, and
`logLikelihood`. Treat event frequency and intermediate likelihoods as
telemetry, not as a stable persistence schema. If `onProgress` throws, worker
adapters reject that fit.

## `FitResult`

Every backend returns a JSON-safe object with `schemaVersion: "1.0"`. It
contains no typed arrays, `NaN`, or infinite numbers.

### Identity and dimensions

| Field | Meaning |
|---|---|
| `schemaVersion` | Result-contract version, currently `"1.0"` |
| `backendId` | `"js"`, `"browser-worker:js"`, or `"node-worker:js"` for bundled backends |
| `dimensions` | `respondents`, `items`, `attributes`, and `latentClasses` |
| `models` | Resolved per-item model array |
| `priorType` | `"saturated"` or `"fixed"` |
| `attributePatterns` | Canonical binary profiles used by every class-indexed field |

For `K = 3`, canonical class order is `000, 100, 010, 001, 110, 101, 011,
111`: increasing mastery count, then lexicographic attribute subsets.

### `estimates`

`estimates.classProbabilities` has length `2^K` in `attributePatterns` order.
For a fixed prior it equals the requested distribution; for a saturated prior
it is the final EM estimate.

Each `estimates.items[j]` contains:

| Field | Meaning |
|---|---|
| `itemIndex` | Zero-based item index |
| `model` | Resolved item model |
| `requiredAttributes` | Zero-based Q-matrix attribute indices |
| `successProbabilities` | Length `2^K`; `P(X_j=1 | alpha_c)` for each global class |
| `groupSuccessProbabilities` | Length `2^Kj`; local probabilities in canonical order |
| `deltaParameters` | Identity-link coefficients in documented design-column order |

DINA and DINO repeat tied probabilities across
`groupSuccessProbabilities`, which keeps the local vector directly comparable
with GDINA's reduced latent-group representation. Their `deltaParameters` are
intercept and mastery contrast. GDINA columns are intercept, main effects, then
increasing-order interactions.

### `statistics`

| Field | Definition |
|---|---|
| `logLikelihood` | Final observed marginal log likelihood |
| `deviance` | `-2 * logLikelihood` |
| `estimatedParameterCount` | Item design columns plus `2^K - 1` for a saturated prior |
| `aic` | `deviance + 2q` |
| `aicc` | `aic + 2q(q+1)/(N-q-1)`, or `null` when `N <= q+1` |
| `bic` | `deviance + q log(N)` |
| `caic` | `deviance + q(log(N)+1)` |
| `sabic` | `deviance + q log((N+2)/24)` |

jGDINA's AICc deliberately differs from the expression in the frozen GDINA
2.12.3 source. See [UPSTREAM.md](../UPSTREAM.md#intentional-result-contract-differences).

### `convergence`

| Field | Meaning |
|---|---|
| `converged` | Whether the selected start met the tolerance |
| `reason` | `"tolerance"` or `"maximum-iterations"` |
| `iterations` | EM iterations executed for the selected start |
| `finalChange` | Final maximum absolute parameter change |
| `selectedStartIndex` | Zero-based winning start |
| `starts` | Initial likelihood and selection/final status for every candidate |

Non-selected starts have `reason: "not-selected"`, zero iterations, and their
initial likelihood in `logLikelihood`. Never treat a fulfilled Promise as
proof of convergence; check `convergence.converged` before interpreting the
fit.

### `scores`

All score arrays follow the original respondent order, even when repeated rows
were aggregated for estimation.

| Field | Shape and meaning |
|---|---|
| `posteriorProbabilities` | `N x 2^K`, or `null` in score-only mode |
| `mapClassIndices` | Length `N`; class index maximizing posterior probability |
| `mapHasTies` | Length `N`; whether MAP has multiple maxima |
| `mleClassIndices` | Length `N`; class index maximizing response likelihood without the prior |
| `mleHasTies` | Length `N`; whether MLE has multiple maxima |
| `eapAttributeProbabilities` | `N x K` marginal posterior mastery probabilities |
| `eapAttributeClassifications` | `N x K`; `1` only when mastery probability is greater than `0.5` |

Convert a class index to a profile with
`result.attributePatterns[result.scores.mapClassIndices[i]]`. Ties select the
lowest class index and remain visible in the corresponding tie array.

### `diagnostics`

`diagnostics` currently reports operational facts, not statistical model-fit
tests:

- `missingResponseCount`;
- `uniqueResponsePatterns`;
- `rowsAggregated`; and
- the complete `memoryEstimate` and component breakdown.

The distinction matters: successful EM and an operational diagnostic object do
not establish item fit, global model fit, Q-matrix validity, identifiability,
or classification quality. See [Statistical responsibility](./statistical-responsibility.md).

## Errors

High-level APIs reject with a `JGDINAError` subclass where possible:

| Code | Class / meaning |
|---|---|
| `INVALID_INPUT` | `InputValidationError`; inspect `issues[]` for paths and messages |
| `RESOURCE_LIMIT_EXCEEDED` | `ResourceLimitError`; inspect `limit`, `actual`, and `maximum` |
| `ABORTED` | Cooperative direct-engine cancellation |
| `INVALID_BACKEND_RESULT` | A custom backend violated dimensions, identity, or JSON safety |
| `NUMERICAL_FAILURE` | Numerical fitting could not produce a valid result |

Worker cancellation can instead reject a normal error named `AbortError`.
Code that crosses adapters should recognize both the typed `ABORTED` code and
`error.name === "AbortError"`.

The Next.js adapter translates these failures into a documented HTTP envelope;
see the [Next.js production guide](./nextjs-production.md#http-contract-and-boundaries).

## Lower-level packages

`@jgdina/core` exports the contracts, validators, resource estimators, error
classes, and `createJGDINA(backend)`. `@jgdina/kernels-js` exports the reference
backend plus numerical helpers for canonical patterns, design matrices,
parameter locations, probability/delta conversion, and fixed-parameter
evaluation. `@jgdina/worker-protocol` is shared implementation infrastructure;
applications should not persist or depend on its wire messages.

Backend authors should return the exact validated dimensions, use their
declared backend ID, and keep the result JSON-safe. `createJGDINA()` checks
those invariants, but it does not independently recompute the backend's
statistics.

## Related guides

- [R `GDINA` to TypeScript migration](./migration-from-r.md)
- [Next.js production and deployment](./nextjs-production.md)
- [Statistical responsibility and diagnostics gap](./statistical-responsibility.md)
- [Evidence-based v1.1 roadmap](./roadmap-v1.1.md)
- [Numerical oracle and tolerances](../validation/README.md)
