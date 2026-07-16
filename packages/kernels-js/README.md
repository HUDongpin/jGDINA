# `@jgdina/kernels-js`

Pure TypeScript numerical backend for the binary, single-group jGDINA v1
estimator. It supports per-item GDINA, DINA, and DINO models; estimated
saturated or fixed latent-class priors; missing responses; deterministic
multiple starts; and full or scores-only posterior output.

## Numerical conventions

- Attribute profiles use GDINA's `alpha2` order: the zero profile followed by
  profiles in increasing mastery count and lexicographic subset order.
- GDINA design columns use the same subset order: intercept, main effects, then
  increasing-order interactions. DINA and DINO use intercept plus their ideal
  response indicator.
- The E-step uses row-wise log-sum-exp. Missing responses contribute zero to
  the conditional log-likelihood.
- The closed-form M-step applies `smallSampleCorrection` to each free success
  probability and then applies strict-interior `probabilityBounds`. Exact 0/1
  item bounds are rejected during validation so all log likelihoods stay finite.
  DINA pools all non-master groups; DINO pools all nonzero groups.
- Estimated saturated class probabilities are floored at `Number.MIN_VALUE`
  after each M-step and renormalized. Fixed priors, including explicit zeros,
  are never changed.
- Convergence is the maximum absolute change across item success probabilities
  and, for a saturated prior, class probabilities.
- Multiple starts follow GDINA's fast workflow: evaluate every candidate under
  the initial prior, select the largest initial observed likelihood (lowest
  index on ties), and run EM only from that candidate. Callers may provide all
  candidates through `initialItemProbabilityCandidates`; the legacy
  `initialItemProbabilities` continues to define only start 0.

## Reproducibility

Random candidates use xoshiro128** with SplitMix32 state expansion. Every
operation is explicit unsigned 32-bit arithmetic, so the same unsigned seed,
start index, input, and package version produce identical candidates in Node
and browsers. This is deterministic across JavaScript runtimes but is not
intended to reproduce R's random-number stream.

The public backend is available as `jsBackend` or via `createJsBackend()`.
`fitValidated()` is the direct entry point for worker adapters, while
`evaluateValidated()` evaluates supplied parameters without fitting for golden
likelihood and posterior fixtures.

Numerical parity and convergence are not evidence of substantive model fit.
The complete local jGDINA workspace contains the validation and statistical
responsibility evidence. This archive includes the preferred TypeScript source
and exact package-local rebuild procedure in [SOURCE.md](./SOURCE.md),
compatibility provenance in [UPSTREAM.md](./UPSTREAM.md), and the
[GPL-3.0-only license](./LICENSE) with [NOTICE](./NOTICE).
