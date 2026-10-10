import {
  EMAIL_RETENTION_DAYS_DEFAULT,
  env,
  isCloudDeployment,
  SES_MAX_SEND_RATE_DEFAULT,
  SES_TRANSACTIONAL_RESERVE_DEFAULT,
} from "@millionsend/config";
import {
  type BroadcastEstimate,
  broadcastSendSpacingMs,
  bulkSentBySlot,
  bulkShare,
  fetchDeliverabilityHealth,
  fetchTeamQuota,
  getInstanceSettings,
  type PlanCap,
  type PlanInput,
  pacingHorizonDays,
  pausedRegions,
  planBulkWaves,
  planCaps,
  planLabel,
  quotaUsage,
  regionBulkCounts,
  rungThatFits,
  type SendingBroadcast,
  sendingBroadcasts,
  transactionalSent24h,
  verifySenderDomain,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, inArray, isNotNull, sql } from "drizzle-orm";
import { plannerRegionAccount } from "./console/ses-regions";

/** What the send dialog and the send mutation say about a send being initiated. */
export interface SendEstimate {
  first: number;
  startsAt: Date | null;
  finishesAt: Date | null;
  days: number;
  blocked: boolean;
  releases: { at: Date; endsAt: Date; count: number }[];
  planHold: { heldBack: number; resumesAt: Date } | null;
  /** The team's plan as the dialog names its limit, and whether that limit is a day's or a month's; null off the ladder. */
  planLabel: string | null;
  planPeriod: "day" | "month" | null;
  /** The cheapest plan that would send everything, when the team's own holds rows back. */
  rung: { label: string; overage: boolean; finishesAt: Date | null } | null;
  /** Days a send may take before it is refused. */
  horizonDays: number;
}

export interface RegionPlan {
  /** The broadcasts already going out in the region, with their estimates by id. */
  sending: SendingBroadcast[];
  estimates: Map<string, BroadcastEstimate>;
  estimate: SendEstimate | null;
}

const NEW_SEND = "new";

/**
 * The planner over a region's live state, for one team's surfaces. Null when
 * SES has not answered GetAccount yet (a cold cache, or a region down): the
 * surfaces then show counts without an estimate rather than a wrong one.
 * The window is read once; the plan-cap candidates re-run the pure planner
 * over it.
 */
export async function planBroadcastSend(
  db: Db,
  opts: { teamId: string; region: string; now?: Date; newSend?: { count: number; at: Date } },
): Promise<RegionPlan | null> {
  const account = await plannerRegionAccount(opts.region);
  if (!account?.ok) return null;
  const now = opts.now ?? new Date();
  const settings = await getInstanceSettings(db);
  // Env values are raw strings when validation is skipped (tests), hence Number().
  const reservePercent =
    settings.sesTransactionalReserve ??
    Number(env.SES_TRANSACTIONAL_RESERVE ?? SES_TRANSACTIONAL_RESERVE_DEFAULT);
  const rateCeiling =
    settings.sesMaxSendRate ?? Number(env.SES_MAX_SEND_RATE ?? SES_MAX_SEND_RATE_DEFAULT);
  const horizonDays = pacingHorizonDays(
    settings.emailRetentionDays ?? Number(env.EMAIL_RETENTION_DAYS ?? EMAIL_RETENTION_DAYS_DEFAULT),
  );
  const { quota: sesQuota } = account.overview;
  const [counts, sentBySlot, sending, quota] = await Promise.all([
    regionBulkCounts(db, now),
    bulkSentBySlot(db, { region: opts.region, now }),
    sendingBroadcasts(db, { region: opts.region }),
    fetchTeamQuota(db, opts.teamId, isCloudDeployment()),
  ]);
  if (!quota) return null;
  const used = await quotaUsage(db, opts.teamId, quota, now);
  // The team's own sends in flight run under its caps; other teams' are
  // modelled on capacity alone.
  const ownCaps = planCaps(quota, used, now);
  const input: PlanInput = {
    share: bulkShare(sesQuota.max24h, reservePercent),
    rate: Math.min(sesQuota.maxSendRate || rateCeiling, rateCeiling),
    txPerDay: transactionalSent24h({
      sesSentLast24h: sesQuota.sentLast24h,
      allSent24h: counts.get(opts.region)?.allSent24h ?? 0,
      bulkSent24h: counts.get(opts.region)?.sent24h ?? 0,
    }),
    sentBySlot,
    start: now,
    horizonDays,
    broadcasts: sending.map((b) => ({
      key: b.id,
      queued: b.queued,
      parked: b.parked,
      ...(b.scheduledAt ? { at: Math.min(b.scheduledAt.getTime(), now.getTime()) } : {}),
      ...(b.teamId === opts.teamId ? { caps: ownCaps.map((c) => ({ ...c })) } : {}),
    })),
  };
  const byKey = (estimates: BroadcastEstimate[]) =>
    new Map(estimates.filter((e) => e.key !== NEW_SEND).map((e) => [e.key, e]));
  if (!opts.newSend) {
    return { sending, estimates: byKey(planBulkWaves(input)), estimate: null };
  }
  const health = await fetchDeliverabilityHealth(db, opts.teamId, { now });
  const spacingMs = broadcastSendSpacingMs(health.status);
  const { count, at } = opts.newSend;
  const withCaps = (caps: PlanCap[]) =>
    planBulkWaves({
      ...input,
      broadcasts: [...input.broadcasts, { key: NEW_SEND, admit: count, at, spacingMs, caps }],
    });
  const estimates = withCaps(planCaps(quota, used, now));
  const mine = estimates.find((e) => e.key === NEW_SEND);
  if (!mine) return null;
  const fit =
    mine.planHold || mine.blocked
      ? rungThatFits(quota, used, now, (caps) => withCaps(caps).find((e) => e.key === NEW_SEND))
      : null;
  return {
    sending,
    estimates: byKey(estimates),
    estimate: {
      first: mine.first,
      startsAt: mine.startsAt,
      finishesAt: mine.finishesAt,
      days: mine.days,
      blocked: mine.blocked,
      releases: mine.releases,
      planHold: mine.planHold,
      planLabel:
        quota.kind === "none"
          ? null
          : planLabel(quota.plan, quota.kind === "month" ? quota.included : null),
      planPeriod: quota.kind === "none" ? null : quota.kind,
      rung: fit
        ? {
            label: planLabel(fit.rung.plan, fit.rung.period === "month" ? fit.rung.included : null),
            overage: fit.overage,
            // A rung that fits never binds, so its finish is capacity's alone.
            finishesAt: withCaps([]).find((e) => e.key === NEW_SEND)?.finishesAt ?? null,
          }
        : null,
      horizonDays,
    },
  };
}

/** A sending broadcast as the list and the detail show it. */
export interface SendingProgressRow {
  sentCount: number;
  parkedCount: number;
  finishesAt: Date | null;
  /** The planner's releases still to come. */
  releases: { at: Date; endsAt: Date; count: number }[];
  /** Rows already out, in quarter-hour buckets. */
  sent: { at: Date; count: number }[];
}

/**
 * The rows of a team's sending broadcasts as the list and the detail show
 * them: how many went out and when, how many still wait, and when the rest
 * goes. One planner run per region; nothing when no broadcast is sending.
 */
export async function sendingProgress(
  db: Db,
  teamId: string,
  now: Date = new Date(),
): Promise<Map<string, SendingProgressRow>> {
  const out = new Map<string, SendingProgressRow>();
  const mine = await sendingBroadcasts(db, { teamId });
  if (mine.length === 0) return out;
  const regions = new Set(mine.flatMap((b) => (b.region ? [b.region] : [])));
  const e = schema.emails;
  const bucket = sql<Date>`date_bin('15 minutes', ${e.sentAt}, timestamptz 'epoch')`;
  const [plans, sentRows] = await Promise.all([
    Promise.all(
      [...regions].map(
        async (region) => [region, await planBroadcastSend(db, { teamId, region, now })] as const,
      ),
    ).then((entries) => new Map(entries)),
    db
      .select({ broadcastId: e.broadcastId, at: bucket, count: sql<number>`count(*)::int` })
      .from(e)
      .where(
        and(
          inArray(
            e.broadcastId,
            mine.map((b) => b.id),
          ),
          isNotNull(e.sentAt),
        ),
      )
      .groupBy(e.broadcastId, bucket)
      .orderBy(bucket),
  ]);
  for (const b of mine) {
    const estimate = b.region ? plans.get(b.region)?.estimates.get(b.id) : undefined;
    out.set(b.id, {
      sentCount: b.sent,
      parkedCount: b.parked,
      finishesAt: estimate?.finishesAt ?? null,
      releases: estimate?.releases ?? [],
      sent: sentRows
        .filter((r) => r.broadcastId === b.id)
        .map((r) => ({ at: new Date(r.at), count: r.count })),
    });
  }
  return out;
}

/**
 * The broadcasts among `rows` that are due or going out but wait on a hold
 * of their sender domain's region (the platform breaker or an operator's).
 * Customers see them as delayed and are never told why: a region's hold is
 * about the platform, not anything of theirs.
 */
export async function heldBroadcastIds(
  db: Db,
  teamId: string,
  rows: readonly { id: string; from: string; status: string; scheduledAt: Date | null }[],
  now: Date = new Date(),
): Promise<Set<string>> {
  const held = new Set<string>();
  const due = rows.filter(
    (r) => r.status === "sending" || (r.status === "scheduled" && (r.scheduledAt ?? now) <= now),
  );
  if (due.length === 0) return held;
  const paused = new Set((await pausedRegions(db)).map((p) => p.region));
  if (paused.size === 0) return held;
  for (const row of due) {
    const sender = await verifySenderDomain(db, teamId, row.from);
    if (sender.ok && paused.has(sender.region)) held.add(row.id);
  }
  return held;
}

/** When the team's own cap, not capacity, holds a broadcast's parked rows: the next reset, or null. */
export async function planHoldUntil(
  db: Db,
  teamId: string,
  now: Date = new Date(),
): Promise<Date | null> {
  const quota = await fetchTeamQuota(db, teamId, isCloudDeployment());
  if (!quota) return null;
  const bound = planCaps(quota, await quotaUsage(db, teamId, quota, now), now).filter(
    (cap) => cap.remaining <= 0,
  );
  return bound.length > 0 ? new Date(Math.min(...bound.map((cap) => cap.resetsAt))) : null;
}
