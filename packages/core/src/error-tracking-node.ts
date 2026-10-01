import { errorTrackingConfig } from "@millionsend/config";
import { errorTrackingOptions } from "./error-tracking.js";

export type ServerProcess = "web" | "api" | "worker";

/**
 * Starts the Node SDK in this process when SENTRY_DSN is set. Without it the
 * SDK is never imported, so an instance that does not track errors pays
 * nothing for it.
 */
export async function initErrorTracking(
  name: ServerProcess,
  config = errorTrackingConfig("server"),
): Promise<void> {
  if (!config) return;
  const Sentry = await import("@sentry/node");
  Sentry.init({
    ...errorTrackingOptions(config),
    initialScope: { tags: { process: name } },
    integrations: [
      Sentry.dedupeIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.contextLinesIntegration(),
      Sentry.nodeContextIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
      // Next.js keeps serving past an unhandled rejection by design; the api
      // and the worker exit on one, as Node does without a listener.
      Sentry.onUnhandledRejectionIntegration({ mode: name === "web" ? "none" : "strict" }),
      ...(config.tracesSampleRate > 0
        ? [Sentry.httpIntegration({ sessions: false, breadcrumbs: false })]
        : []),
    ],
  });
}

/**
 * Reports an error the process handled itself (a failed job, a 500). Reads
 * the DSN rather than a flag set by initErrorTracking: Next.js bundles this
 * module once per route, while the SDK, loaded from node_modules, is shared.
 */
export async function captureError(
  error: unknown,
  scope: { teamId?: string | null | undefined; tags?: Record<string, string> } = {},
): Promise<void> {
  if (!errorTrackingConfig("server")) return;
  try {
    const { captureException } = await import("@sentry/node");
    captureException(error, {
      tags: { ...scope.tags, ...(scope.teamId ? { team_id: scope.teamId } : {}) },
    });
  } catch {
    // Callers fire and forget: a rejection here would be an unhandled one,
    // which ends the api and the worker. An SDK that cannot load already
    // failed initErrorTracking at boot.
  }
}
