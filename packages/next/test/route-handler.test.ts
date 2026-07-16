import type { FitInput, FitResult } from "@jgdina/core";
import { describe, expect, it, vi } from "vitest";

import {
  createJGDINARouteHandler,
  type JGDINAErrorResponse,
  type JGDINASuccessResponse,
  type RouteJGDINA,
} from "../src/index.js";

const INPUT: FitInput = {
  responses: [[0], [1]],
  qMatrix: [[1]],
  model: "DINA",
};

const RESULT = {
  schemaVersion: "1.0",
  backendId: "fake",
  marker: "result",
} as unknown as FitResult;

function jsonRequest(
  body: string = JSON.stringify(INPUT),
  init: { readonly method?: string; readonly contentType?: string } = {},
): Request {
  return new Request("http://localhost/api/jgdina", {
    method: init.method ?? "POST",
    headers: { "content-type": init.contentType ?? "application/json; charset=utf-8" },
    ...(init.method === "GET" || init.method === "HEAD" ? {} : { body }),
  });
}

async function errorBody(response: Response): Promise<JGDINAErrorResponse> {
  return await response.json() as JGDINAErrorResponse;
}

describe("createJGDINARouteHandler", () => {
  it("rejects non-POST methods before creating the worker-backed engine", async () => {
    const createEngine = vi.fn<() => RouteJGDINA>();
    const route = createJGDINARouteHandler({ createEngine });

    const response = await route.POST(jsonRequest("", { method: "GET" }));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await errorBody(response)).toEqual({
      ok: false,
      error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is supported." },
    });
    expect(createEngine).not.toHaveBeenCalled();
  });

  it("requires a JSON media type before reading the body", async () => {
    const createEngine = vi.fn<() => RouteJGDINA>();
    const route = createJGDINARouteHandler({ createEngine });

    const response = await route.POST(jsonRequest("hello", { contentType: "text/plain" }));

    expect(response.status).toBe(415);
    expect((await errorBody(response)).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(createEngine).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON and non-object JSON", async () => {
    const createEngine = vi.fn<() => RouteJGDINA>();
    const route = createJGDINARouteHandler({ createEngine });

    const malformed = await route.POST(jsonRequest("{"));
    const array = await route.POST(jsonRequest("[]"));

    expect(malformed.status).toBe(400);
    expect((await errorBody(malformed)).error.code).toBe("INVALID_JSON");
    expect(array.status).toBe(400);
    expect((await errorBody(array)).error.code).toBe("INVALID_BODY");
    expect(createEngine).not.toHaveBeenCalled();
  });

  it("enforces the body limit while streaming even without Content-Length", async () => {
    const createEngine = vi.fn<() => RouteJGDINA>();
    const route = createJGDINARouteHandler({ maxBodyBytes: 8, createEngine });
    const request = jsonRequest('{"long":true}');
    request.headers.delete("content-length");

    const response = await route.POST(request);

    expect(response.status).toBe(413);
    expect(await errorBody(response)).toEqual({
      ok: false,
      error: {
        code: "BODY_TOO_LARGE",
        message: "The JSON request body exceeds the 8-byte limit.",
        details: { maxBodyBytes: 8 },
      },
    });
    expect(createEngine).not.toHaveBeenCalled();
  });

  it("maps public fit errors without exposing stacks", async () => {
    const failure = Object.assign(new Error("Invalid input at responses."), {
      code: "INVALID_INPUT",
      details: { issues: [{ path: "responses", code: "required" }] },
    });
    const engine: RouteJGDINA = {
      fit: vi.fn(async () => await Promise.reject(failure)),
    };
    const route = createJGDINARouteHandler({ createEngine: () => engine });

    const response = await route.POST(jsonRequest());
    const body = await errorBody(response);

    expect(response.status).toBe(422);
    expect(body).toEqual({
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Invalid input at responses.",
        details: { issues: [{ path: "responses", code: "required" }] },
      },
    });
    expect(JSON.stringify(body)).not.toContain("stack");
  });

  it("hides messages from unexpected internal failures", async () => {
    const engine: RouteJGDINA = {
      fit: vi.fn(async () => await Promise.reject(new Error("secret worker path"))),
    };
    const route = createJGDINARouteHandler({ createEngine: () => engine });

    const response = await route.POST(jsonRequest());
    const body = await errorBody(response);

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("secret worker path");
  });

  it("lazily reuses one engine, returns results, forwards abort, and cleans up", async () => {
    const fit = vi.fn<RouteJGDINA["fit"]>(async () => RESULT);
    const close = vi.fn(async () => undefined);
    const engine: RouteJGDINA = { fit, close };
    const createEngine = vi.fn(() => engine);
    const route = createJGDINARouteHandler({ createEngine });

    expect(createEngine).not.toHaveBeenCalled();
    const first = await route.POST(jsonRequest());
    const second = await route.POST(jsonRequest());

    expect(first.status).toBe(200);
    expect(await first.json() as JGDINASuccessResponse).toEqual({ ok: true, result: RESULT });
    expect(second.status).toBe(200);
    expect(createEngine).toHaveBeenCalledTimes(1);
    expect(fit).toHaveBeenCalledTimes(2);
    expect(fit.mock.calls[0]?.[0]).toEqual(INPUT);
    expect(fit.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

    const closing = route.close();
    expect(route.close()).toBe(closing);
    await closing;
    expect(close).toHaveBeenCalledTimes(1);

    const afterClose = await route.POST(jsonRequest());
    expect(afterClose.status).toBe(503);
    expect((await errorBody(afterClose)).error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("does not initialize a pool when closed before the first request", async () => {
    const createEngine = vi.fn<() => RouteJGDINA>();
    const route = createJGDINARouteHandler({ createEngine });

    await route.close();

    expect(createEngine).not.toHaveBeenCalled();
  });

  it("validates maxBodyBytes when the handler is created", () => {
    expect(() => createJGDINARouteHandler({ maxBodyBytes: 0 })).toThrow(RangeError);
    expect(() => createJGDINARouteHandler({ maxBodyBytes: 1.5 })).toThrow(RangeError);
  });
});
