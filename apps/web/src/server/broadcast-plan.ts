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
  DAY_MS,
  fetchDeliverabilityHealth,
  fetchTeamQuota,
  getInstanceSettings,
  getWarmup,
  type InstanceSettings,
  type NewDomainLimit,
  newDomainLimitPlanCap,
  newDomainLimitStatus,
  type PlanCap,
  type PlanInput,
  pacingHorizonDays,
  pausedRegions,
  planBulkWaves,
  planCaps,
  planDomainWarmup,
  planLabel,
  planWarmupDays,
  quotaUsage,
  regionBulkCounts,
  rungThatFits,
  type SendingBroadcast,
  sendingBroadcasts,
  teamPlanHold,
  transactionalSent24h,
  utcDay,
  verifySenderDomain,
  WARMUP_INACTIVE_DAYS,
  type WarmupOutcome,
  type WarmupPlan,
  type WarmupStatus,
  warmupBroadcastPlans,
  warmupPastHorizon,
  warmupSendPreview,
  warmupStartingSettings,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { utcDayInstant, type WarmupSignalView } from "@/lib/warmup";
import { plannerRegionAccount } from "./console/ses-regions";
import { signalViews, warmupTodayWindow } from "./warmup-view";

/** What the send dialog and the send mutation say about a send being initiated. */
export interface SendEstimate {
  first: number;
  startsAt: Date | null;
  finishesAt: Date | null;
  days: number;
  blocked: boolean;
  releases: { at: Date; endsAt: Date; count: number }[];
  planHold: { heldBack: number; resumesAt: Date } | null;
  /** The first time the sender domain's new domain limit held rows back, with its name and daily cap; no plan lifts it. */
  newDomainHold: { heldBack: number; resumesAt: Date; domain: string; cap: number } | null;
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
  /** The new domain limit on the team's sender domains the plan ran under. */
  limits: NewDomainLimit[];
}

const NEW_SEND = "new";

/** Days a send may take before it is refused. */
function horizonDaysOf(settings: InstanceSettings): number {
  return pacingHorizonDays(
    settings.emailRetentionDays ?? Number(env.EMAIL_RETENTION_DAYS ?? EMAIL_RETENTION_DAYS_DEFAULT),
  );
}

/**
 * The planner over a region's live state, for one team's surfaces. Null when
 * SES has not answered GetAccount yet (a cold cache, or a region down): the
 * surfaces then show counts without an estimate rather than a wrong one.
 * The window is read once; the plan-cap candidates re-run the pure planner
 * over it. The team's own sends, and a new one given its sender domain, run
 * under their domain's new domain limit too.
 */
export async function planBroadcastSend(
  db: Db,
  opts: {
    teamId: string;
    region: string;
    now?: Date;
    newSend?: { count: number; at: Date; domainId?: string };
  },
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
  const horizonDays = horizonDaysOf(settings);
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
  const limits = await newDomainLimitStatus(db, {
    teamId: opts.teamId,
    domainIds: [
      ...sending.flatMap((b) =>
        b.teamId === opts.teamId && b.domainId && !b.warmup ? [b.domainId] : [],
      ),
      ...(opts.newSend?.domainId ? [opts.newSend.domainId] : []),
    ],
    now,
  });
  const limitCaps = (domainId: string | null | undefined): PlanCap[] => {
    const limit = limits.find((l) => l.domainId === domainId);
    return limit ? [newDomainLimitPlanCap(limit)] : [];
  };
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
    // A warming domain trickles out by its warm-up's day: warmupBroadcastPlans says when.
    broadcasts: sending
      .filter((b) => !b.warmup)
      .map((b) => ({
        key: b.id,
        queued: b.queued,
        parked: b.parked,
        ...(b.scheduledAt ? { at: Math.min(b.scheduledAt.getTime(), now.getTime()) } : {}),
        ...(b.teamId === opts.teamId
          ? { caps: [...ownCaps.map((c) => ({ ...c })), ...limitCaps(b.domainId)] }
          : {}),
      })),
  };
  const byKey = (estimates: BroadcastEstimate[]) =>
    new Map(estimates.filter((e) => e.key !== NEW_SEND).map((e) => [e.key, e]));
  if (!opts.newSend) {
    return { sending, estimates: byKey(planBulkWaves(input)), estimate: null, limits };
  }
  const health = await fetchDeliverabilityHealth(db, opts.teamId, { now });
  const spacingMs = broadcastSendSpacingMs(health.status);
  const { count, at } = opts.newSend;
  // No plan lifts the domain's limit, so every candidate cap set keeps it.
  const withCaps = (caps: PlanCap[]) =>
    planBulkWaves({
      ...input,
      broadcasts: [
        ...input.broadcasts,
        {
          key: NEW_SEND,
          admit: count,
          at,
          spacingMs,
          caps: [...caps, ...limitCaps(opts.newSend?.domainId)],
        },
      ],
    });
  const estimates = withCaps(planCaps(quota, used, now));
  const mine = estimates.find((e) => e.key === NEW_SEND);
  if (!mine) return null;
  const fit =
    mine.planHold || mine.blocked
      ? rungThatFits(quota, used, now, (caps) => withCaps(caps).find((e) => e.key === NEW_SEND))
      : null;
  const newLimit = limits.find((l) => l.domainId === opts.newSend?.domainId);
  return {
    sending,
    limits,
    estimates: byKey(estimates),
    estimate: {
      first: mine.first,
      startsAt: mine.startsAt,
      finishesAt: mine.finishesAt,
      days: mine.days,
      blocked: mine.blocked,
      releases: mine.releases,
      planHold: mine.planHold,
      newDomainHold:
        mine.newDomainHold && newLimit
          ? { ...mine.newDomainHold, domain: newLimit.name, cap: newLimit.cap }
          : null,
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
  /** Its domain's warm-up while warming or paused, with the plan for its rows still waiting. */
  warmup: { status: "warming" | "paused"; domainId: string; plan: WarmupPlan } | null;
  /** Its sender domain's new domain limit, while that paces the rest of the send. */
  newDomainLimit: { domain: string; cap: number } | null;
}

/**
 * A warm-up plan as the rail's releases: the first day from now, the rest at
 * their UTC noon (a date every zone reads alike), the last ending at the finish.
 */
function warmupReleases(plan: WarmupPlan, now: Date): SendingProgressRow["releases"] {
  const days = plan.perDay.filter((d) => d.count > 0);
  return days.map((d, i) => {
    const at = d.day === utcDay(now) ? now : utcDayInstant(d.day);
    const endsAt = i === days.length - 1 && plan.finishesAt ? plan.finishesAt : at;
    return { at, endsAt, count: d.count };
  });
}

/**
 * The rows of a team's sending broadcasts as the list and the detail show
 * them: how many went out and when, how many still wait, and when the rest
 * goes. One planner run per region, and the warm-up's own plan for a warming
 * domain's; nothing when no broadcast is sending.
 */
export async function sendingProgress(
  db: Db,
  teamId: string,
  now: Date = new Date(),
): Promise<Map<string, SendingProgressRow>> {
  const out = new Map<string, SendingProgressRow>();
  const mine = await sendingBroadcasts(db, { teamId });
  if (mine.length === 0) return out;
  const regions = new Set(mine.flatMap((b) => (b.region && !b.warmup ? [b.region] : [])));
  const e = schema.emails;
  const bucket = sql<Date>`date_bin('15 minutes', ${e.sentAt}, timestamptz 'epoch')`;
  const [plans, warmups, sentRows] = await Promise.all([
    Promise.all(
      [...regions].map(
        async (region) => [region, await planBroadcastSend(db, { teamId, region, now })] as const,
      ),
    ).then((entries) => new Map(entries)),
    warmupBroadcastPlans(db, mine, now),
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
    const plan = warmups.get(b.id);
    const region = b.region ? plans.get(b.region) : undefined;
    const estimate = region?.estimates.get(b.id);
    const limit = estimate?.newDomainHold
      ? region?.limits.find((l) => l.domainId === b.domainId)
      : undefined;
    out.set(b.id, {
      sentCount: b.sent,
      parkedCount: b.parked,
      finishesAt: plan ? plan.finishesAt : (estimate?.finishesAt ?? null),
      releases: plan ? warmupReleases(plan, now) : (estimate?.releases ?? []),
      sent: sentRows
        .filter((r) => r.broadcastId === b.id)
        .map((r) => ({ at: new Date(r.at), count: r.count })),
      warmup:
        plan && b.warmup && b.domainId ? { status: b.warmup, domainId: b.domainId, plan } : null,
      newDomainLimit: !plan && limit ? { domain: limit.name, cap: limit.cap } : null,
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
  return (await teamPlanHold(db, teamId, isCloudDeployment(), now))?.resumesAt ?? null;
}

/** What a domain's warm-up does to a send: the dialog shows it, the send enforces it. */
export interface WarmupSendPlan {
  status: WarmupStatus;
  bestDay: number;
  /** The send's audience. */
  eligible: number;
  /** Of those, inactive by the warm-up's order (its defaults while it has none). */
  inactive: number;
  /** A contact with no activity since then reads as inactive. */
  inactiveSince: Date;
  /** Whether the plan leaves the inactive out: the choice given, else the warm-up's own. */
  skipInactive: boolean;
  /** Far bigger than anything the domain sent in a day lately, with no warm-up on. */
  risky: boolean;
  /** The live plan while warming or paused; while off, the one a warm-up turned on now would follow. */
  plan: WarmupPlan;
  /** The plan goes out past the horizon: the send is refused. */
  blocked: boolean;
  horizonDays: number;
}

/** A send over this many, and over twice the domain's best day lately, reads as risky. */
const RISKY_MIN = 5_000;

/**
 * What a domain's warm-up does to a send, for the dialog and for the send
 * itself: while warming or paused, its live plan; while off, the plan a
 * warm-up turned on now would follow, for a risky send or one that turns it
 * on (`enabling`). Null when the warm-up has nothing to say.
 */
export async function warmupSendPlan(
  db: Db,
  opts: {
    teamId: string;
    domainId: string;
    segmentId: string | null;
    topicId: string | null;
    /** The send's audience: a small one skips the warm-up's reads. */
    count: number;
    at: Date;
    skipInactive?: boolean | undefined;
    enabling?: boolean | undefined;
  },
): Promise<WarmupSendPlan | null> {
  const { teamId, domainId } = opts;
  const row = await getWarmup(db, teamId, domainId);
  const live = row?.status === "warming" || row?.status === "paused" ? row : null;
  if (!live && !opts.enabling && opts.count <= RISKY_MIN) return null;
  const now = new Date();
  const [preview, settings] = await Promise.all([
    warmupSendPreview(db, {
      teamId,
      domainId,
      segmentId: opts.segmentId,
      topicId: opts.topicId,
      at: opts.at,
      now,
    }),
    getInstanceSettings(db),
  ]);
  if (!preview) return null;
  const risky = !live && preview.eligible > Math.max(RISKY_MIN, 2 * preview.bestDay);
  if (!live && !risky && !opts.enabling) return null;
  // Off, a warm-up starts from the team's earlier settings, else the defaults.
  const ramp = live ?? row ?? (await warmupStartingSettings(db, teamId, domainId, now));
  const skipInactive = opts.skipInactive ?? ramp.skipInactive;
  const count = preview.eligible - (skipInactive ? preview.inactive : 0);
  const plan = live
    ? await planDomainWarmup(db, { teamId, domainId, count, at: opts.at })
    : planWarmupDays({
        now: opts.at,
        paused: false,
        volume: ramp.startVolume,
        dailyTarget: ramp.dailyTarget,
        today: null,
        waitingAhead: 0,
        count,
      });
  if (!plan) return null;
  const horizonDays = horizonDaysOf(settings);
  return {
    status: preview.status,
    bestDay: preview.bestDay,
    eligible: preview.eligible,
    inactive: preview.inactive,
    inactiveSince: new Date(now.getTime() - WARMUP_INACTIVE_DAYS * DAY_MS),
    skipInactive,
    risky,
    plan,
    blocked: warmupPastHorizon(plan, horizonDays),
    horizonDays,
  };
}

/** A sending broadcast's warm-up as its page shows it. */
export interface BroadcastWarmup {
  status: "warming" | "paused";
  domainId: string;
  /** The day's volume now. */
  volume: number;
  /** The newest checked day of this run: one that held or cut explains today's volume. */
  latest: { outcome: WarmupOutcome | null; signals: WarmupSignalView[] | null } | null;
  /** What paused it; null when the team did. */
  pauseSignals: WarmupSignalView[] | null;
  /** Yesterday is checked, so today's mail may go. */
  checked: boolean;
  /** This run's checked days since the broadcast started, oldest first. */
  days: { day: string; outcome: WarmupOutcome | null; signals: WarmupSignalView[] | null }[];
  /** Its rows still waiting, by UTC day from today. */
  perDay: { day: string; count: number }[];
  /** Today's window for its rows at the drain's pace; null when none go today. */
  today: { startsAt: Date; endsAt: Date } | null;
}

export async function broadcastWarmup(
  db: Db,
  teamId: string,
  warmup: NonNullable<SendingProgressRow["warmup"]>,
  startedAt: Date | null,
  now: Date = new Date(),
): Promise<BroadcastWarmup | null> {
  const d = schema.domainWarmupDays;
  const [row, rows] = await Promise.all([
    getWarmup(db, teamId, warmup.domainId),
    db
      .select({
        day: d.day,
        allowance: d.allowance,
        sent: d.sent,
        outcome: d.outcome,
        signals: d.signals,
        checkedAt: d.checkedAt,
      })
      .from(d)
      .where(eq(d.domainId, warmup.domainId))
      .orderBy(desc(d.day))
      .limit(60),
  ]);
  if (!row) return null;
  const today = utcDay(now);
  // A restart begins a new history: only this run's days.
  const checked = rows.filter((x) => x.checkedAt && x.day >= utcDay(row.startedAt));
  const since = utcDay(startedAt ?? now);
  const opened = rows.find((x) => x.day === today);
  const first = warmup.plan.perDay[0];
  const ready = (row.checkedThrough ?? "") >= utcDay(now.getTime() - DAY_MS);
  const view = (x: (typeof rows)[number]) => ({
    day: x.day,
    outcome: x.outcome,
    signals: signalViews(x.signals),
  });
  return {
    status: warmup.status,
    domainId: warmup.domainId,
    volume: row.volume,
    latest: checked[0] ? view(checked[0]) : null,
    pauseSignals: signalViews(row.pauseSignals),
    checked: ready,
    days: checked
      .filter((x) => x.day >= since)
      .reverse()
      .map(view),
    perDay: warmup.plan.perDay,
    today:
      ready && warmup.status === "warming"
        ? warmupTodayWindow(
            {
              day: today,
              allowance: opened?.allowance ?? row.volume,
              sent: opened?.sent ?? 0,
            },
            first?.day === today ? first.count : 0,
            now,
          )
        : null,
  };
}
