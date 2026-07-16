# jGDINA v1 numerical oracle

This directory defines the independent numerical oracle for the standalone
jGDINA v1 engine. It covers the accepted v1 boundary: binary responses,
binary attributes, one group, GDINA/DINA/DINO items, fixed or saturated class
priors, missing responses, row-frequency aggregation, supplied starts, and
deterministic multi-start selection.

The generator does **not** load the GDINA R package. All likelihood, posterior,
expected-count, closed-form M-step, scoring, and fit-statistic calculations are
implemented in base R. `jsonlite` is used only to serialize JSON. This keeps the
mandatory oracle independent of both the TypeScript implementation and the
full GDINA package dependency graph.

## Commands

From the repository root:

```sh
Rscript validation/generate-fixtures.R
Rscript validation/validate-fixtures.R
```

The first command rewrites `fixtures/v1/*.json`. The second regenerates into a
temporary directory, demands byte-for-byte equality with the committed files,
and checks normalization, bounds, convergence, likelihood history, AIC/BIC,
missing-data policy, aggregation equivalence, multi-start selection, and
benchmark arithmetic.

An optional parity check compiles only the downloaded package's fast kernel:

```sh
Rscript validation/compare-fast-kernel.R
```

It requires Rcpp, RcppArmadillo, and a working C++/Fortran toolchain. It does
not install or load GDINA.

## Real-data acceptance

The release gate also compares ECPE and Tatsuoka (1990), the two genuine real
datasets in the frozen source tree, plus a deterministic ECPE missing-value
case:

```sh
npm run accept:real-data
```

This command compiles the frozen exact fast kernel, regenerates deterministic R
evidence, rebuilds jGDINA, and fails on any numerical or classification gate.
Its [workflow notes](./real-data/README.md),
[machine-readable evidence](./real-data/evidence/comparison.json), and
[portable technical report](./real-data/report/report.html) are committed for
review. A separate optional audit drives the same inputs through the full
installed `GDINA()`, `extract()`, and `personparm()` interfaces; it is not a CI
dependency.

## Provenance

The audited source archive identifies itself as GDINA 2.12.3 dated 2026-07-10
in `GDINA-master/DESCRIPTION`. The archive has no `.git` metadata, so the oracle
does not claim a locally verifiable Git commit. Instead,
`fixtures/v1/manifest.json` records MD5 fingerprints for the exact relevant
source and validation files:

- `GDINA-master/src/util.cpp`: attribute ordering, design matrices, and eta.
- `GDINA-master/src/Lik.cpp`: likelihood, posterior, missingness, weights, and
  expected counts.
- `GDINA-master/src/Lik2.cpp`: the fast GDINA/DINA/DINO EM updates.
- `GDINA-master/R/Mstep.R`: ordinary closed-form model restrictions and bounds.
- `GDINA-master/R/SingleGroup_Estimation.R`: aggregation, priors, convergence,
  and result construction.

The two fixed-parameter cases intentionally reuse the small Q-matrix, response
patterns, item probabilities, and prior from the package's likelihood tests;
the expected values are recomputed independently. All EM data are generated
without randomness by assigning integer counts to the complete response-pattern
distribution with a largest-remainder rule.

As an additional validation, the independent implementation was compared with
the compiled `fast_GDINA_EM` function from `src/Lik2.cpp` after expanding
frequency-weighted rows. With convergence tolerance `1e-10`, both paths stopped
at exactly the same iteration:

| Model | Iterations | Maximum item-probability difference | Maximum prior difference |
|---|---:|---:|---:|
| GDINA | 287 | 4.56e-15 | 1.45e-15 |
| DINA | 105 | 2.56e-15 | 1.84e-15 |
| DINO | 185 | 1.59e-15 | 1.34e-15 |

## Canonical ordering and equations

For `K` attributes, classes follow GDINA's `alpha2` order: increasing number
of mastered attributes, then lexicographic combinations of attribute indices.
For `K = 3`, that is `000, 100, 010, 001, 110, 101, 011, 111`. JSON class and
local-group indices are zero-based.

For item `j`, `eta[j,c]` maps global class `c` to its item-local attribute
pattern. If `p[j,g]` is the probability for local group `g`, then

```text
P(X_ij = 1 | alpha_c) = p[j, eta[j,c]]
```

The conditional log likelihood is

```text
ell_ic = sum over observed j of
         X_ij log(p_jc) + (1-X_ij) log(1-p_jc).
```

Missing item responses contribute exactly zero. The marginal likelihood and
posterior use log-sum-exp:

```text
ell_i = log sum_c exp(ell_ic + log pi_c)
tau_ic = exp(ell_ic + log pi_c - ell_i).
```

With row weight `w_i`, expected totals and correct counts for item-local group
`g` are

```text
N_jg = sum over observed i and classes c in g of w_i tau_ic
R_jg = sum over observed i and classes c in g of w_i X_ij tau_ic.
```

The fast-path small-N correction requested for v1 is always applied:

```text
p = (R + 0.0005) / (N + 0.001), then clamp to [0.0001, 0.9999].
```

GDINA updates each local group separately. DINA pools every group except the
all-master group, while DINO pools every group except the zero-master group.
For a saturated prior,

```text
pi_c(new) = sum_i w_i tau_ic / sum_i w_i.
```

The JSON option includes the JavaScript safety floor `Number.MIN_VALUE`; it is
inactive in every fixture. A fixed prior never changes. Convergence is the
maximum absolute change across all item-group probabilities and, for a
saturated prior, class probabilities.

GDINA delta parameters solve `M_j delta_j = p_j`, using the full interaction
design matrix in canonical class order. DINA and DINO use intercept and mastery
contrast. `MAP` and `MLE` ties select the lowest zero-based class index; EAP is
the posterior mean of each binary attribute.

The parameter count is the sum of item design-matrix columns plus `2^K - 1`
for a saturated prior (zero for fixed). The fixtures use
`AIC = deviance + 2q` and `BIC = deviance + q log(sum(weights))`.

## Fixture inventory

| File | Contract exercised |
|---|---|
| `fixed-likelihood-posterior.json` | class order, eta, design, fixed likelihood/posterior, MAP/MLE/EAP |
| `fixed-missing-likelihood-posterior.json` | missing-as-no-contribution with a fixed prior |
| `em-gdina-saturated.json` | supplied start, GDINA M-step, saturated prior |
| `em-dina-saturated.json` | supplied start, DINA pooling, saturated prior |
| `em-dino-saturated.json` | supplied start, DINO pooling, saturated prior |
| `em-gdina-fixed-prior.json` | GDINA EM without prior updates |
| `em-gdina-saturated-missing.json` | weighted EM with item-level missingness |
| `row-aggregation-equivalence.json` | first-seen unique rows, weights, expanded posteriors |
| `deterministic-multistart-dina.json` | three supplied candidates and GDINA-compatible start selection |
| `benchmark-cases.json` | local-data and synthetic workload definitions |

The multi-start fixture follows the downloaded GDINA behavior: evaluate all
candidate item starts under the initial prior, select the highest initial
observed-data likelihood, and run EM only from that candidate. Ties select the
lowest candidate index.

## Tolerances

| Quantity | Required absolute tolerance |
|---|---:|
| Fixed likelihood, posterior, eta-derived probability | `1e-12` |
| Posterior/prior normalization | `5e-13` |
| Final EM item probability or prior | `1e-8` |
| Final EM log likelihood | `1e-8` |

Iteration counts and intermediate histories are diagnostic. Tests should
require convergence under the fixture's configured criterion and compare the
final numerical result; they should not fail solely because a different but
stable summation order crosses the threshold one iteration earlier or later.

## Benchmark definitions

Benchmarks define workload shape and measurement protocol, not pass/fail timing
thresholds. `posteriorFloat64Bytes = N * 2^K * 8` measures one dense posterior
matrix; actual peak memory is higher because likelihood and temporary buffers
also exist.

The four `local-*` runner cases use the exact response and Q matrices
mechanically exported from the frozen `.rda` files into
`benchmarks/data/local-cases.json`; they are not shape-matched synthetic
substitutes. Reproduce that committed input byte-for-byte with:

```sh
Rscript benchmarks/generate-local-data.R
node benchmarks/verify-local-data.mjs
```

Only the `browser-stress`, `node-stress`, preflight, and `smoke` cases use the
seeded synthetic generator.

The browser Worker moves numerical estimation off the UI thread, but normal
nested matrices are still synchronously validated and packed before transfer,
and JSON results are synchronously decoded and checked afterward. Record a
Node.js proxy measurement for those exact JavaScript passes with:

```sh
npm run build
node benchmarks/browser-boundary.mjs \
  --case local-real-ecpe --posterior scores-only
```

This proxy has no pass/fail timing threshold and is not a substitute for
measuring the real production browser on the lowest supported device.

| Case | N | J | K | Classes | One posterior |
|---|---:|---:|---:|---:|---:|
| local-sim10gdina | 1,000 | 10 | 3 | 8 | 64,000 B |
| local-sim30gdina | 1,000 | 30 | 5 | 32 | 256,000 B |
| local-real-ecpe | 2,922 | 28 | 3 | 8 | 187,008 B |
| local-real-tatsuoka | 536 | 20 | 8 | 256 | 1,097,728 B |
| browser-stress | 3,000 | 30 | 10 | 1,024 | 24,576,000 B |
| node-stress | 10,000 | 50 | 12 | 4,096 | 327,680,000 B |
| browser-memory-preflight-k15 | 3,000 | 30 | 15 | 32,768 | 786,432,000 B |

Run one warm-up and five measured fits, reporting median and p95 wall time,
peak memory, iteration count, and final likelihood. Numerical fixture checks
are a prerequisite for accepting benchmark results. The K=15 case is a
preflight-only guard: a dense browser fit must be rejected or use block-wise
posterior processing rather than allocate the full matrix.
