import { accountMailPhrase, errorSummary, mailCountList } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { inArray, sql } from "drizzle-orm";
import { mailOperator, type SystemMailer } from "../system-mail.js";

/** The monitor notices that wait for the daily digest instead of mailing the operator at once. */
export type MonitorDigestKind =
  | "alert"
  | "destination_parked"
  | "destination_revoked"
  | "media_blocked";

/**
 * Counts one notice toward the team's next digest. A failure is logged, not
 * thrown: the verdict or park that caused it is already committed.
 */
export async function noteForDigest(
  db: Db,
  teamId: string,
  kind: MonitorDigestKind,
): Promise<void> {
  const d = schema.monitorDigest;
  try {
    await db
      .insert(d)
      .values({ teamId, kind })
      .onConflictDoUpdate({ target: [d.teamId, d.kind], set: { count: sql`${d.count} + 1` } });
  } catch (err) {
    console.error(`monitor.digest: ${kind} for team ${teamId} not recorded: ${errorSummary(err)}`);
  }
}

/**
 * One mail to the operator with every team's counts since the last digest,
 * by kind of notice, never the mail's own words; nothing when there are
 * none. The delete is the claim: a second worker gets no rows. A send that
 * fails is logged, not retried. Returns how many teams it named.
 */
export async function sendMonitorDigest(
  db: Db,
  deps: { mailer?: SystemMailer | undefined; appBaseUrl?: string | undefined },
): Promise<number> {
  const items = await db.delete(schema.monitorDigest).returning();
  if (items.length === 0 || !deps.mailer) return 0;
  const teams = await db
    .select({ id: schema.teams.id, name: schema.teams.name })
    .from(schema.teams)
    .where(inArray(schema.teams.id, [...new Set(items.map((i) => i.teamId))]));
  const byTeam = teams
    .map((team) => ({
      ...team,
      counts: Object.fromEntries(
        items.filter((i) => i.teamId === team.id).map((i) => [i.kind, i.count]),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  try {
    await mailOperator(
      db,
      deps.mailer,
      "monitor.digest",
      "/console/safety",
      {},
      deps.appBaseUrl,
      (locale) =>
        byTeam.map((team) =>
          accountMailPhrase({
            locale,
            kind: "monitor.digest",
            key: "team",
            values: {
              team: team.name,
              counts: mailCountList(locale, "monitor.digest", team.counts),
              page: `${deps.appBaseUrl ?? ""}/console/safety/${team.id}`,
            },
          }),
        ),
    );
  } catch (err) {
    console.error(`monitor.digest: operator mail failed: ${errorSummary(err)}`);
  }
  return byTeam.length;
}
