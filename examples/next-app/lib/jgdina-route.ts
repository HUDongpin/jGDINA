import { createJGDINARouteHandler } from "@jgdina/next";

const route = createJGDINARouteHandler({
  maxBodyBytes: 1_048_576,
  node: { size: 1 },
});

export const handleJGDINAPost = route.POST;

/** Available to integration tests or controlled server-shutdown hooks. */
export const closeJGDINARoute = route.close;
