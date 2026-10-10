import type { Instrumentation } from "next";

// The Node SDK is imported inside the nodejs branch, never after an early
// return: next dev also compiles this file for the edge runtime, where
// webpack drops only a branch it can prove dead, and an import it keeps
// pulls @sentry/node (node:child_process) into a bundle that cannot load it.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initErrorTracking } = await import("@millionsend/core/error-tracking-node");
    await initErrorTracking("web");
  }
}

/**
 * Server errors, server component render failures included: the browser
 * only ever sees those as React's minified error #441 and a digest, which
 * the tag carries over. Tagged with the route pattern, never the request's
 * path, headers or cookies.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, _request, context) => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { captureError } = await import("@millionsend/core/error-tracking-node");
    const digest =
      typeof error === "object" && error && "digest" in error ? error.digest : undefined;
    await captureError(error, {
      tags: {
        route: context.routePath,
        route_type: context.routeType,
        ...(typeof digest === "string" ? { digest } : {}),
      },
    });
  }
};
