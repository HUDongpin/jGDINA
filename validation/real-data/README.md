# Real-data acceptance workflow

This workflow compares jGDINA v1 against the real datasets and exact fast EM
kernel bundled in the frozen GDINA 2.12.3 source checkout.

Run from the repository root:

```sh
npm run accept:real-data
```

The command creates these reviewable artifacts:

- `evidence/r-reference.json`: complete deterministic inputs and R reference
  estimates/scores.
- `evidence/comparison.json`: machine-readable acceptance decisions and metrics.
- `evidence/comparison.csv`: compact case-level metrics for external analysis.
- `evidence/full-package-comparison.json`: optional complete-wrapper audit.
- `SUMMARY.md`: concise human-readable results and provenance.
- `report/artifact.json`: canonical source-backed technical-report artifact.
- `report/report.html`: self-contained, browser-verified acceptance report.

The R packages `jsonlite`, `Rcpp`, and `RcppArmadillo` plus a working C++
compiler are required. The workflow never installs packages and never modifies
`GDINA-master`.

The report source can be refreshed after the evidence with:

```sh
node validation/real-data/build-report.mjs
```

That projection uses SQLite to execute the three committed report queries. The
self-contained HTML is delivered with the installed Data Analytics portable
builder through `deliver-report.mjs`; see `report-notes.md` for the report
design and the documented scrollbar-safe header adjustment.

## Optional complete-package wrapper audit

The regular acceptance command is the reproducible CI gate: it compiles only
the frozen exact kernel and does not require the full GDINA dependency tree.
When GDINA 2.12.3 has already been installed in a temporary library, also run:

```sh
JGDINA_R_LIB=/tmp/jgdina-r-lib \
R_MAKEVARS_USER=/tmp/jgdina-Makevars \
npm run accept:full-package
```

This second audit sends the same serialized starts, priors and controls through
the complete `GDINA::GDINA()` wrapper, then uses `extract()` and `personparm()`
to compare estimates, likelihood, iteration count, class order, MAP/MLE and EAP
results. It writes `evidence/full-package-comparison.json`.

`GDINA()` unconditionally aggregates response patterns before its optional C++
path, whose public call has no frequency argument. The audit therefore appends
deterministic fixed-`P=.5` binary row-tag items, just sufficient to keep every
respondent row unique. These items are class-independent and fixed at every
iteration, so they do not alter posteriors, real-item estimates, priors or
person scores; the script removes their known constant contribution from the
reported log-likelihood. This permits an exact full-wrapper audit without
changing `GDINA-master`. The standard dependency-light CI check still invokes
the frozen exact kernel directly.
