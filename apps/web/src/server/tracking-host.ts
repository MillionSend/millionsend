import { env } from "@millionsend/config";
import { normalizeHostname } from "@millionsend/core/org-domain";
import { schema } from "@millionsend/db";
import { and, eq, isNotNull, or, type SQL, sql } from "drizzle-orm";

/**
 * Domains holding `host` as their branded tracking host (subdomain + "." +
 * domain name), in any case and with or without the trailing dot of a fully
 * qualified name, which a browser keeps in Host when the link had it. Only a
 * domain that verified holds its host, and it keeps it after losing
 * verification: a claim on a name nobody proved control of holds nothing.
 */
export function holdsTrackingHost(host: string): SQL | undefined {
  const d = schema.domains;
  return and(
    isNotNull(d.trackingSubdomain),
    or(isNotNull(d.verifiedAt), eq(d.status, "verified")),
    sql`lower(${d.trackingSubdomain} || '.' || ${d.name}) = ${host.toLowerCase().replace(/\.+$/, "")}`,
  );
}

/**
 * The branded host a click came in on, or null on this app's own host, which
 * carries the links of every team without a branded host. A tracking edge names
 * the host in X-Tracking-Host, as it rewrites Host to the app's own; without an
 * edge, the reader's Host reaches the app.
 */
export function clickTrackingHost(headers: Headers): string | null {
  const raw = headers.get("x-tracking-host")?.trim() || headers.get("host");
  const parsed = raw ? URL.parse(`http://${raw}`) : null;
  if (!parsed) return null;
  const host = normalizeHostname(parsed.hostname);
  const own = env.APP_BASE_URL ? normalizeHostname(new URL(env.APP_BASE_URL).hostname) : null;
  return host === own ? null : host;
}
