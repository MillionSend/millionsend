import { errorTrackingConfig } from "@millionsend/config";
import { getEnvelopeEndpointWithUrlEncodedAuth, makeDsn } from "@sentry/core";

/** Bugsink's default cap on one event; a browser report is a fraction of it. */
const MAX_ENVELOPE_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
/** What the browser SDK backs off on: Bugsink answers every envelope with a no-traces limit. */
const RATE_LIMIT_HEADERS = ["x-sentry-rate-limits", "retry-after"];

/**
 * The browser SDK's tunnel (CLIENT_ERRORS_PATH). Envelopes reach the DSN's
 * host from this server, so the page needs no Content-Security-Policy
 * exception and a visitor's address is never handed to the tracker. Always
 * forwarded to the configured project, whatever DSN an envelope names.
 */
export async function POST(request: Request): Promise<Response> {
  const config = errorTrackingConfig("browser");
  const dsn = config ? makeDsn(config.dsn) : undefined;
  if (!dsn) return new Response(null, { status: 404 });
  const length = Number(request.headers.get("content-length"));
  if (!(length > 0 && length <= MAX_ENVELOPE_BYTES)) return new Response(null, { status: 413 });
  try {
    const upstream = await fetch(getEnvelopeEndpointWithUrlEncodedAuth(dsn), {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body: await request.arrayBuffer(),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const headers = new Headers();
    for (const name of RATE_LIMIT_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(null, { status: upstream.status, headers });
  } catch {
    return new Response(null, { status: 502 });
  }
}
