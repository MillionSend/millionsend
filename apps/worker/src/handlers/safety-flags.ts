import {
  computeTeamStandings,
  pruneTeamStandings,
  recordProbes,
  saveTeamStandings,
  syncTeamFlags,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq, sql } from "drizzle-orm";

/**
 * Refresh every active team's standing (score, guardrail, 7-day rates) and
 * open or clear the automatic trust & safety flags from it. The unsubscribed
 * contact count rides along: it is a scan of the contacts table, too heavy
 * for the minute probe and cheap enough every quarter hour.
 */
export async function runSafetyFlags(
  db: Db,
  opts: { now?: Date } = {},
): Promise<{ teams: number; opened: number; cleared: number }> {
  const now = opts.now ?? new Date();
  const previous = await db.select().from(schema.teamStandings);
  const standings = await computeTeamStandings(db, now);
  const flags = await syncTeamFlags(db, standings, now, previous);
  await saveTeamStandings(db, standings, now);
  await pruneTeamStandings(db, now);
  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.contacts)
      .where(eq(schema.contacts.unsubscribed, true));
    await recordProbes(db, [{ probe: "contacts_unsubscribed", value: row?.n ?? 0, ok: true }], now);
  } catch (err) {
    console.warn("safety.flags: contacts_unsubscribed probe failed", err);
  }
  return { teams: standings.length, ...flags };
}
