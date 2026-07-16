import type {
  FitProgress,
  FitResult,
  ItemModel,
  ValidatedFitInput,
} from "@jgdina/core";

export interface PackedFitInput {
  readonly responses: Float64Array;
  readonly qMatrix: Uint8Array;
  readonly models: readonly ItemModel[];
  readonly prior: ValidatedFitInput["prior"];
  readonly estimation: ValidatedFitInput["estimation"];
  readonly dimensions: ValidatedFitInput["dimensions"];
  readonly missingResponseCount: number;
  readonly memoryEstimate: ValidatedFitInput["memoryEstimate"];
}

export interface FitWorkerRequest {
  readonly type: "fit";
  readonly requestId: number;
  readonly input: PackedFitInput;
}

export type SerializedWorkerError = {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
  readonly details?: unknown;
};

export type FitWorkerResponse =
  | {
      readonly type: "progress";
      readonly requestId: number;
      readonly progress: FitProgress;
    }
  | {
      readonly type: "result";
      readonly requestId: number;
      /** UTF-8 JSON in a transferable buffer; FitResult is JSON-safe by contract. */
      readonly payload: Uint8Array;
    }
  | {
      readonly type: "error";
      readonly requestId: number;
      readonly error: SerializedWorkerError;
    };

export function packValidatedInput(input: ValidatedFitInput): PackedFitInput {
  const { respondents, items, attributes } = input.dimensions;
  const responses = new Float64Array(respondents * items);
  let responseOffset = 0;
  for (const row of input.responses) {
    for (const value of row) {
      responses[responseOffset] = value === null ? Number.NaN : value;
      responseOffset += 1;
    }
  }

  const qMatrix = new Uint8Array(items * attributes);
  let qOffset = 0;
  for (const row of input.qMatrix) {
    for (const value of row) {
      qMatrix[qOffset] = value;
      qOffset += 1;
    }
  }

  return {
    responses,
    qMatrix,
    models: [...input.models],
    prior: input.prior,
    estimation: input.estimation,
    dimensions: input.dimensions,
    missingResponseCount: input.missingResponseCount,
    memoryEstimate: input.memoryEstimate,
  };
}

export function unpackValidatedInput(input: PackedFitInput): ValidatedFitInput {
  const { respondents, items, attributes } = input.dimensions;
  const responses: (0 | 1 | null)[][] = new Array(respondents);
  for (let person = 0; person < respondents; person += 1) {
    const row: (0 | 1 | null)[] = new Array(items);
    for (let item = 0; item < items; item += 1) {
      const value = input.responses[person * items + item];
      row[item] = value === undefined || Number.isNaN(value) ? null : (value as 0 | 1);
    }
    responses[person] = row;
  }

  const qMatrix: (0 | 1)[][] = new Array(items);
  for (let item = 0; item < items; item += 1) {
    const row: (0 | 1)[] = new Array(attributes);
    for (let attribute = 0; attribute < attributes; attribute += 1) {
      row[attribute] = input.qMatrix[item * attributes + attribute] as 0 | 1;
    }
    qMatrix[item] = row;
  }

  return {
    responses,
    qMatrix,
    models: input.models,
    prior: input.prior,
    estimation: input.estimation,
    dimensions: input.dimensions,
    missingResponseCount: input.missingResponseCount,
    memoryEstimate: input.memoryEstimate,
  };
}

export function serializeError(error: unknown): SerializedWorkerError {
  if (error instanceof Error) {
    const extra = error as Error & { code?: string; details?: unknown };
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...(extra.code === undefined ? {} : { code: extra.code }),
      ...(extra.details === undefined ? {} : { details: extra.details }),
    };
  }
  return { name: "Error", message: String(error) };
}

export function deserializeError(error: SerializedWorkerError): Error {
  const reconstructed = new Error(error.message);
  reconstructed.name = error.name;
  if (error.stack !== undefined) reconstructed.stack = error.stack;
  Object.assign(reconstructed, {
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.details === undefined ? {} : { details: error.details }),
  });
  return reconstructed;
}

/** Packs the JSON-safe public result into one transferable ArrayBuffer. */
export function packFitResult(result: FitResult): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(result));
}

/** Restores a result transferred by packFitResult. Core validates it again. */
export function unpackFitResult(payload: Uint8Array): FitResult {
  const value: unknown = JSON.parse(new TextDecoder().decode(payload));
  return value as FitResult;
}
