import type {
  BinaryValue,
  ItemModel,
  ResponseValue,
  ValidatedFitInput,
} from "@jgdina/core";
import { attributePatterns, parameterLocations, requiredAttributeIndices } from "./helpers.js";

export interface CompiledModel {
  readonly respondents: number;
  readonly items: number;
  readonly attributes: number;
  readonly classes: number;
  readonly patterns: readonly (readonly BinaryValue[])[];
  readonly flatPatterns: Uint8Array;
  readonly requiredAttributes: readonly (readonly number[])[];
  readonly reducedClassCounts: Int32Array;
  readonly categoryOffsets: Int32Array;
  readonly totalReducedClasses: number;
  /** J x L, row-major. */
  readonly locations: Int32Array;
  readonly models: readonly ItemModel[];
}

export interface AggregatedRows {
  readonly originalRowCount: number;
  readonly uniqueRowCount: number;
  readonly items: number;
  /** U x J row-major; -1 is missing. */
  readonly values: Int8Array;
  readonly frequencies: Float64Array;
  readonly originalToUnique: Int32Array;
}

export interface ParameterState {
  /** Concatenated reduced probabilities, using CompiledModel.categoryOffsets. */
  readonly itemProbabilities: Float64Array;
  readonly classProbabilities: Float64Array;
}

export interface ExpectationResult {
  readonly logLikelihood: number;
  readonly classCounts: Float64Array;
  readonly expectedTotal: Float64Array;
  readonly expectedCorrect: Float64Array;
  readonly posterior: Float64Array | null;
  readonly logLikelihoodByClass: Float64Array | null;
}

export function compileModel(input: ValidatedFitInput): CompiledModel {
  const { respondents, items, attributes, latentClasses: classes } = input.dimensions;
  const patterns = attributePatterns(attributes);
  if (patterns.length !== classes) throw new Error("validated class count is inconsistent");
  const nestedLocations = parameterLocations(input.qMatrix, patterns);
  const locations = new Int32Array(items * classes);
  const reducedClassCounts = new Int32Array(items);
  const categoryOffsets = new Int32Array(items + 1);
  const requiredAttributes: number[][] = [];
  let totalReducedClasses = 0;

  for (let item = 0; item < items; item += 1) {
    const qRow = input.qMatrix[item];
    const rowLocations = nestedLocations[item];
    if (qRow === undefined || rowLocations === undefined) throw new Error("invalid compiled item");
    const required = requiredAttributeIndices(qRow);
    requiredAttributes.push(required);
    const reduced = 2 ** required.length;
    reducedClassCounts[item] = reduced;
    categoryOffsets[item] = totalReducedClasses;
    totalReducedClasses += reduced;
    for (let latentClass = 0; latentClass < classes; latentClass += 1) {
      locations[item * classes + latentClass] = rowLocations[latentClass] ?? 0;
    }
  }
  categoryOffsets[items] = totalReducedClasses;

  const flatPatterns = new Uint8Array(classes * attributes);
  for (let latentClass = 0; latentClass < classes; latentClass += 1) {
    const pattern = patterns[latentClass];
    if (pattern === undefined) throw new Error("missing attribute pattern");
    for (let attribute = 0; attribute < attributes; attribute += 1) {
      flatPatterns[latentClass * attributes + attribute] = pattern[attribute] ?? 0;
    }
  }

  return {
    attributes,
    categoryOffsets,
    classes,
    flatPatterns,
    items,
    locations,
    models: input.models,
    patterns,
    reducedClassCounts,
    requiredAttributes,
    respondents,
    totalReducedClasses,
  };
}

export function responseCode(value: ResponseValue): -1 | 0 | 1 {
  return value === null ? -1 : value;
}
