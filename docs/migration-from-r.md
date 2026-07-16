# Migrate from R `GDINA` to jGDINA

This guide translates the binary, single-group, closed-form workflow from the
frozen R `GDINA` 2.12.3 reference into the jGDINA v1 TypeScript contract. It is
not a general converter for an arbitrary `GDINA()` call.

Read [the v1 scope](../README.md#v1-scope) first. Keep the R workflow when it
uses multiple groups, polytomous or sequential responses, attribute structures,
higher-order/loglinear distributions, monotonic or other constraints, custom
links/design matrices, standard errors, DIF, Q validation, bootstrap, or model-
and item-fit procedures.

## 1. Decide whether the fit is portable

A fit is in the jGDINA v1 compatibility boundary only when all of these are
true:

- responses and attributes are binary;
- there is one respondent group;
- every item uses identity-link `GDINA`, `DINA`, or `DINO`;
- the attribute distribution is `saturated` or `fixed`;
- no monotonicity, parameter, or structural constraints are requested; and
- the ordinary closed-form EM path is appropriate;
- every item has at least one observed `0` and `1`; and
- every Q row requires an attribute and every Q column is used.

Do not silently discard unsupported R arguments to make a call run. A model
with different assumptions is a different analysis.

## 2. Translate the request

| R `GDINA()` input | jGDINA input | Important difference |
|---|---|---|
| `dat` | `responses` | Convert `NA` to `null` for JSON; JavaScript-only calls also accept `NaN` |
| `Q` | `qMatrix` | Plain `J x K` nested array of exact `0`/`1` values |
| `model` | `model` | Use uppercase `"GDINA"`, `"DINA"`, or `"DINO"`; scalar or `J` entries |
| `att.dist = "saturated"` | `prior: { type: "saturated" }` | This is the default in jGDINA |
| saturated `att.prior` | `prior.initialProbabilities` | Starting proportions, not fixed proportions |
| `att.dist = "fixed"`, `att.prior` | `prior: { type: "fixed", probabilities }` | Vector remains unchanged during EM |
| `catprob.parm` | `estimation.initialization.initialItemProbabilities` | Supplies start 0; use explicit candidates for all starts |
| `control$maxitr` | `estimation.maxIterations` | One scalar for the whole fit in v1 |
| `control$conv.crit` | `estimation.convergenceTolerance` | v1 convergence is parameter-change based |
| `control$nstarts` | `estimation.initialization.starts` | JavaScript PRNG is deterministic but not R-RNG compatible |
| `control$randomseed` | `estimation.initialization.seed` | Same default integer, different random stream |
| `control$lower.p`, `upper.p` | `estimation.probabilityBounds` | One `[lower, upper]` pair for all items |
| `control$smallNcorrection` | `estimation.smallSampleCorrection` | One `[numerator, denominator]` pair |
| R case/frequency weights | no public v1 field | Expand rows before fitting |

jGDINA does not implement R's alternative `control$conv.type` choices. Its
convergence change covers item probabilities and, for an estimated saturated
prior, mixing proportions. Do not compare iteration counts across different
convergence rules.

### R input

```r
library(GDINA)

dat <- matrix(c(
  1, 0, 1,
  0, 1, 1,
  0, 0, NA,
  1, 1, 0
), ncol = 3, byrow = TRUE)

Q <- matrix(c(
  1, 0,
  0, 1,
  1, 1
), ncol = 2, byrow = TRUE)

r_fit <- GDINA(
  dat = dat,
  Q = Q,
  model = c("DINA", "DINO", "GDINA"),
  att.dist = "saturated",
  control = list(
    maxitr = 2000,
    conv.crit = 1e-4,
    nstarts = 3,
    randomseed = 123456,
    lower.p = 1e-4,
    upper.p = 0.9999,
    smallNcorrection = c(0.0005, 0.001)
  )
)
```

### TypeScript input

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
  prior: { type: "saturated" },
  estimation: {
    maxIterations: 2000,
    convergenceTolerance: 1e-4,
    probabilityBounds: [1e-4, 0.9999],
    smallSampleCorrection: [0.0005, 0.001],
    initialization: { starts: 3, seed: 123456 },
  },
});
```

These calls express the same model and control values, but their randomly
generated starting candidates are not expected to be identical. For a strict
numerical comparison, extract or define start probabilities once and supply
the same ordered candidates to both implementations.

## 3. Preserve class and parameter order

R row names and JavaScript array positions can hide indexing mistakes. jGDINA
uses GDINA's canonical `alpha2` order. For three attributes:

```text
class index:       0    1    2    3    4    5    6    7
attribute profile: 000  100  010  001  110  101  011  111
```

R user-facing indices are normally one-based; jGDINA indices are zero-based.
Never infer a profile from a bitwise integer convention. Read
`result.attributePatterns[classIndex]`.

For item `j`, local probability order is the same canonical order restricted
to `result.estimates.items[j].requiredAttributes`. DINA's compact two values
are nonmaster and all-master. DINO's compact two values are zero-master and
any-master. Full DINA/DINO supplied vectors must repeat the tied groups.

## 4. Translate results

| R result | jGDINA result | Notes |
|---|---|---|
| `extract(fit, "attributepattern")` | `attributePatterns` | Exact class order for all indexed fields |
| `extract(fit, "att.prior")` | `estimates.classProbabilities` | Final estimated or fixed proportions |
| `extract(fit, "catprob.parm")` | `estimates.items[j].groupSuccessProbabilities` | Per-item reduced local groups |
| `extract(fit, "LCprob.parm")` | `estimates.items[j].successProbabilities` | Per-item probabilities for every global class |
| `extract(fit, "delta.parm")` | `estimates.items[j].deltaParameters` | Check model/design-column order |
| `extract(fit, "posterior.prob")` | `scores.posteriorProbabilities` | `null` when score-only mode is requested |
| `personparm(fit, "mp")` | `scores.eapAttributeProbabilities` | Marginal mastery probabilities |
| `personparm(fit, "EAP")` | `scores.eapAttributeClassifications` | Threshold is strictly greater than `0.5` |
| `personparm(fit, "MAP")` | `mapClassIndices` plus `mapHasTies` | Resolve index through `attributePatterns` |
| `personparm(fit, "MLE")` | `mleClassIndices` plus `mleHasTies` | Prior omitted from MLE |
| `extract(fit, "logLik")` | `statistics.logLikelihood` | Observed marginal log likelihood |
| `extract(fit, "deviance")` | `statistics.deviance` | `-2 log likelihood` |
| `AIC(fit)` / `extract(fit, "AIC")` | `statistics.aic` | Oracle-parity field |
| `BIC(fit)` / `extract(fit, "BIC")` | `statistics.bic` | Oracle-parity field |
| `extract(fit, "CAIC")` | `statistics.caic` | Same criterion name |
| `extract(fit, "SABIC")` | `statistics.sabic` | Same criterion name |
| `extract(fit, "AICc")` | `statistics.aicc` | Intentionally different formula; may be `null` |
| `extract(fit, "convergence")` | `convergence.converged` | Also inspect reason and final change |
| `extract(fit, "nitr")` | `convergence.iterations` | Comparable only under equivalent starts/rules |

jGDINA returns no R S3 object and does not reproduce every `extract()` alias.
Use the fields above directly and serialize the full `FitResult` when a
versioned JSON artifact is useful.

Some R display/accessor paths round values (`personparm()` defaults to four
digits, for example). Increase the R `digits` argument or compare underlying
unrounded values when validating numerical parity.

### Convert MAP/MLE indices to profiles

```ts
const mapProfiles = result.scores.mapClassIndices.map(
  (classIndex) => result.attributePatterns[classIndex],
);

const ambiguousMapRows = result.scores.mapHasTies
  .map((hasTie, rowIndex) => ({ hasTie, rowIndex }))
  .filter(({ hasTie }) => hasTie);
```

The lowest class index is returned on an exact tie. Retain the tie fields in
any downstream export; otherwise a deterministic array index can look like
statistical certainty.

## 5. Handle missing data and row identity deliberately

R `NA`, JavaScript `NaN`, and JSON `null` all mean an unobserved item response
within the accepted v1 path. A missing item contributes zero to that person's
conditional log likelihood. jGDINA requires every item to have both response
categories somewhere among its observed values.

Repeated response rows are aggregated by default for EM efficiency, but all
person-score arrays are expanded back to the original input order. Keep a
separate, non-sensitive respondent identifier array in your application; IDs
are intentionally not part of `FitInput` or `FitResult`.

## 6. Validate parity before switching production traffic

Use an explicit acceptance record for every migrated instrument:

1. Freeze the response/Q matrices, item-model vector, prior, probability
   bounds, small-N correction, stopping rule, and initial candidates.
2. Verify that `attributePatterns`, Q-derived required attributes, and item-
   local probability order agree before comparing numbers.
3. Compare final item probabilities, class proportions, log likelihood, and
   person posteriors. The repository fixtures require `1e-8` absolute tolerance
   for final EM probabilities and likelihoods and tighter tolerances for fixed-
   parameter calculations.
4. Compare classification indices only after checking posterior differences
   and tie flags. Near-ties can change a discrete class while probabilities
   remain numerically close.
5. Require `convergence.converged === true` and investigate warnings,
   boundary estimates, very small class proportions, or sensitivity to starts.
6. Record runtime, peak memory, result size, and provider limits using the same
   posterior-storage mode planned for production.

The repository's independent oracle and compiled-kernel comparison are
described in [validation/README.md](../validation/README.md). They validate the
engine implementation; they do not validate a new instrument's Q-matrix or
substantive interpretation.

## 7. Keep an R analysis path for missing diagnostics

jGDINA v1 provides estimation and classifications, not the complete R
diagnostic workflow. Until the relevant diagnostics are implemented and
independently validated, retain an R checkpoint for model fit, item fit,
Q-matrix evaluation, standard errors, and other inferential procedures needed
by the study. The exact gap and reporting requirements are listed in
[Statistical responsibility](./statistical-responsibility.md).

## Related guides

- [Complete TypeScript API and result fields](./api-reference.md)
- [Next.js production and deployment](./nextjs-production.md)
- [Evidence-based v1.1 roadmap](./roadmap-v1.1.md)
