import { readFileSync } from "node:fs";
import {
  validateFitInput,
  type BinaryValue,
  type FitInput,
  type FitResult,
  type ItemModel,
  type ResponseInputValue,
} from "@jgdina/core";
import { describe, expect, it } from "vitest";
import {
  aggregateResponseRows,
  attributePatterns,
  evaluateValidated,
  fitValidated,
  itemDesignMatrix,
  parameterLocations,
  type ModelEvaluation,
} from "../src/index.js";

const FIXED_TOLERANCE = 1e-12;
const EM_TOLERANCE = 1e-8;

interface FixturePrior {
  readonly mode: "fixed" | "saturated";
  readonly probabilities?: number[];
  readonly initial_probabilities?: number[];
}

interface FixtureOptions {
  readonly correction: [number, number];
  readonly probability_bounds: [number, number];
  readonly convergence_tolerance: number;
  readonly max_iterations: number;
}

interface FixtureExpected {
  readonly attribute_patterns?: number[][];
  readonly eta?: number[][];
  readonly design_matrices?: number[][][];
  readonly posterior?: number[][];
  readonly conditional_log_likelihood?: number[][];
  readonly individual_marginal_log_likelihood?: number[];
  readonly latent_class_probabilities?: number[][];
  readonly log_likelihood: number;
  readonly deviance?: number;
  readonly item_group_probabilities?: number[][];
  readonly delta_parameters?: number[][];
  readonly class_prior?: number[];
  readonly converged?: boolean;
  readonly iterations?: number;
  readonly max_change?: number;
  readonly observation_count?: number;
  readonly item_parameter_count?: number;
  readonly prior_parameter_count?: number;
  readonly parameter_count?: number;
  readonly expected_correct?: number[][];
  readonly expected_total?: number[][];
  readonly aic?: number;
  readonly bic?: number;
  readonly map_class?: number[];
  readonly mle_class?: number[];
  readonly eap_attributes?: number[][];
}

interface OracleFixture {
  readonly input: {
    readonly q_matrix: number[][];
    readonly responses: ResponseInputValue[][];
    readonly response_weights?: number[];
    readonly models: ItemModel[];
    readonly item_group_probabilities?: number[][];
    readonly initial_item_group_probabilities?: number[][];
    readonly prior: FixturePrior;
    readonly options?: FixtureOptions;
  };
  readonly expected: FixtureExpected;
}

interface AggregationFixture {
  readonly input: {
    readonly q_matrix: number[][];
    readonly raw_responses: ResponseInputValue[][];
    readonly models: ItemModel[];
    readonly initial_item_group_probabilities: number[][];
    readonly prior: FixturePrior;
    readonly options: FixtureOptions;
  };
  readonly expected: {
    readonly aggregated_responses: ResponseInputValue[][];
    readonly frequencies: number[];
    readonly raw_to_unique: number[];
    readonly fit: FixtureExpected;
    readonly max_absolute_item_probability_difference: number;
    readonly absolute_log_likelihood_difference: number;
    readonly max_absolute_expanded_posterior_difference: number;
  };
}

describe("independent R oracle fixtures", () => {
  for (const fixtureName of [
    "fixed-likelihood-posterior",
    "fixed-missing-likelihood-posterior",
  ]) {
    it(`matches every fixed-parameter field in ${fixtureName}`, () => {
      const fixture = readFixture(fixtureName);
      const itemProbabilities = required(fixture.expected, "posterior");
      const expectedItemProbabilities = required(
        fixture.input,
        "item_group_probabilities",
      );
      const expectedPatterns = required(fixture.expected, "attribute_patterns");
      const expectedEta = required(fixture.expected, "eta");
      const expectedClassSuccess = required(
        fixture.expected,
        "latent_class_probabilities",
      );
      const expectedConditional = required(
        fixture.expected,
        "conditional_log_likelihood",
      );
      const priorProbabilities = required(fixture.input.prior, "probabilities");
      const validated = validateFitInput({
        model: fixture.input.models,
        prior: { probabilities: priorProbabilities, type: "fixed" },
        qMatrix: fixture.input.q_matrix,
        responses: fixture.input.responses,
      });
      const evaluation = evaluateValidated(validated, expectedItemProbabilities);

      assertCanonicalModelFields(fixture, expectedPatterns, expectedEta);
      const etaDerived = expectedItemProbabilities.map((probabilities, item) =>
        (expectedEta[item] ?? []).map((group) => probabilities[group] ?? Number.NaN),
      );
      compareMatrix(etaDerived, expectedClassSuccess, FIXED_TOLERANCE);
      compareMatrix(
        evaluation.classSuccessProbabilities,
        expectedClassSuccess,
        FIXED_TOLERANCE,
      );
      compareMatrix(
        evaluation.logLikelihoodByClass,
        expectedConditional,
        FIXED_TOLERANCE,
      );
      compareMatrix(
        evaluation.posteriorProbabilities,
        itemProbabilities,
        FIXED_TOLERANCE,
      );
      compareVector(
        individualMarginalLogLikelihoods(evaluation),
        required(fixture.expected, "individual_marginal_log_likelihood"),
        FIXED_TOLERANCE,
      );
      expectAbsoluteClose(
        evaluation.logLikelihood,
        fixture.expected.log_likelihood,
        FIXED_TOLERANCE,
      );
      expectAbsoluteClose(
        -2 * evaluation.logLikelihood,
        required(fixture.expected, "deviance"),
        FIXED_TOLERANCE,
      );
      expect(evaluation.mapClassIndices).toEqual(required(fixture.expected, "map_class"));
      expect(evaluation.mleClassIndices).toEqual(required(fixture.expected, "mle_class"));
      compareMatrix(
        evaluation.eapAttributeProbabilities,
        required(fixture.expected, "eap_attributes"),
        FIXED_TOLERANCE,
      );
    });
  }

  for (const fixtureName of [
    "em-gdina-saturated",
    "em-dina-saturated",
    "em-dino-saturated",
    "em-gdina-fixed-prior",
    "em-gdina-saturated-missing",
  ]) {
    it(`matches every exposed EM field in ${fixtureName}`, () => {
      const fixture = readFixture(fixtureName);
      const options = required(fixture.input, "options");
      const initial = required(fixture.input, "initial_item_group_probabilities");
      const expectedItems = required(fixture.expected, "item_group_probabilities");
      const expectedPrior = required(fixture.expected, "class_prior");
      const weights = fixture.input.response_weights ?? [];
      const responses = expandWeightedRows(fixture.input.responses, weights);
      const validated = validateFitInput({
        estimation: {
          aggregateRows: true,
          convergenceTolerance: options.convergence_tolerance,
          initialization: { initialItemProbabilities: initial, starts: 1 },
          maxIterations: options.max_iterations,
          posteriorStorage: "full",
          probabilityBounds: options.probability_bounds,
          smallSampleCorrection: options.correction,
        },
        model: fixture.input.models,
        prior: fixturePrior(fixture.input.prior),
        qMatrix: fixture.input.q_matrix,
        responses,
      });
      const result = fitValidated(validated);

      expect(result.convergence.converged).toBe(required(fixture.expected, "converged"));
      expect(result.convergence.iterations).toBe(required(fixture.expected, "iterations"));
      expectAbsoluteClose(
        result.convergence.finalChange,
        required(fixture.expected, "max_change"),
        EM_TOLERANCE,
      );
      result.estimates.items.forEach((item, itemIndex) => {
        compareVector(
          item.groupSuccessProbabilities,
          expectedItems[itemIndex] ?? [],
          EM_TOLERANCE,
        );
        compareVector(
          item.deltaParameters,
          required(fixture.expected, "delta_parameters")[itemIndex] ?? [],
          EM_TOLERANCE,
        );
        compareVector(
          item.successProbabilities,
          required(fixture.expected, "latent_class_probabilities")[itemIndex] ?? [],
          EM_TOLERANCE,
        );
      });
      compareVector(result.estimates.classProbabilities, expectedPrior, EM_TOLERANCE);
      assertFitStatistics(result, fixture.expected, EM_TOLERANCE);
      expect(result.dimensions.respondents).toBe(
        required(fixture.expected, "observation_count"),
      );
      expect(
        result.estimates.items.reduce(
          (count, item) => count + item.deltaParameters.length,
          0,
        ),
      ).toBe(required(fixture.expected, "item_parameter_count"));
      expect(
        result.priorType === "saturated"
          ? result.estimates.classProbabilities.length - 1
          : 0,
      ).toBe(required(fixture.expected, "prior_parameter_count"));

      const expectedPosterior = required(fixture.expected, "posterior");
      const expectedMap = required(fixture.expected, "map_class");
      const expectedMle = required(fixture.expected, "mle_class");
      const expectedEap = required(fixture.expected, "eap_attributes");
      if (result.scores.posteriorProbabilities === null) {
        throw new Error("full posterior storage unexpectedly returned null");
      }
      compareMatrix(
        result.scores.posteriorProbabilities,
        expandWeightedValues(expectedPosterior, weights),
        EM_TOLERANCE,
      );
      expect(result.scores.mapClassIndices).toEqual(expandWeightedValues(expectedMap, weights));
      expect(result.scores.mleClassIndices).toEqual(expandWeightedValues(expectedMle, weights));
      compareMatrix(
        result.scores.eapAttributeProbabilities,
        expandWeightedValues(expectedEap, weights),
        EM_TOLERANCE,
      );

      const fittedItemProbabilities = result.estimates.items.map(
        (item) => item.groupSuccessProbabilities,
      );
      const uniqueEvaluation = evaluateValidated(
        validateFitInput({
          model: fixture.input.models,
          prior: { probabilities: expectedPrior, type: "fixed" },
          qMatrix: fixture.input.q_matrix,
          responses: fixture.input.responses,
        }),
        fittedItemProbabilities,
        result.estimates.classProbabilities,
      );
      assertCanonicalModelFields(
        fixture,
        required(fixture.expected, "attribute_patterns"),
        required(fixture.expected, "eta"),
      );
      compareMatrix(
        uniqueEvaluation.classSuccessProbabilities,
        required(fixture.expected, "latent_class_probabilities"),
        EM_TOLERANCE,
      );
      compareMatrix(
        uniqueEvaluation.logLikelihoodByClass,
        required(fixture.expected, "conditional_log_likelihood"),
        EM_TOLERANCE,
      );
      compareMatrix(uniqueEvaluation.posteriorProbabilities, expectedPosterior, EM_TOLERANCE);
      compareVector(
        individualMarginalLogLikelihoods(uniqueEvaluation),
        required(fixture.expected, "individual_marginal_log_likelihood"),
        EM_TOLERANCE,
      );
      expect(uniqueEvaluation.mapClassIndices).toEqual(expectedMap);
      expect(uniqueEvaluation.mleClassIndices).toEqual(expectedMle);
      compareMatrix(uniqueEvaluation.eapAttributeProbabilities, expectedEap, EM_TOLERANCE);

      const weightedEvaluation = evaluateValidated(
        validated,
        fittedItemProbabilities,
        result.estimates.classProbabilities,
      );
      expectAbsoluteClose(
        weightedEvaluation.logLikelihood,
        fixture.expected.log_likelihood,
        EM_TOLERANCE,
      );
      compareMatrix(
        weightedEvaluation.expectedCorrect,
        required(fixture.expected, "expected_correct"),
        EM_TOLERANCE,
      );
      compareMatrix(
        weightedEvaluation.expectedTotal,
        required(fixture.expected, "expected_total"),
        EM_TOLERANCE,
      );
    });
  }

  it("matches first-seen row aggregation and raw-versus-aggregated fitting", () => {
    const fixture = readAggregationFixture();
    const aggregation = aggregateResponseRows(fixture.input.raw_responses);

    expect(aggregation.responses).toEqual(fixture.expected.aggregated_responses);
    expect(aggregation.frequencies).toEqual(fixture.expected.frequencies);
    expect(aggregation.originalToUnique).toEqual(fixture.expected.raw_to_unique);
    expect(
      aggregation.originalToUnique.map((unique) => aggregation.responses[unique]),
    ).toEqual(fixture.input.raw_responses);

    const raw = fitAggregationFixture(fixture, false);
    const aggregated = fitAggregationFixture(fixture, true);
    const expectedFit = fixture.expected.fit;

    expect(raw.diagnostics.uniqueResponsePatterns).toBe(fixture.input.raw_responses.length);
    expect(aggregated.diagnostics.uniqueResponsePatterns).toBe(
      fixture.expected.aggregated_responses.length,
    );
    expect(aggregated.convergence.iterations).toBe(required(expectedFit, "iterations"));
    expectAbsoluteClose(
      aggregated.convergence.finalChange,
      required(expectedFit, "max_change"),
      EM_TOLERANCE,
    );

    raw.estimates.items.forEach((rawItem, itemIndex) => {
      const aggregatedItem = aggregated.estimates.items[itemIndex];
      if (aggregatedItem === undefined) throw new Error("missing aggregated item estimate");
      compareVector(
        rawItem.groupSuccessProbabilities,
        aggregatedItem.groupSuccessProbabilities,
        EM_TOLERANCE,
      );
      compareVector(
        aggregatedItem.groupSuccessProbabilities,
        required(expectedFit, "item_group_probabilities")[itemIndex] ?? [],
        EM_TOLERANCE,
      );
      compareVector(
        aggregatedItem.deltaParameters,
        required(expectedFit, "delta_parameters")[itemIndex] ?? [],
        EM_TOLERANCE,
      );
      compareVector(
        aggregatedItem.successProbabilities,
        required(expectedFit, "latent_class_probabilities")[itemIndex] ?? [],
        EM_TOLERANCE,
      );
    });
    compareVector(
      raw.estimates.classProbabilities,
      aggregated.estimates.classProbabilities,
      EM_TOLERANCE,
    );
    compareVector(
      aggregated.estimates.classProbabilities,
      required(expectedFit, "class_prior"),
      EM_TOLERANCE,
    );
    expectAbsoluteClose(
      raw.statistics.logLikelihood,
      aggregated.statistics.logLikelihood,
      EM_TOLERANCE,
    );
    assertFitStatistics(aggregated, expectedFit, EM_TOLERANCE);

    if (
      raw.scores.posteriorProbabilities === null ||
      aggregated.scores.posteriorProbabilities === null
    ) {
      throw new Error("aggregation parity requires full posterior storage");
    }
    compareMatrix(
      raw.scores.posteriorProbabilities,
      aggregated.scores.posteriorProbabilities,
      FIXED_TOLERANCE,
    );
    compareMatrix(
      aggregated.scores.posteriorProbabilities,
      required(expectedFit, "posterior"),
      EM_TOLERANCE,
    );
    expect(aggregated.scores.mapClassIndices).toEqual(required(expectedFit, "map_class"));
    expect(aggregated.scores.mleClassIndices).toEqual(required(expectedFit, "mle_class"));
    compareMatrix(
      aggregated.scores.eapAttributeProbabilities,
      required(expectedFit, "eap_attributes"),
      EM_TOLERANCE,
    );

    expect(fixture.expected.max_absolute_item_probability_difference).toBeLessThanOrEqual(
      EM_TOLERANCE,
    );
    expect(fixture.expected.absolute_log_likelihood_difference).toBeLessThanOrEqual(
      EM_TOLERANCE,
    );
    expect(fixture.expected.max_absolute_expanded_posterior_difference).toBeLessThanOrEqual(
      FIXED_TOLERANCE,
    );
  });

  it("executes every explicit deterministic-multistart-dina candidate", () => {
    const path = new URL(
      "../../../fixtures/v1/deterministic-multistart-dina.json",
      import.meta.url,
    );
    const fixture = JSON.parse(readFileSync(path, "utf8")) as {
      input: {
        q_matrix: number[][];
        responses: ResponseInputValue[][];
        response_weights: number[];
        models: ItemModel[];
        candidate_initial_item_group_probabilities: number[][][];
        prior: { initial_probabilities: number[] };
        options: FixtureOptions;
      };
      expected: {
        candidate_initial_log_likelihoods: number[];
        selected_candidate: number;
        fit: {
          converged: boolean;
          iterations: number;
          item_group_probabilities: number[][];
          class_prior: number[];
        };
      };
    };
    const result = fitValidated(
      validateFitInput({
        responses: expandWeightedRows(
          fixture.input.responses,
          fixture.input.response_weights,
        ),
        qMatrix: fixture.input.q_matrix,
        model: fixture.input.models,
        prior: {
          type: "saturated",
          initialProbabilities: fixture.input.prior.initial_probabilities,
        },
        estimation: {
          aggregateRows: true,
          convergenceTolerance: fixture.input.options.convergence_tolerance,
          initialization: {
            initialItemProbabilityCandidates:
              fixture.input.candidate_initial_item_group_probabilities,
          },
          maxIterations: fixture.input.options.max_iterations,
          posteriorStorage: "scores-only",
          probabilityBounds: fixture.input.options.probability_bounds,
          smallSampleCorrection: fixture.input.options.correction,
        },
      }),
    );

    expect(result.convergence.starts).toHaveLength(
      fixture.input.candidate_initial_item_group_probabilities.length,
    );
    compareVector(
      result.convergence.starts.map((start) => start.initialLogLikelihood),
      fixture.expected.candidate_initial_log_likelihoods,
      1e-10,
    );
    expect(result.convergence.selectedStartIndex).toBe(fixture.expected.selected_candidate);
    expect(result.convergence.converged).toBe(fixture.expected.fit.converged);
    expect(result.convergence.iterations).toBe(fixture.expected.fit.iterations);
    result.estimates.items.forEach((item, itemIndex) =>
      compareVector(
        item.groupSuccessProbabilities,
        fixture.expected.fit.item_group_probabilities[itemIndex] ?? [],
        EM_TOLERANCE,
      ),
    );
    compareVector(
      result.estimates.classProbabilities,
      fixture.expected.fit.class_prior,
      EM_TOLERANCE,
    );
  });
});

function assertCanonicalModelFields(
  fixture: OracleFixture,
  expectedPatterns: readonly (readonly number[])[],
  expectedEta: readonly (readonly number[])[],
): void {
  const attributes = fixture.input.q_matrix[0]?.length ?? 0;
  const patterns = attributePatterns(attributes);
  expect(patterns).toEqual(expectedPatterns);
  const qMatrix = fixture.input.q_matrix as readonly (readonly BinaryValue[])[];
  expect(parameterLocations(qMatrix, patterns)).toEqual(expectedEta);
  const expectedDesign = required(fixture.expected, "design_matrices");
  const actualDesign = fixture.input.q_matrix.map((qRow, item) =>
    itemDesignMatrix(
      qRow.reduce((sum, requiredAttribute) => sum + requiredAttribute, 0),
      fixture.input.models[item] ?? "GDINA",
    ),
  );
  expect(actualDesign).toEqual(expectedDesign);
}

function assertFitStatistics(
  result: FitResult,
  expected: FixtureExpected,
  tolerance: number,
): void {
  expectAbsoluteClose(result.statistics.logLikelihood, expected.log_likelihood, tolerance);
  expectAbsoluteClose(result.statistics.deviance, required(expected, "deviance"), tolerance);
  expectAbsoluteClose(result.statistics.aic, required(expected, "aic"), tolerance);
  expectAbsoluteClose(result.statistics.bic, required(expected, "bic"), tolerance);
  expect(result.statistics.estimatedParameterCount).toBe(
    required(expected, "parameter_count"),
  );
}

function fitAggregationFixture(
  fixture: AggregationFixture,
  aggregateRows: boolean,
): FitResult {
  return fitValidated(
    validateFitInput({
      estimation: {
        aggregateRows,
        convergenceTolerance: fixture.input.options.convergence_tolerance,
        initialization: {
          initialItemProbabilities: fixture.input.initial_item_group_probabilities,
          starts: 1,
        },
        maxIterations: fixture.input.options.max_iterations,
        posteriorStorage: "full",
        probabilityBounds: fixture.input.options.probability_bounds,
        smallSampleCorrection: fixture.input.options.correction,
      },
      model: fixture.input.models,
      prior: fixturePrior(fixture.input.prior),
      qMatrix: fixture.input.q_matrix,
      responses: fixture.input.raw_responses,
    }),
  );
}

function fixturePrior(prior: FixturePrior): NonNullable<FitInput["prior"]> {
  const probabilities = prior.initial_probabilities ?? [];
  return prior.mode === "fixed"
    ? { probabilities, type: "fixed" }
    : { initialProbabilities: probabilities, type: "saturated" };
}

function individualMarginalLogLikelihoods(evaluation: ModelEvaluation): number[] {
  return evaluation.logLikelihoodByClass.map((conditional) =>
    logSumExp(
      conditional.map(
        (logLikelihood, latentClass) =>
          logLikelihood + Math.log(evaluation.classProbabilities[latentClass] ?? 0),
      ),
    ),
  );
}

function logSumExp(values: readonly number[]): number {
  const maximum = Math.max(...values);
  let scaledSum = 0;
  for (const value of values) scaledSum += Math.exp(value - maximum);
  return maximum + Math.log(scaledSum);
}

function readFixture(name: string): OracleFixture {
  const path = new URL(`../../../fixtures/v1/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as OracleFixture;
}

function readAggregationFixture(): AggregationFixture {
  const path = new URL(
    "../../../fixtures/v1/row-aggregation-equivalence.json",
    import.meta.url,
  );
  return JSON.parse(readFileSync(path, "utf8")) as AggregationFixture;
}

function expandWeightedRows(
  rows: readonly (readonly ResponseInputValue[])[],
  weights: readonly number[],
): ResponseInputValue[][] {
  return expandWeightedValues(rows, weights).map((row) => Array.from(row));
}

function expandWeightedValues<T>(values: readonly T[], weights: readonly number[]): T[] {
  const expanded: T[] = [];
  values.forEach((value, index) => {
    const frequency = weights[index] ?? 1;
    for (let copy = 0; copy < frequency; copy += 1) expanded.push(value);
  });
  return expanded;
}

function required<T extends object, K extends keyof T>(value: T, key: K): NonNullable<T[K]> {
  const field = value[key];
  if (field === undefined || field === null) throw new Error(`fixture is missing ${String(key)}`);
  return field as NonNullable<T[K]>;
}

function compareMatrix(
  actual: readonly (readonly number[])[],
  expected: readonly (readonly number[])[],
  tolerance: number,
): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((row, index) => compareVector(row, expected[index] ?? [], tolerance));
}

function compareVector(
  actual: readonly number[],
  expected: readonly number[],
  tolerance: number,
): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => {
    expectAbsoluteClose(value, expected[index] ?? Number.NaN, tolerance);
  });
}

function expectAbsoluteClose(actual: number, expected: number, tolerance: number): void {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}
