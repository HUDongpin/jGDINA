import {
  createJGDINA as createCoreJGDINA,
  type FitInput,
  type FitOptions,
  type FitResult,
  type JGDINA,
} from "@jgdina/core";
import { createJsBackend } from "@jgdina/kernels-js";

export * from "@jgdina/core";
export {
  aggregateResponseRows,
  attributePatterns,
  classSuccessProbabilities,
  createJsBackend,
  deltaToProbabilities,
  evaluateValidated,
  fitValidated,
  itemDesignMatrix,
  jsBackend,
  parameterLocations,
  probabilitiesToDelta,
} from "@jgdina/kernels-js";

/** Create an independent standalone jGDINA instance using the pure JS kernel. */
export function createJGDINA(): JGDINA {
  return createCoreJGDINA(createJsBackend());
}

/** Shared stateless convenience instance. */
export const jgdina: JGDINA = createJGDINA();

/** Fit with the default pure TypeScript backend. */
export function fit(input: FitInput, options?: FitOptions): Promise<FitResult> {
  return jgdina.fit(input, options);
}
