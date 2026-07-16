# Real-data R–jGDINA acceptance summary

Overall result: **PASS**

| Case | Model | N × J × K | Missing | Iterations R / JS | |Δ logLik| | max |Δ item p| | MAP / MLE / EAP class agreement | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ecpe-gdina | GDINA | 2922 × 28 × 3 | 0 | 1639 / 1639 | 1.455e-11 | 6.661e-14 | 100.00% / 100.00% / 100.00% | PASS |
| ecpe-dino | DINO | 2922 × 28 × 3 | 0 | 653 / 653 | 0.000e+0 | 5.884e-15 | 100.00% / 100.00% / 100.00% | PASS |
| tatsuoka1990-dina | DINA | 536 × 20 × 8 | 0 | 1170 / 1170 | 9.095e-12 | 1.101e-13 | 100.00% / 100.00% / 100.00% | PASS |
| ecpe-gdina-missing | GDINA | 2922 × 28 × 3 | 812 | 764 / 764 | 2.183e-11 | 7.772e-15 | 100.00% / 100.00% / 100.00% | PASS |

## Scope and provenance

- Inputs are the ECPE and Tatsuoka (1990) real datasets bundled in the frozen GDINA 2.12.3 source tree.
- The source bundle contains exactly two `realdata_*.rda` files, so no third dataset was invented or relabeled as real data.
- Item and prior estimates plus iteration counts come from the exact frozen `src/Lik2.cpp` fast EM kernel.
- The dependency-light reference deliberately does not load the full R package. The separately installed-package audit below checks the complete public wrapper and person-parameter surfaces.
- `ecpe-gdina-missing` applies a deterministic mask to the original ECPE responses solely to verify identical item-level missing-value treatment.
- All starts, priors, class ordering, probability bounds, corrections and convergence settings are serialized in `r-reference.json`.

## Complete installed-package wrapper audit

Overall result: **PASS** through `GDINA::GDINA(), GDINA::extract(), and GDINA::personparm()`.

| Case | Iterations reference / wrapper | |Δ logLik| | max |Δ item p| | extract first-max MAP / MLE / personparm EAP agreement | Result |
|---|---:|---:|---:|---:|---:|
| ecpe-gdina | 1639 / 1639 | 5.821e-11 | 2.665e-15 | 100.00% / 100.00% / 100.00% | PASS |
| ecpe-dino | 653 / 653 | 5.821e-11 | 1.110e-15 | 100.00% / 100.00% / 100.00% | PASS |
| tatsuoka1990-dina | 1170 / 1170 | 1.273e-11 | 2.220e-16 | 100.00% / 100.00% / 100.00% | PASS |
| ecpe-gdina-missing | 764 / 764 | 5.821e-11 | 1.887e-15 | 100.00% / 100.00% / 100.00% | PASS |

The complete-wrapper audit uses fixed class-independent P=.5 row tags to preserve respondent frequencies through GDINA()'s unconditional response-pattern aggregation; their known constant likelihood contribution is removed. This optional audit is separate from the dependency-light exact-kernel CI gate.

For tatsuoka1990-dina, `personparm()`'s random tie selection yields 59.51% / 60.07% strict MAP/MLE profile agreement, while both are 100.00% tie-compatible; deterministic first-maximum indices from `extract()` agree 100%.

## Reproduce

From the repository root, run `npm run accept:real-data`. The command rebuilds jGDINA, recompiles the frozen R kernel, regenerates the reference, compares every field and exits nonzero on any failed gate.

To repeat the optional installed-package audit, set `JGDINA_R_LIB=/tmp/jgdina-r-lib` and `R_MAKEVARS_USER=/tmp/jgdina-Makevars`, then run `npm run accept:full-package`. This audit is intentionally not part of the dependency-light CI gate.
