import { accountMailPhrase, DAY_MS, errorSummary, mailCountList, utcDay } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, gt, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { mailOperator, type SystemMailer } from "../system-mail.js";

/** The monitor notices that wait for the daily digest instead of mailing the operator at once. */
export type MonitorDigestKind = "destination_parked" | "destination_revoked" | "media_blocked";

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

/** A vouch ending this soon is named in every digest until it ends. */
export const VOUCH_ENDING_NOTICE_MS = 3 * DAY_MS;

/**
 * One mail to the operator with every team's counts since the last digest,
 * by kind of notice, never the mail's own words, and the vouches that end
 * within VOUCH_ENDING_NOTICE_MS; nothing when there are none. The delete is
 * the claim: a second worker gets no rows. When the mail fails the counts go
 * back, added to any noted since, for the next digest. Returns how many
 * teams it named.
 */
export async function sendMonitorDigest(
  db: Db,
  deps: { mailer?: SystemMailer | undefined; appBaseUrl?: string | undefined; now?: Date },
): Promise<number> {
  const { mailer } = deps;
  if (!mailer) return 0;
  const now = deps.now ?? new Date();
  const d = schema.monitorDigest;
  const tm = schema.teamMonitor;
  const ending = await db
    .select({ teamId: tm.teamId, until: tm.vouchUntil })
    .from(tm)
    .where(
      and(
        isNotNull(tm.vouchedAt),
        gt(tm.vouchUntil, now),
        lte(tm.vouchUntil, new Date(now.getTime() + VOUCH_ENDING_NOTICE_MS)),
      ),
    );
  const items = await db.delete(d).returning();
  if (items.length === 0 && ending.length === 0) return 0;
  try {
    return await mailDigest(db, mailer, deps.appBaseUrl, items, ending);
  } catch (err) {
    console.error(`monitor.digest: operator mail failed, counts kept: ${errorSummary(err)}`);
    if (items.length > 0) {
      await db
        .insert(d)
        .values(items)
        .onConflictDoUpdate({
          target: [d.teamId, d.kind],
          set: { count: sql`${d.count} + excluded.count` },
        });
    }
    return 0;
  }
}

async function mailDigest(
  db: Db,
  mailer: SystemMailer,
  appBaseUrl: string | undefined,
  items: (typeof schema.monitorDigest.$inferSelect)[],
  ending: { teamId: string; until: Date | null }[],
): Promise<number> {
  const teams = await db
    .select({ id: schema.teams.id, name: schema.teams.name })
    .from(schema.teams)
    .where(
      inArray(schema.teams.id, [
        ...new Set([...items.map((i) => i.teamId), ...ending.map((v) => v.teamId)]),
      ]),
    );
  const byTeam = teams
    .map((team) => ({
      ...team,
      counts: Object.fromEntries(
        items.filter((i) => i.teamId === team.id).map((i) => [i.kind, i.count]),
      ),
      vouchUntil: ending.find((v) => v.teamId === team.id)?.until ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  await mailOperator(db, mailer, "monitor.digest", "/console/safety", {}, appBaseUrl, (locale) =>
    byTeam.flatMap((team) => {
      const page = `${appBaseUrl ?? ""}/console/safety/${team.id}`;
      return [
        ...(Object.keys(team.counts).length > 0
          ? [
              accountMailPhrase({
                locale,
                kind: "monitor.digest",
                key: "team",
                values: {
                  team: team.name,
                  counts: mailCountList(locale, "monitor.digest", team.counts),
                  page,
                },
              }),
            ]
          : []),
        ...(team.vouchUntil
          ? [
              accountMailPhrase({
                locale,
                kind: "monitor.digest",
                key: "vouch_ending",
                values: { team: team.name, date: utcDay(team.vouchUntil), page },
              }),
            ]
          : []),
      ];
    }),
  );
  return byTeam.length;
}
