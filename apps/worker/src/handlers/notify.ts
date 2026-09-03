import {
  claimNotification,
  clearNotifications,
  DAY_MS,
  type DeliverabilityReason,
  effectivePlan,
  enqueueTeamWebhookDeliveries,
  fetchDeliverabilityHealth,
  listTeamOwners,
  nextUtcDayStart,
  PAUSE_BOUNCE_RATE,
  PAUSE_COMPLAINT_RATE,
  PLAN_DAILY_LIMIT,
  utcDay,
  WARN_BOUNCE_RATE,
  WARN_COMPLAINT_RATE,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, gt, gte, sql } from "drizzle-orm";
import {
  deliverabilityPausedMail,
  deliverabilityWarningMail,
  type MailContent,
  quotaReachedMail,
  quotaWarningMail,
} from "../notifications/templates.js";
import type { SystemMailer } from "../system-mail.js";

export interface NotifyDeps {
  isCloud: boolean;
  mailer: SystemMailer;
  enqueueWebhook: (deliveryId: string) => Promise<void>;
  appBaseUrl?: string | undefined;
  now?: Date;
}

/** Share of the daily quota at which owners hear about it. */
export const QUOTA_WARNING_RATIO = 0.8;
/**
 * A deliverability episode ends only once the 7-day rates are this far under
 * the warning lines: a sender hovering at the line would otherwise be
 * re-notified on every crossing, one sweep apart.
 */
export const DELIVERABILITY_CLEAR_RATIO = 0.9;

const lineFor = (r: DeliverabilityReason): number =>
  r.tier === "paused"
    ? r.metric === "bounce"
      ? PAUSE_BOUNCE_RATE
      : PAUSE_COMPLAINT_RATE
    : r.metric === "bounce"
      ? WARN_BOUNCE_RATE
      : WARN_COMPLAINT_RATE;

/**
 * One pass over every team's standing: quota (cloud only) and deliverability.
 * Runs on a schedule rather than inline in the send paths so API, SMTP,
 * broadcast fan-out and the midnight drain share one detector; the claim
 * table makes each notification fire once per period or episode no matter
 * how many passes see the same condition. Returns how many went out.
 */
export async function sweepNotifications(db: Db, deps: NotifyDeps): Promise<{ sent: number }> {
  const now = deps.now ?? new Date();
  const base = deps.appBaseUrl ?? "";
  let sent = 0;

  const notify = async (
    teamId: string,
    type: "quota.warning" | "quota.reached" | "deliverability.warning" | "deliverability.paused",
    data: Record<string, unknown>,
    mail: MailContent,
  ) => {
    // The claim is already taken, so a failing side effect is logged and
    // skipped rather than retried: at-most-once, and one team's broken mail
    // never stops the sweep for the others.
    const attempt = async (what: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        console.error(`notifications.sweep: ${type} for team ${teamId} failed (${what})`, err);
      }
    };
    await attempt("webhook", () =>
      enqueueTeamWebhookDeliveries(db, {
        teamId,
        type,
        occurredAt: now,
        data,
        enqueue: deps.enqueueWebhook,
      }),
    );
    for (const owner of await listTeamOwners(db, teamId)) {
      await attempt(`mail to ${owner.email}`, () => deps.mailer.send(owner.email, mail));
    }
    sent += 1;
  };

  if (deps.isCloud) {
    const today = utcDay(now.getTime());
    const rows = await db
      .select({
        teamId: schema.usageCounters.teamId,
        accepted: schema.usageCounters.accepted,
        name: schema.teams.name,
        plan: schema.teams.plan,
        currentPeriodEnd: schema.teams.currentPeriodEnd,
      })
      .from(schema.usageCounters)
      .innerJoin(schema.teams, eq(schema.teams.id, schema.usageCounters.teamId))
      .where(and(eq(schema.usageCounters.day, today), gt(schema.usageCounters.accepted, 0)));
    for (const row of rows) {
      const limit = PLAN_DAILY_LIMIT[effectivePlan(row.plan, row.currentPeriodEnd, now)];
      if (limit === null) continue;
      const kind =
        row.accepted >= limit
          ? "quota.reached"
          : row.accepted >= Math.ceil(limit * QUOTA_WARNING_RATIO)
            ? "quota.warning"
            : null;
      if (!kind) continue;
      if (!(await claimNotification(db, { teamId: row.teamId, kind, periodKey: today }))) continue;
      const resetsAt = nextUtcDayStart(now.getTime());
      const url = `${base}/settings/billing`;
      const input = { team: row.name, used: row.accepted, limit, resetsAt, url };
      await notify(
        row.teamId,
        kind,
        { used: row.accepted, limit, resets_at: resetsAt.toISOString(), dashboard_url: url },
        kind === "quota.reached" ? quotaReachedMail(input) : quotaWarningMail(input),
      );
    }
  }

  const since = utcDay(now.getTime() - 6 * DAY_MS);
  const senders = await db
    .selectDistinct({ teamId: schema.usageCounters.teamId, name: schema.teams.name })
    .from(schema.usageCounters)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.usageCounters.teamId))
    .where(and(gte(schema.usageCounters.day, since), sql`${schema.usageCounters.sent} > 0`));
  // A team with no sends left in the window has nothing to judge: its episode
  // is over even though the loop below never sees it.
  const observed = new Set(senders.map((t) => t.teamId));
  const claimants = await db
    .selectDistinct({ teamId: schema.teamNotifications.teamId })
    .from(schema.teamNotifications)
    .where(eq(schema.teamNotifications.kind, "deliverability"));
  for (const { teamId } of claimants) {
    if (!observed.has(teamId)) await clearNotifications(db, { teamId, kind: "deliverability" });
  }
  for (const team of senders) {
    const health = await fetchDeliverabilityHealth(db, team.teamId, { now });
    if (health.status === "ok") {
      if (
        health.bounceRate < DELIVERABILITY_CLEAR_RATIO * WARN_BOUNCE_RATE &&
        health.complaintRate < DELIVERABILITY_CLEAR_RATIO * WARN_COMPLAINT_RATE
      ) {
        await clearNotifications(db, { teamId: team.teamId, kind: "deliverability" });
      }
      continue;
    }
    const reason = health.reasons.find((r) => r.tier === health.status) ?? health.reasons[0];
    if (!reason) continue;
    const claimed = await claimNotification(db, {
      teamId: team.teamId,
      kind: "deliverability",
      periodKey: health.status,
    });
    if (!claimed) continue;
    const limit = lineFor(reason);
    const url = `${base}/metrics`;
    const input = {
      team: team.name,
      metric: reason.metric,
      rate: reason.rate,
      limit,
      windowDays: reason.windowDays,
      url,
    };
    await notify(
      team.teamId,
      health.status === "paused" ? "deliverability.paused" : "deliverability.warning",
      {
        metric: reason.metric,
        rate: reason.rate,
        limit,
        window_days: reason.windowDays,
        dashboard_url: url,
      },
      health.status === "paused"
        ? deliverabilityPausedMail(input)
        : deliverabilityWarningMail(input),
    );
  }

  return { sent };
}
