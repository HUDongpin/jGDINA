# Evidence-based roadmap toward jGDINA v1.1

This is a proposed, gated roadmap—not a promise that every item will ship.
jGDINA v1.1 should improve the ability to decide whether a fitted v1 model is
usable before expanding the set of models that can be fitted.

## Evidence behind the priority

The current repository establishes three relevant facts:

1. The independent base-R oracle covers the accepted v1 numerical boundary,
   and the compiled fast-kernel comparison reaches the same iterations with
   final probability differences around `4.6e-15`. The estimator is therefore
   mature enough for its next work to focus on evaluation, while preserving
   those regression gates.
2. `FitResult.diagnostics` currently contains missingness, row aggregation, and
   memory facts only. It has no global fit, item fit, local-dependence,
   Q-matrix, uncertainty, or classification-quality statistic.
3. The frozen R source contains separate fit and diagnostic workflows such as
   global/model fit, item fit, and Q validation. Porting additional estimator
   families first would widen the gap between what jGDINA can estimate and what
   it can responsibly evaluate.

The evidence for items 1 and 2 is in
[validation/README.md](../validation/README.md) and the
[v1 API result contract](./api-reference.md#diagnostics). The diagnostic gap is
catalogued in [Statistical responsibility](./statistical-responsibility.md).

## Release principle

The v1.1 theme should be **validated fit and diagnostic evidence for the
existing binary, single-group GDINA/DINA/DINO scope**.

No diagnostic is complete merely because its formula has been translated. It
must define its assumptions and undefined conditions, match an independent
reference, work consistently in direct/browser/Node backends, remain JSON-safe,
and state what conclusion it does and does not support.

## Phase 0: strengthen the release baseline

Before adding a statistic:

- freeze real-data acceptance cases representing GDINA, DINA, DINO, mixed
  items, fixed/saturated priors, and missing responses;
- compare R and TypeScript parameters, priors, likelihood, score probabilities,
  tie handling, convergence, and memory/runtime using explicit starts;
- publish machine-readable tolerances and a human-readable discrepancy report;
- run the package matrix on supported Node/Next versions and a real browser;
  and
- preserve all v1 fixtures as non-regression gates.

This phase distinguishes an implementation regression from a diagnostic
formula disagreement later.

## Phase 1: diagnostic foundations

Add a versioned diagnostic contract that can represent:

- statistic name and definition/version;
- value, degrees of freedom, and p-value where mathematically defined;
- sample/design prerequisites and whether they were met;
- omitted/merged cells and missing-data treatment;
- warning and “not computed” reasons without `NaN`/`Infinity`;
- item/pair identifiers using zero-based API indices; and
- enough observed/expected summary information to audit the calculation
  without persisting raw person responses.

Diagnostic calculation should be separable from EM so a frozen `FitResult` and
compatible input can be evaluated without silently refitting. Any additional
sufficient-statistic retention must be opt-in or explicitly included in memory
preflight.

Phase 1 also adds first-class warnings for:

- non-convergence;
- item estimates near configured probability bounds;
- very small estimated class proportions;
- exact MAP/MLE ties and configurable near-tie summaries; and
- sensitivity across explicit start candidates or controlled refits.

These warnings do not replace formal fit tests, but they close common reporting
failures with comparatively low numerical risk.

## Phase 2: global fit for the existing model scope

Select one global limited-information fit family after reviewing its sample-
size, item-count, sparsity, and degrees-of-freedom conditions. Modified M2-style
statistics are a leading candidate because the frozen R implementation exposes
an auditable reference, but selection must follow a method review rather than
name compatibility.

Acceptance requires:

- a written derivation and explicit parameter-count/df policy for fixed versus
  saturated priors and mixed item models;
- well-defined behavior for sparse/undefined cases and missing responses;
- independent R or another authoritative implementation, not a transcription
  of the TypeScript code, for oracle values;
- hand-checkable small examples and real-data parity cases;
- simulation checks for calibration under known generating models and power
  under prespecified misspecifications; and
- resource estimates for any `J^2`, class, or covariance structures introduced.

Do not reduce the result to a single pass/fail p-value. Return component values,
conditions, warnings, and effect-size/residual summaries needed for review.

## Phase 3: item fit and local dependence

Add item- and pair-level diagnostics only after the global foundation fixes
ordering, missingness, warning, and serialization conventions. Candidate work
includes observed-versus-expected item summaries, residual associations, and
local-dependence flags.

The implementation must address multiple testing explicitly and avoid
unbounded `J x J` output by offering selection/threshold controls. Production
logs should record aggregate warning counts rather than sensitive small-cell
details.

Acceptance requires recovery tests for injected item misfit/local dependence,
null calibration simulations, parity against a frozen reference, and memory
guards for large `J`.

## Phase 4: Q-matrix evidence and classification quality

Q-matrix validation should produce evidence for expert review, not silently
rewrite the matrix. A first release can rank or flag candidate item-attribute
relationships while preserving the original Q, method configuration, and
uncertainty. Any suggested Q must be a separate artifact requiring explicit
approval and a new fit.

Classification diagnostics should retain probabilities and report uncertainty
or stability summaries rather than only point accuracy labels. Simulation-based
classification accuracy/consistency is a candidate, but its computational cost,
randomness, and bootstrap/sample contract must enter resource limits and
reproducibility rules.

## Explicit v1.1 non-goals

Unless fit/diagnostic gates above finish early with independent evidence, defer:

- multiple groups and DIF;
- polytomous, sequential, or multiple-strategy models;
- higher-order, independent, structured, or loglinear attribute distributions;
- RRUM, ACDM, LLM, and custom link/design models;
- monotonicity and general constrained optimization;
- WebAssembly optimization without a measured bottleneck; and
- automated model or Q-matrix selection that changes the fitted model without
  an explicit user decision.

Standard errors and confidence intervals are important, but they require a
separate inferential design and validation effort. They should not be added as
an unvalidated side effect of a fit-statistic implementation.

## Definition of done for each diagnostic

A roadmap item is complete only when all applicable evidence exists:

- public statistical definition, assumptions, ordering, missingness, and
  undefined-case policy;
- TypeScript types and stable JSON schema with no non-finite values;
- independent oracle fixtures and real-data reference comparisons;
- property/simulation tests that exercise both null and misspecified cases;
- direct, browser Worker, Node worker, and Next.js integration coverage;
- cancellation, progress, memory estimate, and resource-limit behavior;
- API, R migration, statistical-responsibility, and production documentation;
- benchmark results showing acceptable CPU/memory/output scaling; and
- psychometric method review separate from the code author.

A green unit test is necessary but insufficient. The diagnostic must be safe to
interpret under a documented set of conditions.

## Proposed release sequence

| Release | Candidate focus | Promotion gate |
|---|---|---|
| `1.0.0-rc.x` | Real-data acceptance, packaging, CI, deployment evidence | Frozen reports pass on supported runtimes |
| `1.0.0` | Current estimator scope only | No unresolved numerical/package release blocker |
| `1.1.0-alpha.x` | Diagnostic contract, warnings, selected global fit prototype | Independent oracle and method review |
| `1.1.0-beta.x` | Global plus selected item/local diagnostics | Real-data/simulation and runtime gates |
| `1.1.0` | Only diagnostics that meet the full definition of done | Documentation and interpretation audit |

Features that miss a gate move to a later release; the release should not lower
evidence requirements to preserve a date.

## Decision record for expansion after v1.1

After the fit/diagnostic release, rank estimator expansion candidates using:

- demonstrated user/research need;
- availability of an independent numerical and statistical oracle;
- identifiability and diagnostic support;
- implementation and maintenance complexity;
- browser/Node resource feasibility; and
- licensing and distribution implications.

That decision should use issue/usage evidence collected from the v1 release,
not assume that full R feature count is the correct product objective.
