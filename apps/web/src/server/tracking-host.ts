import { schema } from "@millionsend/db";
import { and, isNotNull, type SQL, sql } from "drizzle-orm";

/** Domains whose branded tracking host (subdomain + "." + domain name) is `host`, in any case. */
export function trackingHostIs(host: string): SQL | undefined {
  const d = schema.domains;
  return and(
    isNotNull(d.trackingSubdomain),
    sql`lower(${d.trackingSubdomain} || '.' || ${d.name}) = ${host.toLowerCase()}`,
  );
}
