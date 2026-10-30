import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, count, eq, gte, isNull, sql } from "drizzle-orm";
import { riskAt, teamMonitorRow } from "./abuse-monitor.js";
import { auditRow } from "./audit.js";
import {
  type DeliverabilityHealth,
  fetchDeliverabilityHealth,
  PAUSE_WINDOW_DAYS,
  type PauseLiftRefusal,
  pauseLiftCooldownEnd,
  pauseLiftRefusal,
} from "./deliverability.js";
import { clearNotifications } from "./notifications.js";
import { freePoolOwner } from "./plans.js";
import { windowStartDay } from "./utc-day.js";

export interface PauseLiftStanding {
  refusal: PauseLiftRefusal | null;
  health: DeliverabilityHealth;
  /** The pause window's first UTC day: a lift snapshots the counter rows from it on. */
  since: string;
  /** Mail parked while paused, which the drain sends once the pause lifts. */
  parked: number;
  lastLiftAt: Date | null;
  nextLiftAt: Date | null;
  name: string;
}

/**
 * Whether an operator may lift the team's deliverability pause and what a
 * lift would leave out, read the same way for the review page and the lift.
 * `monitorFlagRisk` is monitorFlagLine's.
 */
export async function pauseLiftStanding(
  db: Db,
  teamId: string,
  opts: { now: Date; monitorFlagRisk: number },
): Promise<PauseLiftStanding> {
  const { now } = opts;
  const t = schema.teams;
  const [team] = await db
    .select({
      name: t.name,
      suspendedAt: t.suspendedAt,
      plan: t.plan,
      currentPeriodEnd: t.currentPeriodEnd,
      poolOwnerId: t.poolOwnerId,
      broadcastsPausedByOperatorAt: t.broadcastsPausedByOperatorAt,
    })
    .from(t)
    .where(eq(t.id, teamId));
  if (!team) throw new Error(`team ${teamId} not found`);
  const health = await fetchDeliverabilityHealth(db, teamId, { now });
  const f = schema.teamFlags;
  const [openFlag] = await db
    .select({ reason: f.reason, openedBy: f.openedBy })
    .from(f)
    .where(and(eq(f.teamId, teamId), eq(f.status, "open")));
  const a = schema.auditLog;
  const [last] = await db
    .select({ at: sql<Date | null>`max(${a.createdAt})`.mapWith(a.createdAt) })
    .from(a)
    .where(and(eq(a.teamId, teamId), eq(a.action, "team.sending_pause_lifted")));
  const e = schema.emails;
  const [parked] = await db
    .select({ n: count() })
    .from(e)
    .where(
      and(
        eq(e.teamId, teamId),
        eq(e.latestStatus, "queued_quota"),
        isNull(e.parkReason),
        // Broadcast rows also wait on an operator's broadcast pause.
        team.broadcastsPausedByOperatorAt ? isNull(e.broadcastId) : undefined,
      ),
    );
  const lastLiftAt = last?.at ?? null;
  return {
    refusal: pauseLiftRefusal({
      suspended: team.suspendedAt !== null,
      freePool: freePoolOwner(team, now) !== null,
      reasons: health.reasons,
      openFlag: openFlag ?? null,
      monitorRisk: riskAt(await teamMonitorRow(db, teamId), now),
      monitorFlagRisk: opts.monitorFlagRisk,
      lastLiftAt,
      now,
    }),
    health,
    since: windowStartDay(PAUSE_WINDOW_DAYS, now),
    parked: parked?.n ?? 0,
    lastLiftAt,
    nextLiftAt: lastLiftAt ? pauseLiftCooldownEnd(lastLiftAt) : null,
    name: team.name,
  };
}

/**
 * Lifts a deliverability pause on bounces: the pause window's sends and hard
 * bounces are copied into the excluded columns the guardrail and the score
 * subtract, so the window counts afresh from the next send against the same
 * lines. The refusal is checked again under the team row's lock, and the
 * snapshot, its audit row and a fresh notice episode commit together; the
 * owners' mail and the drain are the caller's.
 */
export async function liftDeliverabilityPause(
  db: Db,
  input: {
    teamId: string;
    operatorUserId: string;
    reference: string;
    note: string;
    /** Whether the caller mails the owners, for the audit row. */
    notified: boolean;
    monitorFlagRisk: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    // No key update: a send or an SES event holding this team's counter row
    // checks the team row as a foreign key, which FOR UPDATE would block
    // while the snapshot below waits on that counter row.
    await t
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(eq(schema.teams.id, input.teamId))
      .for("no key update");
    const standing = await pauseLiftStanding(t, input.teamId, {
      now,
      monitorFlagRisk: input.monitorFlagRisk,
    });
    if (standing.refusal) return { refusal: standing.refusal };
    const uc = schema.usageCounters;
    // ponytail: a bounce landing after the lift for mail sent before it counts
    // against the fresh window; credit those at bounce time if lifted teams
    // re-pause on leftovers.
    const rows = await t
      .update(uc)
      .set({ excludedSent: sql`${uc.sent}`, excludedHardBounced: sql`${uc.hardBounced}` })
      .where(and(eq(uc.teamId, input.teamId), gte(uc.day, standing.since)))
      .returning({ sent: uc.excludedSent, hardBounced: uc.excludedHardBounced });
    const sent = rows.reduce((n, r) => n + r.sent, 0);
    const hardBounces = rows.reduce((n, r) => n + r.hardBounced, 0);
    await t.insert(schema.auditLog).values({
      ...auditRow({
        teamId: input.teamId,
        actor: { userId: input.operatorUserId },
        action: "team.sending_pause_lifted",
        target: { type: "team", id: input.teamId },
        // Scalars only: the console's audit detail drops nested values.
        metadata: {
          name: standing.name,
          reference: input.reference,
          note: input.note,
          since: standing.since,
          sent,
          hardBounces,
          notified: input.notified,
        },
      }),
      createdAt: now,
    });
    await clearNotifications(t, { teamId: input.teamId, kind: "deliverability" });
    return { sent, hardBounces, parked: standing.parked };
  });
}
