import { FitAbortedError, InvalidBackendResultError } from "./errors.js";
import type {
  FitBackend,
  FitInput,
  FitOptions,
  FitResult,
  JGDINA,
  ValidatedFitInput,
} from "./types.js";
import { validateFitInput } from "./validation.js";

export * from "./errors.js";
export * from "./limits.js";
export * from "./types.js";
export * from "./validation.js";

/** Creates an environment-neutral async API around a sync or async backend. */
export function createJGDINA(backend: FitBackend): JGDINA {
  if (
    typeof backend !== "object" ||
    backend === null ||
    typeof backend.id !== "string" ||
    backend.id.length === 0 ||
    typeof backend.fit !== "function"
  ) {
    throw new InvalidBackendResultError(
      "A backend must expose a non-empty id and a fit(input, options) function.",
    );
  }

  return Object.freeze({
    backendId: backend.id,
    validate: validateFitInput,
    async fit(input: FitInput, options?: FitOptions): Promise<FitResult> {
      throwIfAborted(options);
      options?.onProgress?.({ phase: "validation", fraction: 0 });
      const validated = validateFitInput(input);
      throwIfAborted(options);

      const result = await Promise.resolve(backend.fit(validated, options));
      throwIfAborted(options);
      assertValidBackendResult(result, validated, backend.id);
      options?.onProgress?.({ phase: "complete", fraction: 1 });
      return result;
    },
  });
}

export function throwIfAborted(options?: FitOptions): void {
  if (options?.signal?.aborted === true) throw new FitAbortedError();
}

/** Public for adapter authors and tests; createJGDINA invokes it automatically. */
export function assertValidBackendResult(
  result: unknown,
  input: ValidatedFitInput,
  backendId: string,
): asserts result is FitResult {
  if (!isRecord(result)) {
    throw new InvalidBackendResultError("The backend result must be a plain object.");
  }
  if (result["schemaVersion"] !== "1.0") {
    throw new InvalidBackendResultError('The backend result schemaVersion must be "1.0".');
  }
  if (result["backendId"] !== backendId) {
    throw new InvalidBackendResultError(
      `The backend result backendId must match the selected backend (${backendId}).`,
    );
  }
  if (!isRecord(result["dimensions"])) {
    throw new InvalidBackendResultError("The backend result must include dimensions.");
  }
  for (const key of ["respondents", "items", "attributes", "latentClasses"] as const) {
    if (result["dimensions"][key] !== input.dimensions[key]) {
      throw new InvalidBackendResultError(
        `The backend result dimension ${key} does not match the validated input.`,
      );
    }
  }

  assertJsonSafe(result);
}

function assertJsonSafe(value: unknown): void {
  const ancestors = new WeakSet<object>();

  const visit = (current: unknown, path: string): void => {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new InvalidBackendResultError(`${path} must be a finite JSON number.`);
      }
      return;
    }
    if (typeof current !== "object") {
      throw new InvalidBackendResultError(`${path} is not JSON-compatible.`);
    }
    if (ArrayBuffer.isView(current) || current instanceof ArrayBuffer) {
      throw new InvalidBackendResultError(`${path} must use a plain JSON array, not a binary view.`);
    }
    if (ancestors.has(current)) {
      throw new InvalidBackendResultError(`${path} contains a circular reference.`);
    }
    ancestors.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${path}[${index}]`));
    } else {
      const prototype = Object.getPrototypeOf(current) as unknown;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new InvalidBackendResultError(`${path} must be a plain JSON object.`);
      }
      for (const [key, entry] of Object.entries(current)) {
        visit(entry, `${path}.${key}`);
      }
    }
    ancestors.delete(current);
  };

  visit(value, "result");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
