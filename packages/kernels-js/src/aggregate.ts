import type { ResponseInputValue, ResponseValue } from "@jgdina/core";
import type { AggregatedRows } from "./internal.js";
import { responseCode } from "./internal.js";

export interface AggregatedResponseRows {
  readonly responses: readonly (readonly ResponseValue[])[];
  readonly frequencies: readonly number[];
  readonly originalToUnique: readonly number[];
}

/**
 * Aggregates identical response rows. null is encoded explicitly, so missing
 * values cannot collide with 0/1 or with textual number formatting.
 */
export function aggregateResponseRows(
  responses: readonly (readonly ResponseInputValue[])[],
): AggregatedResponseRows {
  const normalized = normalizePublicResponses(responses);
  const internal = aggregateRowsInternal(normalized, true);
  return {
    frequencies: Array.from(internal.frequencies),
    originalToUnique: Array.from(internal.originalToUnique),
    responses: decodeRows(internal),
  };
}

function normalizePublicResponses(
  responses: readonly (readonly ResponseInputValue[])[],
): ResponseValue[][] {
  if (responses.length === 0) return [];
  const items = responses[0]?.length ?? 0;
  return responses.map((row, rowIndex) => {
    if (row.length !== items) throw new RangeError("responses must be rectangular");
    return row.map((value, itemIndex): ResponseValue => {
      if (value === 0 || value === 1) return value;
      if (value === null || Number.isNaN(value)) return null;
      throw new RangeError(`responses[${rowIndex}][${itemIndex}] must be 0, 1, null, or NaN`);
    });
  });
}

export function aggregateRowsInternal(
  responses: readonly (readonly ResponseValue[])[],
  aggregate: boolean,
): AggregatedRows {
  const originalRowCount = responses.length;
  const items = responses[0]?.length ?? 0;
  const originalToUnique = new Int32Array(originalRowCount);

  if (!aggregate) {
    const values = new Int8Array(originalRowCount * items);
    const frequencies = new Float64Array(originalRowCount);
    frequencies.fill(1);
    for (let row = 0; row < originalRowCount; row += 1) {
      const source = responses[row];
      if (source === undefined) throw new Error("missing response row");
      originalToUnique[row] = row;
      for (let item = 0; item < items; item += 1) {
        values[row * items + item] = responseCode(source[item] ?? null);
      }
    }
    return {
      frequencies,
      items,
      originalRowCount,
      originalToUnique,
      uniqueRowCount: originalRowCount,
      values,
    };
  }

  const keys = new Map<string, number>();
  const uniqueValues: number[] = [];
  const counts: number[] = [];
  for (let row = 0; row < originalRowCount; row += 1) {
    const source = responses[row];
    if (source === undefined) throw new Error("missing response row");
    let key = "";
    const encoded = new Int8Array(items);
    for (let item = 0; item < items; item += 1) {
      const code = responseCode(source[item] ?? null);
      encoded[item] = code;
      // Fixed-width one-character tokens make separators unnecessary.
      key += code === -1 ? "?" : code === 0 ? "0" : "1";
    }
    let unique = keys.get(key);
    if (unique === undefined) {
      unique = counts.length;
      keys.set(key, unique);
      counts.push(0);
      for (const value of encoded) uniqueValues.push(value);
    }
    counts[unique] = (counts[unique] ?? 0) + 1;
    originalToUnique[row] = unique;
  }

  return {
    frequencies: Float64Array.from(counts),
    items,
    originalRowCount,
    originalToUnique,
    uniqueRowCount: counts.length,
    values: Int8Array.from(uniqueValues),
  };
}

function decodeRows(rows: AggregatedRows): ResponseValue[][] {
  const output: ResponseValue[][] = [];
  for (let row = 0; row < rows.uniqueRowCount; row += 1) {
    const decoded: ResponseValue[] = [];
    for (let item = 0; item < rows.items; item += 1) {
      const value = rows.values[row * rows.items + item];
      decoded.push(value === -1 ? null : value === 1 ? 1 : 0);
    }
    output.push(decoded);
  }
  return output;
}
