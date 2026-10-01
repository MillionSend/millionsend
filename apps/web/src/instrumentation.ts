import type { Instrumentation } from "next";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { initErrorTracking } = await import("@millionsend/core/error-tracking-node");
  await initErrorTracking("web");
}

/**
 * Server errors, server component render failures included: the browser
 * only ever sees those as React's minified error #441 and a digest, which
 * the tag carries over. Tagged with the route pattern, never the request's
 * path, headers or cookies.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, _request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { captureError } = await import("@millionsend/core/error-tracking-node");
  const digest = typeof error === "object" && error && "digest" in error ? error.digest : undefined;
  await captureError(error, {
    tags: {
      route: context.routePath,
      route_type: context.routeType,
      ...(typeof digest === "string" ? { digest } : {}),
    },
  });
};
