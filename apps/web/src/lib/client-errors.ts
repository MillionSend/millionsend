import type { ErrorTrackingConfig } from "@millionsend/config";

type Sdk = typeof import("./client-errors-sdk");

let sdk: Promise<Sdk | undefined> | undefined;

/**
 * Fetches the browser SDK, a chunk of its own, on the first call. Only the
 * root layout's tracker calls it, and the layout renders that only with
 * SENTRY_BROWSER_DSN set: without one, no page loads the SDK.
 */
export function startClientErrorTracking(config: ErrorTrackingConfig): void {
  sdk ??= import("./client-errors-sdk").then(
    (loaded) => {
      loaded.start(config);
      return loaded;
    },
    () => undefined,
  );
}

/** For errors an error boundary caught, which never reach the SDK's global handlers. */
export function reportClientError(error: unknown): void {
  void sdk?.then((loaded) => loaded?.captureException(error));
}
