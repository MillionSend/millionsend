import type { ErrorTrackingConfig } from "@millionsend/config";
import type { Breadcrumb, ErrorEvent, StreamedSpanJSON } from "@sentry/core";
import { API_KEY_PATTERN, MASK, maskEmailLocalParts } from "./mask.js";

/**
 * What every Sentry SDK this app starts (server processes and the dashboard's
 * browser code) is configured with, and the scrubber all of their events pass
 * through. Pure, with no node imports, so browser code can use it.
 */

/**
 * Where the browser SDK posts its envelopes: this app's own origin, which the
 * build-time Content-Security-Policy allows, unlike the DSN's host.
 */
export const CLIENT_ERRORS_PATH = "/api/client-errors";

/**
 * A URL or an absolute path inside free text, its query running to the next
 * whitespace whatever it holds. No word boundary before the scheme: a link
 * glued to the word before it is still a link. A slash after a word
 * character is a fraction or an "and/or", not a path.
 */
const URL_IN_TEXT = /(?:[a-z][a-z0-9+.-]*:\/\/|(?<![\w.~:/-])\/)[^\s"'`<>()[\]{}?#]*(?:[?#]\S*)?/gi;
const URL_PARTS = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)?([^?#]*)/i;
/**
 * A route word (connected-apps) or a tRPC procedure path (emails.list or a
 * batch of them); any other segment may be a token or an address.
 */
const PLAIN_SEGMENT =
  /^[a-z]+(?:-[a-z]+)*$|^[a-z]+(?:[A-Z][a-z]+)*(?:[.,][a-z]+(?:[A-Z][a-z]+)*)+$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** Deeper than any event or breadcrumb shape; a cycle stops here, masked. */
const MAX_DEPTH = 10;

function keepSegment(segment: string): boolean {
  return segment === "" || UUID.test(segment) || PLAIN_SEGMENT.test(segment);
}

/**
 * The query and fragment go whole: a tRPC query carries the procedure's
 * input. Path segments go when they could be a token (an unsubscribe or
 * invite link names its capability there) or an address.
 */
function scrubUrl(url: string): string {
  const [, origin = "", path = ""] = URL_PARTS.exec(url) ?? [];
  const segments = path.split("/").map((segment) => (keepSegment(segment) ? segment : MASK));
  return origin + segments.join("/");
}

/** Addresses keep only their domain, API keys go, and every URL is cut as above. */
export function scrubText(text: string): string {
  return maskEmailLocalParts(text.replace(API_KEY_PATTERN, MASK)).replace(URL_IN_TEXT, scrubUrl);
}

function scrubValue<T>(value: T, depth = 0): T {
  if (typeof value === "string") return scrubText(value) as T;
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return MASK as T;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1)) as T;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, scrubValue(item, depth + 1)]),
  ) as T;
}

/**
 * The request keeps its URL, cut, its method and its user agent: never a
 * body, a query, a cookie or another header (Authorization, x-api-key and
 * Cookie included). No user is ever attached, and no frame's local variables.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  delete event.user;
  if (event.request) {
    const { url, method, headers = {} } = event.request;
    const userAgent = Object.entries(headers).find(([name]) => /^user-agent$/i.test(name))?.[1];
    event.request = {
      ...(url ? { url: scrubText(url) } : {}),
      ...(method ? { method } : {}),
      ...(userAgent ? { headers: { "User-Agent": userAgent } } : {}),
    };
  }
  if (event.message) event.message = scrubText(event.message);
  if (event.logentry) event.logentry = scrubValue(event.logentry);
  if (event.transaction) event.transaction = scrubText(event.transaction);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars;
  }
  if (event.extra) event.extra = scrubValue(event.extra);
  if (event.contexts) event.contexts = scrubValue(event.contexts);
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  return event;
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  return {
    ...breadcrumb,
    ...(breadcrumb.message ? { message: scrubText(breadcrumb.message) } : {}),
    ...(breadcrumb.data ? { data: scrubValue(breadcrumb.data) } : {}),
  };
}

export function scrubSpan(span: StreamedSpanJSON): StreamedSpanJSON {
  return { ...span, name: scrubText(span.name), attributes: scrubValue(span.attributes) };
}

/**
 * Errors only unless a trace rate is set: no sessions, client reports,
 * replay or profiling, which Bugsink drops, and no trace headers on outgoing
 * requests, which would reach customers' webhook endpoints. Every callback
 * the SDK offers runs the scrubber. `dataCollection` is spelled out because
 * the SDK's defaults collect cookies, headers, bodies and user data.
 */
export function errorTrackingOptions(config: ErrorTrackingConfig) {
  return {
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    defaultIntegrations: false as const,
    sendClientReports: false,
    enhanceFetchErrorMessages: false as const,
    tracePropagationTargets: [],
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
    ...(config.tracesSampleRate > 0
      ? { tracesSampleRate: config.tracesSampleRate, beforeSendSpan: scrubSpan }
      : {}),
  };
}
