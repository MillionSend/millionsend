import { schema } from "@millionsend/db";
import { and, isNotNull, type SQL, sql } from "drizzle-orm";

/**
 * Domains whose branded tracking host (subdomain + "." + domain name) is
 * `host`, in any case and with or without the trailing dot of a fully
 * qualified name, which a browser keeps in Host when the link had it.
 */
export function trackingHostIs(host: string): SQL | undefined {
  const d = schema.domains;
  return and(
    isNotNull(d.trackingSubdomain),
    sql`lower(${d.trackingSubdomain} || '.' || ${d.name}) = ${host.toLowerCase().replace(/\.+$/, "")}`,
  );
}
