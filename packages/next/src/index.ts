import type { FitInput, FitOptions, FitResult, MaybePromise } from "@jgdina/core";
import type { NodeWorkerPoolOptions } from "@jgdina/node";

/** Default maximum UTF-8 request-body size: one mebibyte. */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/** The small engine surface needed by the Route Handler. */
export interface RouteJGDINA {
  fit(input: FitInput, options?: FitOptions): Promise<FitResult>;
  close?(): MaybePromise<void>;
}

export interface JGDINARouteHandlerOptions {
  /** Maximum raw UTF-8 JSON request-body bytes. Defaults to 1 MiB. */
  readonly maxBodyBytes?: number;
  /** Options used when lazily creating the reusable Node worker pool. */
  readonly node?: NodeWorkerPoolOptions;
  /** Dependency-injection hook for tests, instrumentation, or a custom engine. */
  readonly createEngine?: () => MaybePromise<RouteJGDINA>;
}

export type JGDINAApiErrorCode =
  | "METHOD_NOT_ALLOWED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "INVALID_CONTENT_LENGTH"
  | "INVALID_JSON"
  | "INVALID_BODY"
  | "BODY_TOO_LARGE"
  | "REQUEST_ABORTED"
  | "SERVICE_UNAVAILABLE"
  | "INVALID_INPUT"
  | "RESOURCE_LIMIT_EXCEEDED"
  | "ABORTED"
  | "NUMERICAL_FAILURE"
  | "INVALID_BACKEND_RESULT"
  | "INTERNAL_ERROR";

export interface JGDINAApiError {
  readonly code: JGDINAApiErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface JGDINASuccessResponse {
  readonly ok: true;
  readonly result: FitResult;
}

export interface JGDINAErrorResponse {
  readonly ok: false;
  readonly error: JGDINAApiError;
}

export type JGDINAApiResponse = JGDINASuccessResponse | JGDINAErrorResponse;

export interface JGDINARouteHandler {
  /** Next.js App Router-compatible POST export; implemented with Web Request/Response. */
  readonly POST: (request: Request) => Promise<Response>;
  /** Permanently stop this handler and close its lazily created worker pool, if any. */
  close(): Promise<void>;
}

interface ErrorDescriptor {
  readonly status: number;
  readonly code: JGDINAApiErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
}

class RequestError extends Error {
  readonly descriptor: ErrorDescriptor;

  constructor(descriptor: ErrorDescriptor) {
    super(descriptor.message);
    this.name = "RequestError";
    this.descriptor = descriptor;
  }
}

/**
 * Create a Node Route Handler with a bounded JSON body and a lazy reusable
 * worker pool. This module intentionally has no runtime dependency on Next.js.
 */
export function createJGDINARouteHandler(
  options: JGDINARouteHandlerOptions = {},
): JGDINARouteHandler {
  const maxBodyBytes = resolveMaxBodyBytes(options.maxBodyBytes);
  const createEngine =
    options.createEngine ?? (async () => {
      const { createNodeJGDINA } = await import("@jgdina/node");
      return createNodeJGDINA(options.node);
    });
  let enginePromise: Promise<RouteJGDINA> | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const acquireEngine = (): Promise<RouteJGDINA> => {
    if (closed) {
      throw new RequestError({
        status: 503,
        code: "SERVICE_UNAVAILABLE",
        message: "The jGDINA fitting service has been closed.",
      });
    }
    if (enginePromise === undefined) {
      const pending = Promise.resolve().then(createEngine);
      enginePromise = pending;
      void pending.catch(() => {
        if (enginePromise === pending) enginePromise = undefined;
      });
    }
    return enginePromise;
  };

  const POST = async (request: Request): Promise<Response> => {
    if (request.method.toUpperCase() !== "POST") {
      return errorResponse({
        status: 405,
        code: "METHOD_NOT_ALLOWED",
        message: "Only POST is supported.",
        headers: { allow: "POST" },
      });
    }

    if (!isJsonMediaType(request.headers.get("content-type"))) {
      return errorResponse({
        status: 415,
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Content-Type must be application/json.",
      });
    }

    try {
      const input = await readBoundedJsonObject(request, maxBodyBytes);
      const engine = await acquireEngine();
      const result = await engine.fit(input as unknown as FitInput, {
        signal: request.signal,
      });
      return jsonResponse({ ok: true, result }, 200);
    } catch (error) {
      return errorResponse(describeError(error));
    }
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    const pending = enginePromise;
    enginePromise = undefined;
    closePromise = (async () => {
      if (pending === undefined) return;
      let engine: RouteJGDINA;
      try {
        engine = await pending;
      } catch {
        // Initialization failures have no pool to clean up.
        return;
      }
      await engine.close?.();
    })();
    return closePromise;
  };

  return Object.freeze({ POST, close });
}

function resolveMaxBodyBytes(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError("maxBodyBytes must be a positive safe integer.");
  }
  return resolved;
}

function isJsonMediaType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" ||
    (mediaType?.startsWith("application/") === true && mediaType.endsWith("+json"));
}

async function readBoundedJsonObject(
  request: Request,
  maxBodyBytes: number,
): Promise<Record<string, unknown>> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const trimmed = declaredLength.trim();
    if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
      throw new RequestError({
        status: 400,
        code: "INVALID_CONTENT_LENGTH",
        message: "Content-Length must be a non-negative safe integer.",
      });
    }
    if (Number(trimmed) > maxBodyBytes) throw bodyTooLarge(maxBodyBytes);
  }

  if (request.body === null) {
    throw invalidJson();
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteLength = 0;
  let text = "";

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBodyBytes) {
        try {
          await reader.cancel();
        } catch {
          // The 413 response is still authoritative if cancellation itself fails.
        }
        throw bodyTooLarge(maxBodyBytes);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (request.signal.aborted) {
      throw new RequestError({
        status: 408,
        code: "REQUEST_ABORTED",
        message: "The request was aborted before fitting completed.",
      });
    }
    throw invalidJson();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw invalidJson();
  }
  if (!isPlainRecord(parsed)) {
    throw new RequestError({
      status: 400,
      code: "INVALID_BODY",
      message: "The JSON body must be an object containing a jGDINA fit input.",
    });
  }
  return parsed;
}

function invalidJson(): RequestError {
  return new RequestError({
    status: 400,
    code: "INVALID_JSON",
    message: "The request body must contain valid UTF-8 JSON.",
  });
}

function bodyTooLarge(maxBodyBytes: number): RequestError {
  return new RequestError({
    status: 413,
    code: "BODY_TOO_LARGE",
    message: `The JSON request body exceeds the ${maxBodyBytes}-byte limit.`,
    details: { maxBodyBytes },
  });
}

function describeError(error: unknown): ErrorDescriptor {
  if (error instanceof RequestError) return error.descriptor;

  const code = readStringProperty(error, "code");
  if (code === "INVALID_INPUT" || code === "RESOURCE_LIMIT_EXCEEDED") {
    return {
      status: 422,
      code,
      message: readStringProperty(error, "message") ?? "The fit input is invalid.",
      ...optionalDetails(readSafeDetails(error)),
    };
  }
  if (code === "ABORTED" || isNamedAbort(error)) {
    return {
      status: 408,
      code: "ABORTED",
      message: "The jGDINA fit was aborted.",
    };
  }
  if (code === "NUMERICAL_FAILURE") {
    return {
      status: 422,
      code,
      message: "The model could not be fitted numerically.",
    };
  }
  if (code === "INVALID_BACKEND_RESULT") {
    return {
      status: 500,
      code,
      message: "The fitting service returned an invalid result.",
    };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "The fitting service encountered an unexpected error.",
  };
}

function isNamedAbort(error: unknown): boolean {
  return readStringProperty(error, "name") === "AbortError";
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return undefined;
  }
  try {
    const property = (value as Record<string, unknown>)[key];
    return typeof property === "string" ? property : undefined;
  } catch {
    return undefined;
  }
}

function readSafeDetails(error: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  let candidate: unknown;
  try {
    candidate = (error as { details?: unknown }).details;
    if (!isPlainRecord(candidate)) return undefined;
    const serialized = JSON.stringify(candidate);
    if (serialized.length > 65_536) return undefined;
    const clone = JSON.parse(serialized) as unknown;
    return isPlainRecord(clone) ? clone : undefined;
  } catch {
    return undefined;
  }
}

function optionalDetails(
  details: Readonly<Record<string, unknown>> | undefined,
): { readonly details?: Readonly<Record<string, unknown>> } {
  return details === undefined ? {} : { details };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function errorResponse(descriptor: ErrorDescriptor): Response {
  return jsonResponse(
    {
      ok: false,
      error: {
        code: descriptor.code,
        message: descriptor.message,
        ...optionalDetails(descriptor.details),
      },
    },
    descriptor.status,
    descriptor.headers,
  );
}

function jsonResponse(
  body: JGDINAApiResponse,
  status: number,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}
