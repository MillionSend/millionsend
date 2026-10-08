// Pure: no db, so the send dialog, the API, the worker and tests share one
// model of what the quota drain will do.
import { OVERAGE_HARD_CAP, QUOTA_TOLERANCE, type TeamQuota } from "./plans.js";
import { DAY_MS, nextUtcDayStart } from "./utc-day.js";

/** Hold sends from this share of a region's 24-hour quota: the last messages of the window are SES's, not ours. */
export const SES_QUOTA_MARGIN = 0.98;
/** The drain's cadence, and the bucket the rolling window is modelled in. */
export const SES_QUOTA_SLOT_MS = 15 * 60_000;
/** The drain runs this long after its slot: the cron tick plus the queue's slow poll. */
export const DRAIN_START_OFFSET_MS = 40_000;
/** Granularity the planner ages the window in. */
const WINDOW_BUCKET_MS = 60_000;
/** Parked rows released per drain run; the rest wait for the next run rather than one run owning the cron slot. */
export const DRAIN_MAX_PER_RUN = 10_000;
export const SES_TRANSACTIONAL_RESERVE_MIN = 5;
export const SES_TRANSACTIONAL_RESERVE_MAX = 90;
/** A send that would finish later than this share of the body retention is refused, leaving slack before bodies purge. */
export const PACING_HORIZON_FRACTION = 0.8;
export const PACING_HORIZON_MAX_RETENTION_DAYS = 30;

export function clampReserve(percent: number): number {
  return Math.min(
    SES_TRANSACTIONAL_RESERVE_MAX,
    Math.max(SES_TRANSACTIONAL_RESERVE_MIN, Math.round(percent)),
  );
}

/** Days a send may take: 0.8 × min(30, retention), 24 on the default retention. */
export function pacingHorizonDays(retentionDays: number): number {
  return Math.floor(
    PACING_HORIZON_FRACTION * Math.min(PACING_HORIZON_MAX_RETENTION_DAYS, retentionDays),
  );
}

/** Rows broadcasts may hold in a region's rolling window; Infinity when SES reports no quota (−1, unlimited). */
export function bulkShare(max24h: number, reservePercent: number): number {
  if (max24h <= 0) return Number.POSITIVE_INFINITY;
  // Integer arithmetic: (1 − p/100) × n lands a hair under the integer for
  // many pairs and the floor would drop a row.
  return Math.floor((max24h * (100 - reservePercent)) / 100);
}

/** What the total gate really protects for transactional mail: the margin line minus the share. */
export function usableReserve(max24h: number, reservePercent: number): number {
  if (max24h <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor(SES_QUOTA_MARGIN * max24h) - bulkShare(max24h, reservePercent);
}

/**
 * Transactional sends in a region's last 24 hours, other senders on the account included.
 * SES's SentLast24Hours lags our rows by minutes during a burst, so our own rows are its floor.
 */
export function transactionalSent24h(sent: {
  sesSentLast24h: number;
  /** Every row SES accepted in the region, bulk included. */
  allSent24h: number;
  bulkSent24h: number;
}): number {
  return Math.max(0, Math.max(sent.sesSentLast24h, sent.allSent24h) - sent.bulkSent24h);
}

/** The instant rounded up to the next slot: what every surface prints as "about". */
export function roundUpToSlot(at: Date | number, slotMs: number = SES_QUOTA_SLOT_MS): Date {
  const ms = typeof at === "number" ? at : at.getTime();
  return new Date(Math.ceil(ms / slotMs) * slotMs);
}

/** One cap a team's sends run under, as the planner models it: it refills to `resetTo` at `resetsAt`, then every period. */
export interface PlanCap {
  remaining: number;
  resetsAt: number;
  resetTo: number;
  period: "day" | "month";
}

function addUtcMonth(ms: number): number {
  const next = new Date(ms);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next.getTime();
}

/**
 * The caps of a team quota against what it has accepted so far: the UTC day
 * on a daily plan (with the tolerance the reservation allows), the billing
 * period on a monthly one (unbounded with overage on), plus the operator's
 * daily ceiling when one sits on a monthly plan. Nothing on self-host.
 */
export function planCaps(
  quota: TeamQuota,
  used: { day: number; period: number },
  now: Date | number = Date.now(),
): PlanCap[] {
  if (quota.kind === "none") return [];
  const at = typeof now === "number" ? now : now.getTime();
  const dayReset = nextUtcDayStart(at).getTime();
  if (quota.kind === "day") {
    const soft = Math.floor(quota.limit * (1 + QUOTA_TOLERANCE));
    const ceiling = quota.dailyCeiling == null ? soft : Math.min(soft, quota.dailyCeiling);
    return [
      {
        remaining: Math.max(0, ceiling - used.day),
        resetsAt: dayReset,
        resetTo: ceiling,
        period: "day",
      },
    ];
  }
  const included = quota.overage ? quota.included * OVERAGE_HARD_CAP : quota.included;
  const caps: PlanCap[] = [
    {
      remaining: Math.max(0, included - used.period),
      resetsAt: quota.periodEnd.getTime(),
      resetTo: included,
      period: "month",
    },
  ];
  if (quota.dailyCeiling != null) {
    caps.push({
      remaining: Math.max(0, quota.dailyCeiling - used.day),
      resetsAt: dayReset,
      resetTo: quota.dailyCeiling,
      period: "day",
    });
  }
  return caps;
}

/** One broadcast the planner simulates, in the region's FIFO (scheduled_at) order. */
export interface PlannedBroadcast {
  key: string;
  /** Rows queued with a job now: the wave in flight. */
  queued?: number;
  /** Rows parked, waiting for the drain. */
  parked?: number;
  /** Rows not written yet that the fan-out may admit at `at`, up to the room. */
  admit?: number;
  /** When the fan-out runs; defaults to the plan's start. */
  at?: number | Date;
  /** A warning-tier team drips: one row per this many ms, and the drain caps its slice to one cadence. */
  spacingMs?: number;
  caps?: PlanCap[];
}

export interface PlanInput {
  /** bulkShare of the region; Infinity disables pacing. */
  share: number;
  /** The region's bucket rate, messages per second. */
  rate: number;
  /** Transactional sends per day in the region: their average draw on the bucket. */
  txPerDay: number;
  /** Bulk sends in the region over the last 24 hours, by slot start. */
  sentBySlot: readonly { at: number; count: number }[];
  start: number | Date;
  broadcasts: readonly PlannedBroadcast[];
  drainCap?: number;
  slotMs?: number;
  startOffsetMs?: number;
  horizonDays?: number;
}

export interface Release {
  at: Date;
  endsAt: Date;
  count: number;
}

export interface BroadcastEstimate {
  key: string;
  /** Rows admitted at the fan-out. */
  first: number;
  /** When the first of its rows goes out; null when nothing ever does. */
  startsAt: Date | null;
  /** When its last row goes out, unrounded; null when nothing ever does. */
  finishesAt: Date | null;
  days: number;
  /** Still parked past the horizon: refuse the send. */
  blocked: boolean;
  /** Every release, the first wave included, in order. */
  releases: Release[];
  /** The first time the team's own cap, not capacity, held rows back. */
  planHold: { heldBack: number; resumesAt: Date } | null;
}

interface Sim {
  key: string;
  parked: number;
  admit: number;
  /** Whether the fan-out has run in the model (a send with nothing to admit counts as run). */
  admitted: boolean;
  at: number;
  spacingMs: number;
  caps: PlanCap[];
  laneFree: number;
  runs: { start: number; end: number; n: number }[];
  first: number;
  planHold: BroadcastEstimate["planHold"];
}

/**
 * What the drain will do with the broadcasts of one region: every queued
 * row sends on the bucket first; a new send is admitted up to the room its
 * fan-out finds; from then on each drain instant releases what the window
 * has freed, capped per run and split round-robin between the broadcasts
 * that still wait. A bucket leaves the window only once its end is 24 hours
 * old, so the model errs late, never early.
 */
export function planBulkWaves(input: PlanInput): BroadcastEstimate[] {
  const slot = input.slotMs ?? SES_QUOTA_SLOT_MS;
  const offset = input.startOffsetMs ?? DRAIN_START_OFFSET_MS;
  const drainCap = input.drainCap ?? DRAIN_MAX_PER_RUN;
  const horizonMs =
    (input.horizonDays ?? pacingHorizonDays(PACING_HORIZON_MAX_RETENTION_DAYS)) * DAY_MS;
  const start = typeof input.start === "number" ? input.start : input.start.getTime();
  const bulkRate = Math.max(0.5, input.rate - input.txPerDay / 86_400);

  // The window is kept per minute so the sends this model schedules age out
  // close to when they really do; a slot of past sends is placed at its last
  // minute, so it leaves the window no earlier than any row in it.
  const buckets = new Map<number, number>();
  const bucketOf = (at: number) => Math.floor(at / WINDOW_BUCKET_MS) * WINDOW_BUCKET_MS;
  for (const b of input.sentBySlot) {
    const key = bucketOf(Math.floor(b.at / slot) * slot + slot - WINDOW_BUCKET_MS);
    buckets.set(key, (buckets.get(key) ?? 0) + b.count);
  }
  // Rows sent by t and not yet aged out; rows released but not sent are the
  // queue, counted apart. Aged buckets are dropped as the model advances, so
  // a long horizon never rescans the whole history per slot.
  const inWindow = (t: number): number => {
    let sum = 0;
    for (const [at, n] of buckets) {
      if (at + WINDOW_BUCKET_MS <= t - DAY_MS) buckets.delete(at);
      else if (at <= t) sum += n;
    }
    return sum;
  };
  const sims: Sim[] = input.broadcasts.map((b) => ({
    key: b.key,
    parked: b.parked ?? 0,
    admit: b.admit ?? 0,
    admitted: (b.admit ?? 0) === 0,
    at: b.at === undefined ? start : typeof b.at === "number" ? b.at : b.at.getTime(),
    spacingMs: b.spacingMs ?? 0,
    caps: (b.caps ?? []).map((c) => ({ ...c })),
    laneFree: start,
    runs: [],
    first: 0,
    planHold: null,
  }));
  // Rows released but not yet sent at t, across every broadcast: only the
  // runs still open are walked, and a run that has ended leaves the list.
  let open: { start: number; end: number; n: number }[] = [];
  const queued = (t: number): number => {
    let q = 0;
    open = open.filter((r) => r.end > t);
    for (const r of open)
      q += Math.round((r.n * (r.end - Math.max(t, r.start))) / (r.end - r.start));
    return q;
  };
  let laneFree = start;
  const sendRun = (s: Sim, from: number, n: number): void => {
    if (n <= 0) return;
    const perSecond = s.spacingMs > 0 ? 1000 / s.spacingMs : bulkRate;
    // A throttled team drips on its own clock and never holds the shared lane.
    const st = Math.max(from, s.spacingMs > 0 ? s.laneFree : laneFree);
    const en = st + (n * 1000) / perSecond;
    if (s.spacingMs > 0) s.laneFree = en;
    else laneFree = en;
    const run = { start: st, end: en, n };
    s.runs.push(run);
    open.push(run);
    // Bucket the sends by minute, exactly n rows in total: floating rates
    // floor a row short at the end, and it belongs to the last bucket, never
    // outside the window.
    const sentBy = (x: number) => Math.floor(((x - st) * perSecond) / 1000);
    let counted = 0;
    let last = bucketOf(st);
    for (let b = bucketOf(st); b < en; b += WINDOW_BUCKET_MS) {
      const count =
        Math.min(n, sentBy(Math.min(b + WINDOW_BUCKET_MS, en))) -
        Math.min(n, sentBy(Math.max(b, st)));
      if (count > 0) buckets.set(b, (buckets.get(b) ?? 0) + count);
      counted += count;
      last = b;
    }
    if (counted < n) buckets.set(last, (buckets.get(last) ?? 0) + (n - counted));
  };
  const room = (t: number) => Math.max(0, input.share - inWindow(t) - queued(t));
  const capRoom = (s: Sim, t: number): number => {
    let least = Number.POSITIVE_INFINITY;
    for (const cap of s.caps) {
      while (t >= cap.resetsAt) {
        cap.remaining = cap.resetTo;
        cap.resetsAt = cap.period === "day" ? cap.resetsAt + DAY_MS : addUtcMonth(cap.resetsAt);
      }
      least = Math.min(least, cap.remaining);
    }
    return least;
  };
  const charge = (s: Sim, n: number): void => {
    for (const cap of s.caps) cap.remaining = Math.max(0, cap.remaining - n);
  };
  // Rows a cap that just ran dry left behind: the first such moment is what
  // the send dialog names ("holds back N until <reset>").
  const noteHold = (s: Sim, wanted: number, granted: number): void => {
    if (s.planHold || granted >= wanted) return;
    const bound = s.caps.filter((c) => c.remaining <= 0);
    if (bound.length === 0) return;
    s.planHold = {
      heldBack: wanted - granted,
      resumesAt: new Date(Math.min(...bound.map((c) => c.resetsAt))),
    };
  };

  // The waves in flight send first, in FIFO order; then each fan-out takes
  // the room it finds at its own instant.
  for (const [i, b] of input.broadcasts.entries()) {
    const s = sims[i];
    if (s && b.queued) sendRun(s, start, b.queued);
  }
  // A fan-out takes the room its region has at its own instant: the sends
  // in flight and the releases before it are all in place by then.
  const admit = (s: Sim): void => {
    const wanted = s.admit;
    const granted = Math.min(wanted, room(s.at), capRoom(s, s.at));
    s.first = granted;
    sendRun(s, s.at, granted);
    charge(s, granted);
    noteHold(s, wanted, granted);
    s.parked += wanted - granted;
    s.admitted = true;
  };
  const byAt = (a: Sim, b: Sim) => a.at - b.at;
  for (const s of sims.filter((s) => !s.admitted && s.at <= start).sort(byAt)) admit(s);

  // A send waits from its own instant, and its horizon counts from there:
  // a scheduled send is judged on the days it takes, not on the days until
  // it starts.
  const pending = (s: Sim, at: number) => s.parked > 0 && at - s.at <= horizonMs;
  let t = Math.floor(start / slot) * slot + slot + offset;
  while (sims.some((s) => pending(s, t) || !s.admitted)) {
    for (const s of sims.filter((s) => !s.admitted && s.at <= t).sort(byAt)) admit(s);
    const waiting = sims.filter((s) => pending(s, t) && t >= s.at);
    let budget = Math.min(room(t), drainCap);
    for (const [i, s] of waiting.entries()) {
      // Each waiting broadcast gets an equal share of what is left; a slice
      // one cannot use passes down the FIFO.
      let grant = Math.min(s.parked, Math.ceil(budget / (waiting.length - i)));
      if (s.spacingMs > 0) grant = Math.min(grant, Math.floor(slot / s.spacingMs));
      grant = Math.min(grant, capRoom(s, t));
      if (grant > 0) {
        sendRun(s, t, grant);
        charge(s, grant);
        s.parked -= grant;
        budget -= grant;
      }
      noteHold(s, s.parked + grant, grant);
    }
    t += slot;
  }

  return sims.map((s) => {
    const own = s.runs;
    const finishes = own.length > 0 ? Math.max(...own.map((r) => r.end)) : null;
    const starts = own.length > 0 ? Math.min(...own.map((r) => r.start)) : null;
    return {
      key: s.key,
      first: s.first,
      startsAt: starts === null ? null : new Date(starts),
      finishesAt: finishes === null ? null : new Date(finishes),
      days: finishes === null ? 0 : Math.max(1, Math.ceil((finishes - s.at) / DAY_MS)),
      blocked: s.parked > 0,
      releases: own.map((r) => ({ at: new Date(r.start), endsAt: new Date(r.end), count: r.n })),
      planHold: s.planHold,
    };
  });
}
