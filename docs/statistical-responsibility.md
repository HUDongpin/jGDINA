# Statistical responsibility and the v1 diagnostics gap

jGDINA v1 estimates a deliberately restricted class of cognitive diagnosis
models. Numerical convergence answers “did this EM procedure reach its stopping
rule?” It does not answer “is this model valid for these data and this use?”

This distinction applies equally to research, dashboards, and production
classification services. A standalone TypeScript runtime removes an R runtime
dependency; it does not remove the need for psychometric review.

## What v1 establishes

Within its documented binary, single-group GDINA/DINA/DINO boundary, v1
provides:

- validated data/Q dimensions and values;
- deterministic initialization and transparent start selection;
- closed-form EM estimates and an explicit convergence record;
- observed likelihood and information criteria;
- class probabilities, item probabilities, and delta parameters;
- MAP, MLE, and EAP person scores with tie flags; and
- operational memory, missingness, and row-aggregation diagnostics.

The numerical engine is checked against independent base-R equations and the
frozen upstream fast kernel. That evidence supports implementation correctness
for the tested contract. It does not establish the validity of a particular
Q-matrix, instrument, sample, or decision rule.

## What v1 does not diagnose

| Question | v1 status | Required action now |
|---|---|---|
| Did EM meet its parameter-change tolerance? | Reported | Require convergence and review final change/iterations |
| Is the global model-data fit adequate? | Not implemented | Use a validated external fit workflow, currently typically R `GDINA` |
| Which items show local misfit or dependence? | Not implemented | Run item/local-dependence diagnostics externally |
| Is the Q-matrix correctly specified? | Structural binary checks only | Perform substantive review and validated Q-matrix evaluation externally |
| Are parameters identifiable and stable? | No formal test | Inspect design, class sizes, starts, boundaries, and sensitivity; seek expert review |
| How uncertain are item/class parameters? | No standard errors or intervals | Use a validated inferential/bootstrap workflow externally |
| How accurate and stable are classifications? | Point scores and ties only | Report uncertainty, reliability/accuracy evidence, and sensitivity externally |
| Is there DIF or group non-invariance? | Not implemented; v1 is one-group | Do not infer invariance; use an appropriate multi-group/DIF workflow |
| Is a reduced model preferable item by item? | No model-comparison tests | Compare prespecified models externally; avoid data-driven silent switching |

The `FitResult.diagnostics` name is operational. Its memory estimate and row
counts must not be reported as statistical goodness-of-fit evidence.

## Minimum review before interpreting a fit

At minimum, an analysis owner should:

1. Establish the construct and attribute definitions before fitting.
2. Document how each Q-matrix entry was elicited, reviewed, and versioned.
3. Check response coding, missing-data mechanisms, category balance, sample
   inclusion, and whether one-group binary assumptions are defensible.
4. Prespecify item models or justify model selection outside jGDINA.
5. Inspect every candidate's initial likelihood, selected start, convergence
   reason, final change, and sensitivity to additional explicit starts.
6. Review item estimates near configured bounds and class probabilities near
   zero. Bounds can stabilize computation while masking sparse information.
7. Run global, item, residual/local-dependence, and Q-matrix diagnostics with a
   validated external workflow.
8. Evaluate classification uncertainty, exact/near ties, subgroup behavior,
   and consequences of the `> 0.5` EAP threshold.
9. Reproduce the result with frozen inputs/options and compare it with the R
   acceptance path for a new instrument or material change.
10. Have a qualified psychometrician approve the interpretation and intended
    decision use.

Information criteria compare fitted candidate models; they are not absolute
fit tests. A smaller AIC/BIC does not repair an invalid Q-matrix or demonstrate
that either candidate is adequate.

## Non-convergence and boundary estimates

A fit can resolve successfully with
`convergence.reason === "maximum-iterations"`. Treat it as unaccepted, not as a
partial success suitable for classification. Record the artifact for diagnosis,
then examine input quality, model specification, starts, tolerance, iteration
limit, sparse classes, and boundary estimates.

Do not automatically raise `maxIterations` until a result converges. That can
hide a misspecified or weakly identified model and consume unbounded production
resources. Any control change belongs in a versioned analysis decision and
must be revalidated.

Probability bounds are strict-interior computational controls. An estimate at
or very near a bound may indicate strong evidence, sparse expected counts,
separation-like behavior, or instability. jGDINA does not decide which
interpretation is appropriate.

## Person-level reporting

Classification arrays are sensitive derived data. Preserve:

- the class pattern lookup (`attributePatterns`), not only zero-based indices;
- MAP/MLE tie flags;
- EAP mastery probabilities, not only thresholded classifications;
- package/result schema version and normalized fit settings; and
- the Q-matrix/instrument version that generated the score.

Do not present MAP, MLE, or EAP classifications as error-free labels. A tie flag
captures exact equal maxima only; a near tie can still reflect substantial
uncertainty. Full posterior probabilities provide more information when their
memory/privacy cost is justified, but even a posterior is conditional on the
fitted model and prior.

High-stakes educational, employment, clinical, or access decisions require
governance beyond this package: validation for the target population, fairness
and accessibility review, human oversight, appeal/correction procedures, data
protection, and applicable legal/ethical compliance.

## Missing responses and data governance

In v1, a missing item contributes no conditional log-likelihood term. That is a
computational policy, not a claim that missingness is ignorable in the study.
Investigate missingness by person, item, subgroup, administration condition,
and time. If the missing-data mechanism is incompatible with the model, using
`null` does not solve the bias.

Keep person identifiers outside `FitInput`. Limit access to raw responses,
posteriors, and classifications; define retention and deletion periods; and
avoid logging individual rows. Browser-only fitting can reduce server transfer,
but application analytics or persistence can still disclose the data.

## Required language in reports

A report based on v1 should identify:

- jGDINA/package version and `FitResult.schemaVersion`;
- the binary, single-group item models and prior type;
- sample, item, attribute, and latent-class counts;
- missing-response policy and count;
- starts, probability bounds, small-N correction, tolerance, and iteration cap;
- convergence status, iterations, selected start, and final change;
- whether full posteriors or score-only output was used;
- which external fit/Q/uncertainty diagnostics were run and their versions;
- known unsupported analyses and limitations; and
- who approved the psychometric interpretation.

Suggested limitation statement:

> jGDINA v1 supplied closed-form binary single-group estimation and person
> scores. Model fit, Q-matrix validity, parameter uncertainty, and
> classification validity were evaluated separately; numerical convergence
> alone was not treated as evidence of validity.

## Release implication

The next feature release should prioritize validated statistical fit and
diagnostic evidence before broader model families. Adding multi-group or
polytomous estimation would increase the number of ways to produce an
interpretable-looking result without first closing the current evaluation gap.
The proposed gates are in the [v1.1 roadmap](./roadmap-v1.1.md).

## Related guides

- [API result and convergence fields](./api-reference.md#fitresult)
- [R migration acceptance protocol](./migration-from-r.md#6-validate-parity-before-switching-production-traffic)
- [Next.js observability](./nextjs-production.md#observability-without-leaking-response-data)
- [Numerical validation evidence](../validation/README.md)
