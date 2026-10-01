import type { ErrorTrackingConfig } from "@millionsend/config";
import { CLIENT_ERRORS_PATH, errorTrackingOptions } from "@millionsend/core/error-tracking";
import {
  breadcrumbsIntegration,
  browserTracingIntegration,
  dedupeIntegration,
  eventFiltersIntegration,
  globalHandlersIntegration,
  httpContextIntegration,
  init,
  linkedErrorsIntegration,
} from "@sentry/browser";

export { captureException } from "@sentry/browser";

export function start(config: ErrorTrackingConfig): void {
  init({
    ...errorTrackingOptions(config),
    tunnel: CLIENT_ERRORS_PATH,
    initialScope: { tags: { process: "browser" } },
    integrations: [
      globalHandlersIntegration(),
      linkedErrorsIntegration(),
      dedupeIntegration(),
      eventFiltersIntegration(),
      breadcrumbsIntegration(),
      httpContextIntegration(),
      ...(config.tracesSampleRate > 0 ? [browserTracingIntegration()] : []),
    ],
  });
}
