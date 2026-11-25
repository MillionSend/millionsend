import { isCloudDeployment } from "@millionsend/config";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { monitorRowWithHistory, peekMonitorRow } from "./abuse-monitor.js";
import { addWithinLimit } from "./domain-warmup.js";
import { instanceSettings } from "./monitor-settings.js";
import { DAY_MS } from "./utc-day.js";

/**
 * The new-account limit (cloud only): recipients a team may have accepted in
 * each 24-hour window counted from its first send. Window 0 runs against
 * newAccountFirstDay, windows 1 to newAccountDays - 1 against newAccountDaily,
 * and later ones against nothing; a zero setting caps no window. Mail over
 * it parks with reason "new_account" and the quota drain sends it as the
 * limit allows. An operator's bypass lifts it.
 */

export interface NewAccountCap {
  teamId: string;
  dayIndex: number;
  cap: number;
  /** When this window ends and the next one's cap applies. */
  resetsAt: Date;
}

/** An operator's bypass is in force: granted and not yet lapsed or revoked. */
export function limitBypassActive(
  row: { limitBypassAt: Date | null; limitBypassUntil: Date | null },
  now: Date,
): boolean {
  return (
    row.limitBypassAt !== null && (row.limitBypassUntil === null || row.limitBypassUntil > now)
  );
}

/**
 * The cap on the team's accepts at `at`, null when none applies. `readOnly`
 * is for display paths: it never writes the monitor row's history backfill.
 */
export async function newAccountCap(
  db: Db,
  input: { teamId: string; at: Date; readOnly?: boolean },
): Promise<NewAccountCap | null> {
  if (!isCloudDeployment()) return null;
  const s = await instanceSettings(db);
  if (!s.newAccountFirstDay && !s.newAccountDaily) return null;
  const [team] = await db
    .select({ plan: schema.teams.plan })
    .from(schema.teams)
    .where(eq(schema.teams.id, input.teamId));
  if (!team || team.plan === "system") return null;
  const monitor = input.readOnly
    ? await peekMonitorRow(db, input.teamId, input.at)
    : await monitorRowWithHistory(db, input.teamId, input.at);
  if (limitBypassActive(monitor, input.at)) return null;
  // Until the worker records the first send, the window starts now.
  const anchor = monitor.firstSendAt?.getTime() ?? input.at.getTime();
  const dayIndex = Math.max(0, Math.floor((input.at.getTime() - anchor) / DAY_MS));
  if (dayIndex >= s.newAccountDays) return null;
  const cap = dayIndex === 0 ? s.newAccountFirstDay : s.newAccountDaily;
  if (!cap) return null;
  return {
    teamId: input.teamId,
    dayIndex,
    cap,
    resetsAt: new Date(anchor + (dayIndex + 1) * DAY_MS),
  };
}

/**
 * Takes `count` recipients from the window's cap; false, taking nothing, when
 * they do not fit. An email with more recipients than the cap fits only an
 * untouched window, alone: otherwise it could never send while the limit lasts.
 */
export async function reserveNewAccount(
  db: Db,
  cap: NewAccountCap,
  count: number,
): Promise<boolean> {
  const u = schema.teamNewAccountUsage;
  return addWithinLimit(db, {
    counter: u.accepted,
    key: [
      [u.teamId, cap.teamId],
      [u.dayIndex, cap.dayIndex],
    ],
    count,
    limit: Math.max(cap.cap, count),
  });
}

/** Hands back a reservation a later gate refused. */
export async function releaseNewAccount(db: Db, cap: NewAccountCap, count: number): Promise<void> {
  const u = schema.teamNewAccountUsage;
  await db
    .update(u)
    .set({ accepted: sql`greatest(${u.accepted} - ${count}, 0)` })
    .where(and(eq(u.teamId, cap.teamId), eq(u.dayIndex, cap.dayIndex)));
}

/**
 * The new-account gate on `count` recipients the plan already admitted:
 * true when the team's window has room (now reserved, with the cap for a
 * later gate to hand back), false when the mail parks.
 */
export async function admitNewAccount(
  db: Db,
  input: { teamId: string; count: number; at: Date },
): Promise<
  { admitted: true; cap: NewAccountCap | null } | { admitted: false; cap: NewAccountCap }
> {
  const cap = await newAccountCap(db, input);
  if (!cap || (await reserveNewAccount(db, cap, input.count))) return { admitted: true, cap };
  return { admitted: false, cap };
}

const tm = schema.teamMonitor;

/** An operator lifts the team's new-account limit until `until`, or until revoked when null. The caller audits it. */
export async function setTeamLimitBypass(
  db: Db,
  input: { teamId: string; by: string; reason: string; until: Date | null; now: Date },
): Promise<void> {
  const bypass = {
    limitBypassAt: input.now,
    limitBypassBy: input.by,
    limitBypassReason: input.reason,
    limitBypassUntil: input.until,
    updatedAt: input.now,
  };
  await db
    .insert(tm)
    .values({ teamId: input.teamId, ...bypass })
    .onConflictDoUpdate({ target: tm.teamId, set: bypass });
}

/** Ends the team's bypass now, if one is in force; the bypass it ended, else null. The caller audits it. */
export async function revokeTeamLimitBypass(
  db: Db,
  input: { teamId: string; now: Date },
): Promise<{ bypassedAt: Date; reason: string | null } | null> {
  const [row] = await db
    .update(tm)
    .set({ limitBypassUntil: input.now, updatedAt: input.now })
    .where(
      and(
        eq(tm.teamId, input.teamId),
        isNotNull(tm.limitBypassAt),
        or(isNull(tm.limitBypassUntil), gt(tm.limitBypassUntil, input.now)),
      ),
    )
    .returning({ bypassedAt: tm.limitBypassAt, reason: tm.limitBypassReason });
  return row?.bypassedAt ? { bypassedAt: row.bypassedAt, reason: row.reason } : null;
}

/**
 * Teams whose mail waits for the new-account limit and whose operator has
 * not been told, each claimed now so the alert goes out once: the team, when
 * it was created, and its sends so far.
 */
export async function claimNewAccountAlerts(
  db: Db,
  now: Date,
): Promise<{ teamId: string; name: string; createdAt: Date; sent: number }[]> {
  const e = schema.emails;
  const t = schema.teams;
  const waiting = await db
    .selectDistinct({ teamId: e.teamId })
    .from(e)
    .leftJoin(tm, eq(tm.teamId, e.teamId))
    .where(
      and(
        eq(e.latestStatus, "queued_quota"),
        eq(e.parkReason, "new_account"),
        isNull(tm.newAccountAlertedAt),
      ),
    );
  const claimed: { teamId: string; name: string; createdAt: Date; sent: number }[] = [];
  for (const { teamId } of waiting) {
    const [row] = await db
      .insert(tm)
      .values({ teamId, newAccountAlertedAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: tm.teamId,
        set: { newAccountAlertedAt: now, updatedAt: now },
        setWhere: isNull(tm.newAccountAlertedAt),
      })
      .returning({ sent: tm.sentTotal });
    if (!row) continue;
    const [team] = await db
      .select({ name: t.name, createdAt: t.createdAt })
      .from(t)
      .where(eq(t.id, teamId));
    if (team) claimed.push({ teamId, ...team, sent: row.sent });
  }
  return claimed;
}
