import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";

/**
 * Seeing the tracking CNAME resolve clears its 72h clock, which is what lets
 * the worker serve links through the branded host; until then a send ships
 * untracked. Any observer of a live answer may clear it, a read included,
 * scoped to the label that was checked so a subdomain changed while the DNS
 * lookups ran keeps its own fresh clock. Returns true when a clock was cleared.
 */
export async function clearTrackingClock(
  db: Db,
  domain: {
    id: string;
    teamId: string;
    trackingSubdomain: string | null;
    trackingSubdomainSetAt: Date | null;
  },
): Promise<boolean> {
  if (!domain.trackingSubdomain || !domain.trackingSubdomainSetAt) return false;
  const rows = await db
    .update(schema.domains)
    .set({ trackingSubdomainSetAt: null })
    .where(
      and(
        eq(schema.domains.id, domain.id),
        eq(schema.domains.teamId, domain.teamId),
        eq(schema.domains.trackingSubdomain, domain.trackingSubdomain),
      ),
    )
    .returning({ id: schema.domains.id });
  return rows.length > 0;
}
