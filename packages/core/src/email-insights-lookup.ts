import type { Db } from "@millionsend/db";
// Schema via the clean subpath, never the package barrel: the barrel pulls the
// postgres driver (node:net), which breaks client bundles importing this module.
import * as schema from "@millionsend/db/schema";
import { and, eq } from "drizzle-orm";

export type EmailInsightsRow = typeof schema.emailInsights.$inferSelect;

/**
 * THE single insights lookup for an email: API sends store one row keyed by
 * emailId; broadcast fan-out shares ONE broadcastId-keyed row across
 * recipients. Both queries are team-scoped as defense in depth. Rows exist
 * only for emails sent after the feature landed (deliberately no backfill),
 * so null is a normal state, not an error.
 */
export async function fetchEmailInsights(
  db: Db,
  teamId: string,
  ref: { emailId: string; broadcastId: string | null },
): Promise<EmailInsightsRow | null> {
  const i = schema.emailInsights;
  const [byEmail] = await db
    .select()
    .from(i)
    .where(and(eq(i.teamId, teamId), eq(i.emailId, ref.emailId)))
    .limit(1);
  if (byEmail) return byEmail;
  if (ref.broadcastId === null) return null;
  const [byBroadcast] = await db
    .select()
    .from(i)
    .where(and(eq(i.teamId, teamId), eq(i.broadcastId, ref.broadcastId)))
    .limit(1);
  return byBroadcast ?? null;
}
