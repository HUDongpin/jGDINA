import type { BinaryValue, ItemModel } from "@jgdina/core";

const assertAttributeCount = (attributes: number): void => {
  if (!Number.isSafeInteger(attributes) || attributes < 0 || attributes > 30) {
    throw new RangeError("attributes must be an integer between 0 and 30");
  }
};

/**
 * Generates GDINA's canonical alpha2 ordering: zero profile, then profiles in
 * increasing mastery count with lexicographically ordered attribute subsets.
 */
export function attributePatterns(attributes: number): BinaryValue[][] {
  assertAttributeCount(attributes);
  const output: BinaryValue[][] = [];
  for (let size = 0; size <= attributes; size += 1) {
    forEachCombination(attributes, size, (indices) => {
      const row = Array<BinaryValue>(attributes).fill(0);
      for (const index of indices) row[index] = 1;
      output.push(row);
    });
  }
  return output;
}

/** Model design columns follow GDINA: intercept, main effects, then interactions. */
export function itemDesignMatrix(
  requiredAttributeCount: number,
  model: ItemModel = "GDINA",
): number[][] {
  assertAttributeCount(requiredAttributeCount);
  if (requiredAttributeCount === 0) {
    if (model !== "GDINA") {
      throw new RangeError("DINA and DINO items must require at least one attribute");
    }
    return [[1]];
  }

  const patterns = attributePatterns(requiredAttributeCount);
  if (model === "DINA") {
    return patterns.map((_, index) => [1, index === patterns.length - 1 ? 1 : 0]);
  }
  if (model === "DINO") {
    return patterns.map((_, index) => [1, index === 0 ? 0 : 1]);
  }

  // In the saturated identity-link GDINA model, design columns correspond to
  // the same ordered subsets as rows. A column is one iff its subset is mastered.
  return patterns.map((profile) =>
    patterns.map((subset) => (isSubset(subset, profile) ? 1 : 0)),
  );
}

/**
 * Maps every item/global-class pair to its zero-based reduced attribute group.
 * The returned matrix is J x 2^K and uses the same ordering as attributePatterns.
 */
export function parameterLocations(
  qMatrix: readonly (readonly BinaryValue[])[],
  patterns: readonly (readonly BinaryValue[])[] = attributePatterns(qMatrix[0]?.length ?? 0),
): number[][] {
  const attributes = qMatrix[0]?.length ?? 0;
  const output: number[][] = [];
  for (let item = 0; item < qMatrix.length; item += 1) {
    const qRow = qMatrix[item];
    if (qRow === undefined || qRow.length !== attributes) {
      throw new RangeError("qMatrix must be rectangular");
    }
    const required: number[] = [];
    for (let k = 0; k < attributes; k += 1) {
      if (qRow[k] === 1) required.push(k);
    }
    const local = attributePatterns(required.length);
    const localIndex = new Map(local.map((row, index) => [row.join(""), index]));
    output.push(
      patterns.map((pattern) => {
        if (pattern.length !== attributes) throw new RangeError("attribute patterns have wrong width");
        const key = required.map((index) => pattern[index] ?? 0).join("");
        const index = localIndex.get(key);
        if (index === undefined) throw new Error("failed to locate a reduced attribute profile");
        return index;
      }),
    );
  }
  return output;
}

/** Converts reduced success probabilities to identity-link model coefficients. */
export function probabilitiesToDelta(
  probabilities: readonly number[],
  model: ItemModel = "GDINA",
): number[] {
  const classCount = probabilities.length;
  const requiredAttributeCount = exactLog2(classCount);

  if (model === "DINA") {
    if (classCount < 2) throw new RangeError("DINA needs at least two reduced classes");
    const guessing = assertTied(probabilities.slice(0, -1), "DINA non-master probabilities");
    return [guessing, (probabilities[classCount - 1] ?? 0) - guessing];
  }
  if (model === "DINO") {
    if (classCount < 2) throw new RangeError("DINO needs at least two reduced classes");
    const nonMaster = probabilities[0] ?? 0;
    const master = assertTied(probabilities.slice(1), "DINO master probabilities");
    return [nonMaster, master - nonMaster];
  }

  const masks = canonicalMasks(requiredAttributeCount);
  const transformed = new Float64Array(classCount);
  for (let canonicalIndex = 0; canonicalIndex < classCount; canonicalIndex += 1) {
    transformed[masks[canonicalIndex] ?? 0] = finite(
      probabilities[canonicalIndex],
      `probabilities[${canonicalIndex}]`,
    );
  }
  // Invert the subset zeta transform in O(K * 2^K).
  for (let attribute = 0; attribute < requiredAttributeCount; attribute += 1) {
    const bit = 1 << attribute;
    for (let mask = 0; mask < classCount; mask += 1) {
      if ((mask & bit) !== 0) {
        transformed[mask] =
          (transformed[mask] ?? 0) - (transformed[mask ^ bit] ?? 0);
      }
    }
  }
  return Array.from(masks, (mask) => transformed[mask] ?? 0);
}

/** Converts identity-link model coefficients to reduced success probabilities. */
export function deltaToProbabilities(
  delta: readonly number[],
  requiredAttributeCount: number,
  model: ItemModel = "GDINA",
): number[] {
  assertAttributeCount(requiredAttributeCount);
  const classCount = 2 ** requiredAttributeCount;
  if (model !== "GDINA") {
    if (requiredAttributeCount === 0) {
      throw new RangeError("DINA and DINO items must require at least one attribute");
    }
    if (delta.length !== 2) throw new RangeError("delta must contain 2 coefficients");
    const intercept = finite(delta[0], "delta[0]");
    const contrast = finite(delta[1], "delta[1]");
    return Array.from({ length: classCount }, (_, index) => {
      const ideal = model === "DINA" ? index === classCount - 1 : index !== 0;
      return intercept + (ideal ? contrast : 0);
    });
  }

  if (delta.length !== classCount) {
    throw new RangeError(`delta must contain ${classCount} coefficients`);
  }
  const masks = canonicalMasks(requiredAttributeCount);
  const transformed = new Float64Array(classCount);
  for (let canonicalIndex = 0; canonicalIndex < classCount; canonicalIndex += 1) {
    transformed[masks[canonicalIndex] ?? 0] = finite(
      delta[canonicalIndex],
      `delta[${canonicalIndex}]`,
    );
  }
  // Apply the subset zeta transform in O(K * 2^K).
  for (let attribute = 0; attribute < requiredAttributeCount; attribute += 1) {
    const bit = 1 << attribute;
    for (let mask = 0; mask < classCount; mask += 1) {
      if ((mask & bit) !== 0) {
        transformed[mask] =
          (transformed[mask] ?? 0) + (transformed[mask ^ bit] ?? 0);
      }
    }
  }
  return Array.from(masks, (mask) => transformed[mask] ?? 0);
}

/** Expands reduced per-item probabilities into a J x 2^K class matrix. */
export function classSuccessProbabilities(
  reducedProbabilities: readonly (readonly number[])[],
  locations: readonly (readonly number[])[],
): number[][] {
  if (reducedProbabilities.length !== locations.length) {
    throw new RangeError("probabilities and locations must contain the same number of items");
  }
  return locations.map((itemLocations, item) => {
    const probabilities = reducedProbabilities[item];
    if (probabilities === undefined) throw new Error("missing item probabilities");
    return itemLocations.map((location) => {
      const probability = probabilities[location];
      if (probability === undefined) throw new RangeError("parameter location is out of range");
      return probability;
    });
  });
}

export function requiredAttributeIndices(qRow: readonly BinaryValue[]): number[] {
  const output: number[] = [];
  for (let index = 0; index < qRow.length; index += 1) {
    if (qRow[index] === 1) output.push(index);
  }
  return output;
}

function isSubset(subset: readonly BinaryValue[], profile: readonly BinaryValue[]): boolean {
  for (let index = 0; index < subset.length; index += 1) {
    if (subset[index] === 1 && profile[index] !== 1) return false;
  }
  return true;
}

function forEachCombination(
  n: number,
  size: number,
  callback: (indices: readonly number[]) => void,
): void {
  const current: number[] = [];
  const visit = (next: number): void => {
    if (current.length === size) {
      callback(current);
      return;
    }
    const remaining = size - current.length;
    for (let index = next; index <= n - remaining; index += 1) {
      current.push(index);
      visit(index + 1);
      current.pop();
    }
  };
  visit(0);
}

function canonicalMasks(attributes: number): Uint32Array {
  const masks = new Uint32Array(2 ** attributes);
  let outputIndex = 0;
  for (let size = 0; size <= attributes; size += 1) {
    forEachCombination(attributes, size, (indices) => {
      let mask = 0;
      for (const attribute of indices) mask |= 1 << attribute;
      masks[outputIndex] = mask >>> 0;
      outputIndex += 1;
    });
  }
  return masks;
}

function exactLog2(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("probability count must be a positive power of two");
  }
  const log = Math.log2(value);
  if (!Number.isInteger(log)) throw new RangeError("probability count must be a power of two");
  return log;
}

function assertTied(values: readonly number[], label: string): number {
  const first = finite(values[0], `${label}[0]`);
  for (let index = 1; index < values.length; index += 1) {
    const value = finite(values[index], `${label}[${index}]`);
    if (Math.abs(value - first) > 1e-10) throw new RangeError(`${label} must be tied`);
  }
  return first;
}

function finite(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}
