# Private user-data acceptance

This local workflow checks whether one de-identified response/Q-matrix case
produces the same closed-form GDINA/DINA/DINO fit in jGDINA and a frozen R
technical oracle. Raw input remains outside the repository. The committed
workflow never installs packages, sends data over a network, or writes raw
responses into its output reports.

The default oracle calls the frozen `fast_GDINA_EM` C++ kernel plus independent
base-R scoring; it does not call the complete public `GDINA::GDINA()` wrapper.
Numerical parity is a migration check, not evidence that the Q-matrix or model
is substantively valid. Model/item fit, Q-matrix validation, uncertainty,
standard errors, DIF, and domain review remain separate responsibilities.

## Requirements

- Node.js 20 or later and a completed `npm run build`.
- A POSIX local filesystem with enforceable owner/group/world modes. The
  workflow fails closed on Windows because ACL inheritance is not yet audited.
  Private files/directories must be current-user-owned and have no extended
  ACL; the output parent must not be group/world writable.
- R with `jsonlite`.
- For the default frozen-kernel comparison, R packages `Rcpp` and
  `RcppArmadillo`, plus a working C++ compiler.
- Audited R dependency directories must contain regular files only; symlink or
  special-file entries fail closed during package-tree fingerprinting.
- For the kernel oracle, the downloaded `GDINA-master` source is already
  present in this workspace.

The workflow does not install any missing dependency. It does not require a
GitHub account or network access.

## Prepare a private case

Use [`case.example.json`](./case.example.json) only as a structural example;
its rows are synthetic. The formal JSON Schema is
[`case.schema.json`](./case.schema.json). Create the real case outside the
jGDINA workspace and remove identifiers before copying values into it:

```sh
umask 077
mkdir -p "$HOME/jgdina-private"
cp validation/user-data/case.example.json "$HOME/jgdina-private/case.json"
chmod 600 "$HOME/jgdina-private/case.json"
```

Replace the synthetic matrices while preserving these rules:

- `responses` is `N x J` and contains only `0`, `1`, or `null` for missing.
- The canonical JSON file is limited to 16 MiB so parsing plus validation and
  worker copies stay within a defensible local-memory envelope.
- `qMatrix` is `J x K`, binary, has at least one `1` in every row, and uses
  every attribute column at least once.
- Every response item has at least one observed `0` and one observed `1`.
- Do not add respondent IDs, pseudonyms, free text, dates, schools, sites, or
  linkage keys. Keep any row-to-person mapping in a separate controlled system.
- Use a non-identifying analysis label for `caseId`; it appears in terminal
  status text and both private reports.
- `itemIds` and `attributeIds` are optional de-identified labels only.
- All three privacy acknowledgements must be `true`.

For an R comparison, use exactly one start and set `aggregateRows` to `false`.
The private schema permits at most one explicit candidate matrix; fit-only
multi-start checks can instead use one start-0 matrix plus a larger seeded
`starts` value.

An explicit start is best for a migration audit. If it is omitted, the CLI
creates a deterministic canonical start and records its SHA-256 hash. The
default `kernel` oracle accepts a saturated prior; use `base-r` for a fixed
prior. This privacy-focused workflow requires `posteriorStorage` to be
`scores-only`; run person-level application exports as a separate controlled
workflow.

## Run preflight, then acceptance

Run from the repository root. Preflight validates shape, options, resource
limits, privacy acknowledgements, and the projected memory footprint without
fitting the model or invoking R:

```sh
npm run build
node validation/user-data/accept.mjs \
  --case "$HOME/jgdina-private/case.json" \
  --oracle kernel \
  --preflight
```

Review both the Node-worker and full-R-oracle memory estimates in the aggregate
preflight JSON. The R gate is separate because its reference scoring retains
multiple dense respondent-by-class and item-by-class matrices; a case can be
safe for score-only jGDINA but too large for the R oracle. Then name a new
private output location that does not yet exist and run the frozen-kernel
comparison:

```sh
node validation/user-data/accept.mjs \
  --case "$HOME/jgdina-private/case.json" \
  --out "$HOME/jgdina-private/result-001" \
  --oracle kernel
```

The final output path must not exist; the CLI creates it atomically where
possible and refuses to alter an existing path. It enforces a
owner-only non-executable input mode `0400` or `0600`, creates the output
directory as mode `0700`, and writes all output files as mode `0600`. Sensitive
Node-to-R request/reference files
exist only in a hidden mode-`0700` work directory inside that private output
directory and are deleted on normal completion, handled failure, SIGINT, or
SIGTERM. A hard kill or power loss can leave that hidden directory behind, but
it remains inside the explicitly private mode-`0700` location and should be
securely removed before retrying with a new output path.

Oracle choices are:

- `kernel` (default): the exact frozen GDINA 2.12.3 `fast_GDINA_EM` kernel,
  with independent base-R scoring; saturated prior only. The kernel, oracle,
  and equation-source SHA-256 values are checked before private copies execute.
  The report also fingerprints the loaded R package trees, compiler settings,
  actual jGDINA runtime artifacts, and local Git commit/clean-state metadata.
- `base-r`: independent closed-form base-R equations; saturated or fixed
  prior.
- `none`: jGDINA fit only. Its status is `FIT_ONLY`, not parity acceptance.

## Interpret the result

The private output contains exactly:

- `summary.json`: aggregate fit/parity gates, differences, warnings, runtime,
  and limitations.
- `SUMMARY.md`: the same decision in concise human-readable form.
- `provenance.private.json`: hashes linking the report to the private input.

None contains responses, a Q-matrix, respondent identifiers, posterior rows, or
person-level MAP/MLE/EAP results. The provenance hashes are private linkage
metadata and should not be published by default.

`summary.json` is committed last and is the completion marker; consumers must
also require the exact three-file set before treating a report as complete.

Statuses and process exit codes are:

| Status | Exit | Meaning |
|---|---:|---|
| `PASS` | 0 | The technical oracle and jGDINA converged and every applicable parity gate passed, with no review warning. |
| `REVIEW` | 3 | Parity passed, but boundaries, tiny classes, ties, or R warnings need review. |
| `FAIL` | 2 | Non-convergence, non-tolerance stop, or a parity gate failed. |
| `FIT_ONLY` | 3 | jGDINA ran without an R oracle; this is not parity evidence. |

Input/privacy and oracle-memory failures use exit code 65, pinned-source
integrity failures use 66, R/platform availability failures use 69, output I/O
failures use 74, and an internal acceptance failure uses 70. Do not treat
`REVIEW` or `FIT_ONLY` as a passing automated gate merely because a report was
produced.

Even `PASS` records `finalInstrumentAcceptance: false`. Complete R-wrapper
checks and the model/item-fit, Q-matrix, uncertainty, fairness, and substantive
reviews required for the instrument remain separate gates.

## Workflow smoke test

After building the packages, run:

```sh
node validation/user-data/smoke.mjs
```

The smoke test copies deterministic fixture data to an external mode-`0600`
temporary case, runs preflight, a mixed-model compact DINA/DINO-start
acceptance, fixed-prior/base-R and fit-only paths, kernel iteration-cap probes,
and repeated frozen-kernel acceptances. It verifies aggregate-only mode-`0600`
output in mode-`0700` directories and compares stable evidence across repeated
runs. Negative checks cover workspace/symlink input, loose permissions,
malformed options, weakened tolerances, R-oracle memory rejection, and refusal
to modify an existing output directory. All temporary data is removed in a
`finally` cleanup.
