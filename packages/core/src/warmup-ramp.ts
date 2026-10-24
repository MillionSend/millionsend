import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { WarmupSignalReading, WarmupSignals } from "@millionsend/db/schema";
import { and, desc, eq, isNotNull, lt, ne, type SQL, sql } from "drizzle-orm";
import { accountMailPhrase, formatMailPercent, type MailLocale } from "./account-mail.js";
import { broadcastAudience, broadcastAudienceWhere } from "./broadcast-audience.js";
import { addWithinLimit } from "./domain-warmup.js";
import { firstRow, resultRows } from "./driver-result.js";
import { GMAIL_CLIP_BYTES } from "./email-insights.js";
import { firstRecipientDomain, firstRecipientReportsComplaints } from "./mailbox-provider-sql.js";
import { GMAIL_DOMAINS, MAILBOX_FULL_PATTERN } from "./mailbox-providers.js";
import { complaintFilter, hardBounceFilter } from "./platform-breaker.js";
import { propertyDateSql } from "./segment-filter.js";
import { SES_QUOTA_SLOT_MS } from "./ses-capacity.js";
import { DAY_MS, utcDay } from "./utc-day.js";

/**
 * A sending domain's reputation warm-up, which a team turns on for one
 * domain row: its broadcasts go out under a daily volume that starts small
 * and grows each day delivery stays healthy, most active contacts first.
 * Transactional mail never waits on it, and the age-based cap in
 * domain-warmup.ts still applies to every release on top of it.
 */

/** Where a warm-up starts when the domain has no sending history to go by. */
export const WARMUP_START_VOLUME = 1_500;
/** A cut volume stops here, unless the warm-up started below it. */
const MIN_VOLUME = 500;
const VOLUME_MOVES = { grow: 1.5, step_back: 0.7, resume: 0.5 } as const;
/** A day's allowance goes out over at least this many 15-minute drain runs: 12 hours. */
export const WARMUP_SLICES_PER_DAY = 48;
/** A checked day grows the volume only when it sent at least this share of its allowance. */
const LIGHT_DAY_SHARE = 0.5;
const RESTART_AFTER_IDLE_DAYS = 30;
/** Contacts whose last activity is older than this read as inactive. */
export const WARMUP_INACTIVE_DAYS = 90;
const TRANSACTIONAL_WINDOW_DAYS = 30;
const BEST_DAY_WINDOW_DAYS = 30;
const DEFAULT_TARGET = 10_000;
const HISTORY_DAYS = 60;
/** Plans and projections stop here; a warm-up that has not finished by then never will. */
const PLAN_MAX_DAYS = 366;

export const WARMUP_LIMITS = {
  dailyTarget: { min: 1_000, max: 10_000_000 },
  startVolume: { min: 100, max: 1_000_000 },
  orderPropertyLength: 100,
} as const;

type WarmupRow = typeof schema.domainWarmups.$inferSelect;
type DayRow = typeof schema.domainWarmupDays.$inferSelect;
export type WarmupStatus = WarmupRow["status"];
export type WarmupOutcome = NonNullable<DayRow["outcome"]>;

export interface WarmupSettings {
  dailyTarget: number;
  startVolume: number;
  orderByEngagement: boolean;
  orderByTransactional: boolean;
  orderProperty: string | null;
  skipInactive: boolean;
}

/** Settings as a form sends them: any left out, or undefined, keep their current value. */
export type WarmupSettingsInput = { [K in keyof WarmupSettings]?: WarmupSettings[K] | undefined };

const DEFAULT_ORDER = {
  orderByEngagement: true,
  orderByTransactional: true,
  orderProperty: null,
  skipInactive: true,
} as const;

const dayStartMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const nextDay = (day: string) => utcDay(dayStartMs(day) + DAY_MS);
const yesterdayOf = (now: Date) => utcDay(now.getTime() - DAY_MS);

/** A volume rounded the way the warm-up moves it: under 1,000 to the nearest 10, else to the nearest 100, never above the target. */
export function roundWarmupVolume(volume: number, target: number): number {
  const step = volume < 1_000 ? 10 : 100;
  return Math.min(target, Math.round(volume / step) * step);
}

/** The volume after a healthy day (grow), a day that missed two signals (step_back), or a resume. */
export function movedWarmupVolume(
  volume: number,
  move: keyof typeof VOLUME_MOVES,
  target: number,
): number {
  const moved = roundWarmupVolume(volume * VOLUME_MOVES[move], target);
  return move === "grow" ? moved : Math.max(Math.min(MIN_VOLUME, volume), moved);
}

/** Where a warm-up starts by default: twice the domain's best day lately, at least WARMUP_START_VOLUME. */
function defaultSettings(bestDay: number, subscribed: number): WarmupSettings {
  const { dailyTarget, startVolume } = WARMUP_LIMITS;
  const target = Math.min(dailyTarget.max, Math.max(DEFAULT_TARGET, subscribed));
  return {
    ...DEFAULT_ORDER,
    dailyTarget: target,
    startVolume: roundWarmupVolume(
      Math.min(startVolume.max, Math.max(WARMUP_START_VOLUME, 2 * bestDay)),
      target,
    ),
  };
}

function settingsOf(row: WarmupSettings): WarmupSettings {
  return {
    dailyTarget: row.dailyTarget,
    startVolume: row.startVolume,
    orderByEngagement: row.orderByEngagement,
    orderByTransactional: row.orderByTransactional,
    orderProperty: row.orderProperty,
    skipInactive: row.skipInactive,
  };
}

/** `base` with what `input` gives; throws a RangeError naming the first setting out of bounds. */
function mergeSettings(
  base: WarmupSettings,
  input: WarmupSettingsInput | undefined,
): WarmupSettings {
  const given = Object.fromEntries(Object.entries(input ?? {}).filter(([, v]) => v !== undefined));
  // Only the six settings: the result is spread into the row's update.
  const s = settingsOf({ ...base, ...given });
  s.orderProperty = s.orderProperty?.trim() || null;
  const { dailyTarget, startVolume, orderPropertyLength } = WARMUP_LIMITS;
  const within = (n: number, limits: { min: number; max: number }) =>
    Number.isInteger(n) && n >= limits.min && n <= limits.max;
  if (!within(s.dailyTarget, dailyTarget)) {
    throw new RangeError(
      `dailyTarget must be a whole number from ${dailyTarget.min} to ${dailyTarget.max}`,
    );
  }
  if (!within(s.startVolume, startVolume)) {
    throw new RangeError(
      `startVolume must be a whole number from ${startVolume.min} to ${startVolume.max}`,
    );
  }
  if (s.startVolume > s.dailyTarget) {
    throw new RangeError("startVolume must not be above dailyTarget");
  }
  if (s.orderProperty !== null && s.orderProperty.length > orderPropertyLength) {
    throw new RangeError(`orderProperty must be at most ${orderPropertyLength} characters`);
  }
  return s;
}

/** A team's warm-up row for one of its domains; undefined while it has none. */
export async function getWarmup(
  db: Db,
  teamId: string,
  domainId: string,
): Promise<WarmupRow | undefined> {
  const w = schema.domainWarmups;
  const [row] = await db
    .select()
    .from(w)
    .where(and(eq(w.domainId, domainId), eq(w.teamId, teamId)));
  return row;
}

async function teamDomain(db: Db, teamId: string, domainId: string) {
  const d = schema.domains;
  const [row] = await db
    .select({ openTracking: d.openTracking })
    .from(d)
    .where(and(eq(d.id, domainId), eq(d.teamId, teamId)));
  return row;
}

async function dayRow(db: Db, domainId: string, day: string): Promise<DayRow | undefined> {
  const d = schema.domainWarmupDays;
  const [row] = await db
    .select()
    .from(d)
    .where(and(eq(d.domainId, domainId), eq(d.day, day)));
  return row;
}

/** The busiest UTC day of the domain's sends over the last 30 days. */
async function bestDay(db: Db, teamId: string, domainId: string, now: Date): Promise<number> {
  const e = schema.emails;
  const since = new Date(now.getTime() - BEST_DAY_WINDOW_DAYS * DAY_MS).toISOString();
  const row = firstRow<{ n: number }>(
    await db.execute(sql`
      select coalesce(max(n), 0)::int as n from (
        select count(*) as n from ${e}
        where ${e.teamId} = ${teamId} and ${e.domainId} = ${domainId}
          and ${e.sentAt} >= ${since}::timestamptz
        group by (${e.sentAt} at time zone 'UTC')::date
      ) days
    `),
  );
  return Number(row?.n ?? 0);
}

async function subscribedContacts(db: Db, teamId: string): Promise<number> {
  const c = schema.contacts;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(c)
    .where(and(eq(c.teamId, teamId), eq(c.unsubscribed, false)));
  return row?.n ?? 0;
}

/** The settings a warm-up turned on now would start with, for a domain that has no warm-up row yet. */
export async function warmupStartingSettings(
  db: Db,
  teamId: string,
  domainId: string,
  now: Date,
): Promise<WarmupSettings> {
  const [best, subscribed] = await Promise.all([
    bestDay(db, teamId, domainId, now),
    subscribedContacts(db, teamId),
  ]);
  return defaultSettings(best, subscribed);
}

/**
 * This domain's broadcast mail parked for a warm-up; with `aheadOf`, only
 * the broadcasts the drain lets out before that one, in its order
 * (scheduled_at, nulls last, then created_at and id).
 */
async function waitingCount(
  db: Db,
  teamId: string,
  domainId: string,
  aheadOf?: string,
): Promise<number> {
  const e = schema.emails;
  const b = schema.broadcasts;
  const drainKey = (t: string) =>
    sql`(coalesce(${sql.identifier(t)}.scheduled_at, 'infinity'), ${sql.identifier(t)}.created_at, ${sql.identifier(t)}.id)`;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(e)
    .where(
      and(
        eq(e.teamId, teamId),
        eq(e.latestStatus, "queued_quota"),
        eq(e.domainId, domainId),
        isNotNull(e.broadcastId),
        eq(e.parkReason, "warmup"),
        aheadOf
          ? sql`${e.broadcastId} in (select ahead.id from ${b} ahead, ${b} mine where mine.id = ${aheadOf} and ${drainKey("ahead")} < ${drainKey("mine")})`
          : undefined,
      ),
    );
  return row?.n ?? 0;
}

/** Today's allowance comes down to `volume`, or to what already went out today when that is more. */
async function capToday(db: Db, domainId: string, volume: number, now: Date): Promise<void> {
  const d = schema.domainWarmupDays;
  await db
    .update(d)
    .set({ allowance: sql`least(${d.allowance}, greatest(${d.sent}, ${volume}))` })
    .where(and(eq(d.domainId, domainId), eq(d.day, utcDay(now))));
}

/**
 * Stamps the team's contacts with their newest stored real open or click
 * past what last_engaged_at holds, so a warm-up started soon after that
 * column existed still ranks by the opens kept from before it. Read off the
 * team's engaged broadcast copies only.
 * ponytail: transactional mail's opens are left to the recorder and the
 * transactional signal; join its recipients' addresses here if a warm-up
 * that orders without that signal ever needs them.
 */
async function stampStoredEngagement(db: Db, teamId: string): Promise<void> {
  const e = schema.emails;
  const x = schema.emailEvents;
  const c = schema.contacts;
  await db.execute(sql`
    update ${c} set last_engaged_at = engaged.at
    from (
      select ${e.contactId} as contact_id, max(${x.occurredAt}) as at
      from ${e} join ${x} on ${x.emailId} = ${e.id}
      where ${e.teamId} = ${teamId} and ${e.contactId} is not null
        and ${e.latestStatus} in ('opened', 'clicked', 'complained')
        and ${x.type} in ('opened', 'clicked')
      group by 1
    ) engaged
    where ${c.id} = engaged.contact_id and ${c.teamId} = ${teamId}
      and (${c.lastEngagedAt} is null or ${c.lastEngagedAt} < engaged.at)
  `);
}

/**
 * Turns a domain's warm-up on, or starts it over from off or done: the
 * volume back at the start, yesterday counted as checked so today can send.
 * A restart keeps the team's settings unless new ones are given. False when
 * the domain is not the team's; a warm-up already on is left as it is.
 */
export async function enableWarmup(
  db: Db,
  input: { teamId: string; domainId: string; settings?: WarmupSettingsInput; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  if (!(await teamDomain(db, input.teamId, input.domainId))) return false;
  const current = await getWarmup(db, input.teamId, input.domainId);
  if (current?.status === "warming" || current?.status === "paused") return true;
  const settings = mergeSettings(
    current
      ? settingsOf(current)
      : await warmupStartingSettings(db, input.teamId, input.domainId, now),
    input.settings,
  );
  const fresh = {
    ...settings,
    status: "warming" as const,
    volume: settings.startVolume,
    sendingDays: 0,
    checkedThrough: yesterdayOf(now),
    startedAt: now,
    pausedAt: null,
    pauseSignals: null,
    doneAt: null,
    updatedAt: now,
  };
  await stampStoredEngagement(db, input.teamId);
  const w = schema.domainWarmups;
  await db.transaction(async (tx) => {
    await tx
      .insert(w)
      .values({ domainId: input.domainId, teamId: input.teamId, ...fresh })
      .onConflictDoUpdate({ target: w.domainId, set: fresh, setWhere: eq(w.teamId, input.teamId) });
    // A run turned off earlier today may have opened today at a higher volume.
    await capToday(tx as unknown as Db, input.domainId, fresh.volume, now);
  });
  return true;
}

/** The team pauses a warming domain; its broadcasts wait. False when it was not warming. */
export async function pauseWarmup(
  db: Db,
  input: { teamId: string; domainId: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const w = schema.domainWarmups;
  const rows = await db
    .update(w)
    .set({ status: "paused", pausedAt: now, pauseSignals: null, updatedAt: now })
    .where(and(eq(w.domainId, input.domainId), eq(w.teamId, input.teamId), eq(w.status, "warming")))
    .returning({ domainId: w.domainId });
  return rows.length > 0;
}

/**
 * A paused warm-up warms again at half its volume, from today: yesterday
 * counts as checked, and today's allowance comes down with the volume.
 * False when it was not paused.
 */
export async function resumeWarmup(
  db: Db,
  input: { teamId: string; domainId: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const row = await getWarmup(db, input.teamId, input.domainId);
  if (row?.status !== "paused") return false;
  const volume = movedWarmupVolume(row.volume, "resume", row.dailyTarget);
  const w = schema.domainWarmups;
  return db.transaction(async (tx) => {
    const moved = await tx
      .update(w)
      .set({
        status: "warming",
        volume,
        checkedThrough: yesterdayOf(now),
        pausedAt: null,
        pauseSignals: null,
        updatedAt: now,
      })
      .where(
        and(eq(w.domainId, input.domainId), eq(w.teamId, input.teamId), eq(w.status, "paused")),
      )
      .returning({ domainId: w.domainId });
    if (moved.length === 0) return false;
    await capToday(tx as unknown as Db, input.domainId, volume, now);
    return true;
  });
}

/** Turns a warm-up off: what it holds then drains at the normal pace. False when it was already off. */
export async function turnOffWarmup(
  db: Db,
  input: { teamId: string; domainId: string; now?: Date },
): Promise<boolean> {
  const w = schema.domainWarmups;
  const rows = await db
    .update(w)
    .set({ status: "off", updatedAt: input.now ?? new Date() })
    .where(and(eq(w.domainId, input.domainId), eq(w.teamId, input.teamId), ne(w.status, "off")))
    .returning({ domainId: w.domainId });
  return rows.length > 0;
}

/**
 * Saves a domain's warm-up settings, keeping it off when it has no warm-up
 * yet. A warm-up that has not sent yet starts at the new start volume; one
 * that has keeps its volume, under the new target. False when the domain is
 * not the team's; throws a RangeError for a setting out of bounds.
 */
export async function updateWarmupSettings(
  db: Db,
  input: { teamId: string; domainId: string; settings: WarmupSettingsInput; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  if (!(await teamDomain(db, input.teamId, input.domainId))) return false;
  const current = await getWarmup(db, input.teamId, input.domainId);
  const settings = mergeSettings(
    current
      ? settingsOf(current)
      : await warmupStartingSettings(db, input.teamId, input.domainId, now),
    input.settings,
  );
  const w = schema.domainWarmups;
  if (!current) {
    await db
      .insert(w)
      .values({
        domainId: input.domainId,
        teamId: input.teamId,
        ...settings,
        status: "off",
        volume: settings.startVolume,
      })
      .onConflictDoNothing();
    return true;
  }
  const volume =
    current.status === "off" || current.sendingDays === 0
      ? settings.startVolume
      : Math.min(current.volume, settings.dailyTarget);
  await db
    .update(w)
    .set({ ...settings, volume, updatedAt: now })
    .where(and(eq(w.domainId, input.domainId), eq(w.teamId, input.teamId)));
  return true;
}

/**
 * Reserves `count` of a warming domain's `day`: the day row opens at the
 * warm-up's volume and takes more only while what went out stays within its
 * allowance. False when the day is full. Run inside the transaction that
 * releases the rows, so a rolled-back release gives the count back.
 */
export async function reserveWarmupDay(
  db: Db,
  input: { domainId: string; day: string; volume: number; count: number },
): Promise<boolean> {
  if (input.count > input.volume) return false;
  const d = schema.domainWarmupDays;
  return addWithinLimit(db, {
    counter: d.sent,
    key: [
      [d.domainId, input.domainId],
      [d.day, input.day],
    ],
    fill: [[d.allowance, input.volume]],
    count: input.count,
    limit: sql`${d.allowance}`,
  });
}

export interface WarmupRelease {
  status: "warming" | "paused";
  /** Yesterday is checked, so today's releases may start. */
  ready: boolean;
  volume: number;
  /** The most one drain run releases for the domain: today's allowance over WARMUP_SLICES_PER_DAY runs. */
  slice: number;
}

/** What the drain needs to release a domain's broadcast mail; null unless its warm-up is warming or paused. */
export async function warmupRelease(
  db: Db,
  input: { teamId: string; domainId: string; now: Date },
): Promise<WarmupRelease | null> {
  const row = await getWarmup(db, input.teamId, input.domainId);
  if (!row || (row.status !== "warming" && row.status !== "paused")) return null;
  const today = await dayRow(db, input.domainId, utcDay(input.now));
  return {
    status: row.status,
    ready: (row.checkedThrough ?? "") >= yesterdayOf(input.now),
    volume: row.volume,
    slice: Math.ceil((today?.allowance ?? row.volume) / WARMUP_SLICES_PER_DAY),
  };
}

type Side = { gmail: number; other: number };

/** One checked day's broadcast sends from a domain, Gmail recipients apart from the rest. */
export interface WarmupDayCounts {
  sent: Side;
  delayed: Side;
  /**
   * Delivered, of the sends whose opens can be read: Gmail clips a message
   * past GMAIL_CLIP_BYTES before the open pixel at its end, so a broadcast
   * that size would read as Gmail filing it as spam.
   */
  delivered: Side;
  /** Of those, opened by a person (prefetches are their own event type). */
  opened: Side;
  hardBounced: Side;
  mailboxFull: Side;
  /** Delivered to providers that report complaints, and the complaints among them. */
  feedbackDelivered: number;
  complained: number;
}

const SIGNAL_KEYS = ["delays", "opens", "hardBounces", "mailboxFull", "complaints"] as const;
type SignalKey = (typeof SIGNAL_KEYS)[number];
type SignalFigures = Pick<WarmupSignals, "sent"> &
  Record<SignalKey, Pick<WarmupSignalReading, "gmail" | "other">>;

/** Each signal's missed and severe lines; opens are judged low (Gmail's rate as a share of the others'), the rest high. */
const SIGNAL_LINES: Record<SignalKey, { missed: number; severe: number }> = {
  delays: { missed: 0.05, severe: 0.2 },
  opens: { missed: 0.5, severe: 0.25 },
  hardBounces: { missed: 0.02, severe: 0.05 },
  mailboxFull: { missed: 0.02, severe: 0.05 },
  complaints: { missed: 0.0005, severe: 0.001 },
};

/**
 * The figure a signal is judged and reported on: Gmail's delay rate, Gmail's
 * open rate as a share of the other inboxes', the complaint rate where
 * complaints are reported, and the rate over every send for the rest.
 */
export function warmupSignalFigure(s: SignalFigures, key: SignalKey): number | null {
  switch (key) {
    case "delays":
      return s.delays.gmail;
    case "opens":
      return s.opens.gmail !== null && s.opens.other ? s.opens.gmail / s.opens.other : null;
    case "complaints":
      return s.complaints.other;
    default: {
      const n = s.sent.gmail + s.sent.other;
      const r = s[key];
      return n > 0 ? ((r.gmail ?? 0) * s.sent.gmail + (r.other ?? 0) * s.sent.other) / n : null;
    }
  }
}

/** A checked day's signals from its counts, each side as a fraction, and each signal's verdict. */
export function warmupSignals(c: WarmupDayCounts, openTracking: boolean): WarmupSignals {
  const share = (n: number, of: number) => (of > 0 ? n / of : null);
  const sides = (n: Side, of: Side) => ({
    gmail: share(n.gmail, of.gmail),
    other: share(n.other, of.other),
  });
  const figures: SignalFigures = {
    sent: { ...c.sent },
    delays: sides(c.delayed, c.sent),
    opens: openTracking ? sides(c.opened, c.delivered) : { gmail: null, other: null },
    hardBounces: sides(c.hardBounced, c.sent),
    mailboxFull: sides(c.mailboxFull, c.sent),
    complaints: { gmail: null, other: share(c.complained, c.feedbackDelivered) },
  };
  const sent = c.sent.gmail + c.sent.other;
  // Below these, too little mail went out to judge.
  const enough: Record<SignalKey, boolean> = {
    delays: c.sent.gmail >= 100,
    opens: openTracking && c.delivered.gmail >= 100 && c.delivered.other >= 100,
    hardBounces: sent >= 100,
    mailboxFull: sent >= 100,
    complaints: c.feedbackDelivered >= 200,
  };
  // A complaint rate needs a few complaints behind it, not one person's click.
  const least = (key: SignalKey, n: number) => key !== "complaints" || c.complained >= n;
  const verdict = (key: SignalKey): WarmupSignalReading["result"] => {
    const figure = warmupSignalFigure(figures, key);
    if (!enough[key] || figure === null) return "unknown";
    const past = (line: number) => (key === "opens" ? figure < line : figure >= line);
    if (past(SIGNAL_LINES[key].severe) && least(key, 3)) return "severe";
    if (past(SIGNAL_LINES[key].missed) && least(key, 2)) return "missed";
    return "within";
  };
  const reading = (key: SignalKey) => ({ ...figures[key], result: verdict(key) });
  return {
    sent: figures.sent,
    delays: reading("delays"),
    opens: reading("opens"),
    hardBounces: reading("hardBounces"),
    mailboxFull: reading("mailboxFull"),
    complaints: reading("complaints"),
  };
}

/** How a checked day that sent moves the warm-up. */
export function warmupDayOutcome(
  signals: WarmupSignals,
  day: { sent: number; allowance: number },
  volume: number,
  dailyTarget: number,
): Exclude<WarmupOutcome, "idle"> {
  const results = SIGNAL_KEYS.map((key) => signals[key].result);
  if (results.includes("severe")) return "paused";
  const missed = results.filter((r) => r === "missed").length;
  if (missed >= 2) return "stepped_back";
  if (missed === 1) return "held";
  if (day.sent < day.allowance * LIGHT_DAY_SHARE) return "light";
  return volume >= dailyTarget ? "done" : "grew";
}

/** MAILBOX_FULL_PATTERN in Postgres, which spells a word boundary \y. */
const MAILBOX_FULL_SQL = MAILBOX_FULL_PATTERN.source.replaceAll("\\b", "\\y");

/** A checked day's counts: the domain's broadcast rows SES took that UTC day, read with their events. */
async function dayCounts(
  db: Db,
  row: { teamId: string; domainId: string },
  day: string,
): Promise<WarmupDayCounts> {
  const e = schema.emails;
  const x = schema.emailEvents;
  const from = new Date(dayStartMs(day)).toISOString();
  const to = new Date(dayStartMs(day) + DAY_MS).toISOString();
  const r =
    firstRow<Record<string, number>>(
      await db.execute(sql`
        select
          count(*) filter (where gmail)::int as sent_gmail,
          count(*) filter (where not gmail)::int as sent_other,
          count(*) filter (where gmail and delayed)::int as delayed_gmail,
          count(*) filter (where not gmail and delayed)::int as delayed_other,
          count(*) filter (where gmail and delivered and not clipped)::int as delivered_gmail,
          count(*) filter (where not gmail and delivered and not clipped)::int as delivered_other,
          count(*) filter (where gmail and delivered and opened and not clipped)::int as opened_gmail,
          count(*) filter (where not gmail and delivered and opened and not clipped)::int as opened_other,
          count(*) filter (where gmail and hard)::int as hard_gmail,
          count(*) filter (where not gmail and hard)::int as hard_other,
          count(*) filter (where gmail and mailbox_full)::int as full_gmail,
          count(*) filter (where not gmail and mailbox_full)::int as full_other,
          count(*) filter (where feedback and delivered)::int as feedback_delivered,
          count(*) filter (where feedback and complained)::int as complained
        from (
          select ${firstRecipientDomain} in ${[...GMAIL_DOMAINS]} as gmail,
            ${firstRecipientReportsComplaints} as feedback,
            coalesce(ev.delivered, false) as delivered,
            coalesce(ev.delayed, false) as delayed,
            coalesce(ev.opened, false) as opened,
            coalesce(ev.hard, false) as hard,
            coalesce(ev.mailbox_full, false) as mailbox_full,
            coalesce(ev.complained, false) as complained,
            coalesce(i.html_size_bytes > ${GMAIL_CLIP_BYTES}, false) as clipped
          from ${e}
          left join ${schema.emailInsights} i on i.broadcast_id = ${e.broadcastId}
          left join lateral (
            select bool_or(${x.type} = 'delivered') as delivered,
              bool_or(${x.type} = 'delivery_delayed') as delayed,
              bool_or(${x.type} = 'opened') as opened,
              bool_or(${hardBounceFilter}) as hard,
              bool_or(${complaintFilter}) as complained,
              bool_or(
                (${x.type} = 'bounced' and ${x.bounceType} = 'Transient'
                  and concat_ws(' ', ${x.data}->'bounce'->>'bounceSubType',
                    ${x.data}->'bounce'->'bouncedRecipients'->0->>'diagnosticCode') ~* ${MAILBOX_FULL_SQL})
                or (${x.type} = 'delivery_delayed'
                  and concat_ws(' ', ${x.data}->'deliveryDelay'->>'delayType',
                    ${x.data}->'deliveryDelay'->'delayedRecipients'->0->>'diagnosticCode') ~* ${MAILBOX_FULL_SQL})
              ) as mailbox_full
            from ${x}
            where ${x.emailId} = ${e.id}
          ) ev on true
          where ${e.teamId} = ${row.teamId} and ${e.domainId} = ${row.domainId}
            and ${e.broadcastId} is not null
            and ${e.sentAt} >= ${from}::timestamptz and ${e.sentAt} < ${to}::timestamptz
        ) sends
      `),
    ) ?? {};
  const side = (name: string): Side => ({
    gmail: Number(r[`${name}_gmail`] ?? 0),
    other: Number(r[`${name}_other`] ?? 0),
  });
  return {
    sent: side("sent"),
    delayed: side("delayed"),
    delivered: side("delivered"),
    opened: side("opened"),
    hardBounced: side("hard"),
    mailboxFull: side("full"),
    feedbackDelivered: Number(r.feedback_delivered ?? 0),
    complained: Number(r.complained ?? 0),
  };
}

/** What the day check tells the owners about: a warm-up that paused itself, or one that finished. */
export type WarmupEvent =
  | {
      kind: "warmup.paused";
      teamId: string;
      domainId: string;
      domain: string;
      /** Claims the mail once per pause. */
      episode: string;
      signals: WarmupSignals;
      waiting: number;
    }
  | {
      kind: "warmup.done";
      teamId: string;
      domainId: string;
      domain: string;
      /** Claims the mail once per warm-up run. */
      episode: string;
      /** What went out on the day that finished it. */
      sent: number;
    };

/**
 * The day check, run at the start of every drain: each warming domain's
 * days up to yesterday are judged in order. A day that sent nothing is idle
 * (thirty idle days in a row restart the volume); one that sent moves the
 * volume and may pause or finish the warm-up. Each day commits with its
 * move, guarded on the day checked before it, so a second run finds nothing
 * left to do. A domain whose check fails is logged and stays unchecked,
 * which holds its releases until a later run gets through.
 */
export async function checkWarmups(db: Db, now: Date = new Date()): Promise<WarmupEvent[]> {
  const w = schema.domainWarmups;
  const d = schema.domains;
  const yesterday = yesterdayOf(now);
  const rows = await db
    .select({ row: w, domain: d.name, openTracking: d.openTracking })
    .from(w)
    .innerJoin(d, eq(d.id, w.domainId))
    .where(and(eq(w.status, "warming"), lt(w.checkedThrough, yesterday)));
  const events: WarmupEvent[] = [];
  for (const { row, domain, openTracking } of rows) {
    try {
      const event = await checkWarmup(db, row, { domain, openTracking }, yesterday, now);
      if (event) events.push(event);
    } catch (err) {
      console.error(`warm-up check of domain ${row.domainId} failed`, err);
    }
  }
  return events;
}

async function checkWarmup(
  db: Db,
  row: WarmupRow,
  domain: { domain: string; openTracking: boolean },
  yesterday: string,
  now: Date,
): Promise<WarmupEvent | null> {
  const w = schema.domainWarmups;
  const d = schema.domainWarmupDays;
  let through = row.checkedThrough ?? yesterday;
  let { volume, sendingDays } = row;
  const [last] = await db
    .select({ day: sql<string | null>`max(${d.day})::text` })
    .from(d)
    .where(and(eq(d.domainId, row.domainId), sql`${d.sent} > 0`));
  let lastSent = last?.day ?? utcDay(row.startedAt);
  while (through < yesterday) {
    const day = nextDay(through);
    const opened = await dayRow(db, row.domainId, day);
    let outcome: WarmupOutcome = "idle";
    let signals: WarmupSignals | null = null;
    if (opened && opened.sent > 0) {
      signals = warmupSignals(await dayCounts(db, row, day), domain.openTracking);
      outcome = warmupDayOutcome(signals, opened, volume, row.dailyTarget);
      sendingDays += 1;
      lastSent = day;
      if (outcome === "grew" || outcome === "stepped_back") {
        volume = movedWarmupVolume(
          volume,
          outcome === "grew" ? "grow" : "step_back",
          row.dailyTarget,
        );
      }
    } else if (dayStartMs(day) - dayStartMs(lastSent) >= RESTART_AFTER_IDLE_DAYS * DAY_MS) {
      volume = row.startVolume;
    }
    const checked = through;
    const moved = await db.transaction(async (tx) => {
      const [hit] = await tx
        .update(w)
        .set({
          volume,
          sendingDays,
          checkedThrough: day,
          updatedAt: now,
          ...(outcome === "paused"
            ? { status: "paused" as const, pausedAt: now, pauseSignals: signals }
            : {}),
          ...(outcome === "done" ? { status: "done" as const, doneAt: now } : {}),
        })
        .where(
          and(eq(w.domainId, row.domainId), eq(w.status, "warming"), eq(w.checkedThrough, checked)),
        )
        .returning({ domainId: w.domainId });
      if (!hit) return false;
      if (opened) {
        await tx
          .update(d)
          .set({ outcome, signals, checkedAt: now })
          .where(and(eq(d.domainId, row.domainId), eq(d.day, day)));
      }
      return true;
    });
    if (!moved) return null;
    through = day;
    const about = { teamId: row.teamId, domainId: row.domainId, domain: domain.domain };
    if (outcome === "paused" && signals) {
      return {
        kind: "warmup.paused",
        ...about,
        episode: now.toISOString(),
        signals,
        waiting: await waitingCount(db, row.teamId, row.domainId),
      };
    }
    if (outcome === "done" && opened) {
      return {
        kind: "warmup.done",
        ...about,
        episode: row.startedAt.toISOString(),
        sent: opened.sent,
      };
    }
  }
  return null;
}

/** The values the warmup.* mails fill, in the reader's language. */
export function warmupMailValues(event: WarmupEvent, locale: MailLocale): Record<string, string> {
  if (event.kind === "warmup.done") {
    return { domain: event.domain, volume: event.sent.toLocaleString(locale) };
  }
  const kind = event.kind;
  const lines = SIGNAL_KEYS.filter((key) =>
    ["severe", "missed"].includes(event.signals[key].result),
  ).map((key) =>
    accountMailPhrase({
      locale,
      kind,
      key,
      values: {
        pct: formatMailPercent(locale, warmupSignalFigure(event.signals, key) ?? 0),
      },
    }),
  );
  return {
    domain: event.domain,
    signals: lines.join(" "),
    waiting: accountMailPhrase({
      locale,
      kind,
      key: event.waiting === 1 ? "waiting.one" : "waiting.other",
      values: { n: event.waiting.toLocaleString(locale) },
    }),
  };
}

/**
 * A contact's property `key` read as a date (property-date.ts), in SQL, so
 * the fan-out's order and every count of inactive contacts read it alike.
 */
export function contactPropertyDateSql(key: string): SQL<Date | null> {
  return propertyDateSql(sql`${schema.contacts.properties}->>${key}`);
}

const PROPERTY_OPTIONS_SAMPLE = 20_000;

export interface WarmupPropertyOption {
  key: string;
  /** Defined as a date property. */
  declared: boolean;
  /** How many sampled contacts hold a date in it, and the newest one. */
  dated: number;
  latest: Date | null;
}

/**
 * The properties the warm-up can order by: every property defined as a
 * date, with values or not, then any other key at least half of whose
 * non-empty values read as dates, the most dated first. A definition matches
 * contact keys in any letter case, as API writes do, and lists the key as
 * contacts write it: the warm-up reads that exact key.
 * ponytail: reads only the 20,000 most recently updated contacts, so
 * `dated` and `latest` count that sample. Read them all if a key that only
 * older contacts carry ever needs to show.
 */
export async function warmupPropertyOptions(
  db: Db,
  teamId: string,
): Promise<WarmupPropertyOption[]> {
  const c = schema.contacts;
  const p = schema.contactProperties;
  const rows = resultRows<{
    key: string;
    declared: boolean;
    dated: number;
    latest_ms: number | string | null;
  }>(
    await db.execute(sql`
      with sample as (
        select ${c.properties} as properties from ${c}
        where ${c.teamId} = ${teamId}
        order by ${c.updatedAt} desc
        limit ${PROPERTY_OPTIONS_SAMPLE}
      ), seen as (
        select kv.key, count(*)::int as filled, count(d.at)::int as dated, max(d.at) as latest
        from sample
        cross join lateral jsonb_each_text(sample.properties) as kv(key, value)
        cross join lateral (select ${propertyDateSql(sql`kv.value`)} as at) d
        where kv.value <> ''
        group by kv.key
      ), declared as (
        select ${p.key} as key from ${p} where ${p.teamId} = ${teamId} and ${p.type} = 'date'
      )
      select coalesce(seen.key, declared.key) as key,
        declared.key is not null as declared,
        coalesce(seen.dated, 0) as dated,
        (extract(epoch from seen.latest) * 1000)::float8 as latest_ms
      from declared
      full join seen on lower(seen.key) = lower(declared.key)
      where declared.key is not null or seen.dated * 2 >= seen.filled
      order by 2 desc, 3 desc, 1
    `),
  );
  return rows.map((r) => ({
    key: r.key,
    declared: r.declared,
    dated: Number(r.dated),
    latest: r.latest_ms === null ? null : new Date(Number(r.latest_ms)),
  }));
}

type OrderSettings = Pick<
  WarmupSettings,
  "orderByEngagement" | "orderByTransactional" | "orderProperty"
>;

/**
 * A contact's last activity, the warm-up's ordering signal: the newest of
 * the signals the settings order by (its last real open or click, the last
 * transactional mail it got, its order property as a date), a future one
 * read as now; null when it has none, which is unknown rather than inactive.
 */
export function contactActivity(
  s: OrderSettings,
  signals: { engagedAt: Date | null; transactionalAt: Date | null; propertyAt: Date | null },
  now: Date,
): Date | null {
  const times = [
    s.orderByEngagement ? signals.engagedAt : null,
    s.orderByTransactional ? signals.transactionalAt : null,
    s.orderProperty ? signals.propertyAt : null,
  ].flatMap((at) => (at ? [at.getTime()] : []));
  return times.length > 0 ? new Date(Math.min(Math.max(...times), now.getTime())) : null;
}

/** contactActivity in SQL over `contacts`, `transactionalAt` naming the joined transactional time; null when nothing orders. */
function activitySql(s: OrderSettings, transactionalAt: SQL | null): SQL | null {
  const parts = [
    s.orderByEngagement ? sql`${schema.contacts.lastEngagedAt}` : null,
    s.orderByTransactional ? transactionalAt : null,
    s.orderProperty ? contactPropertyDateSql(s.orderProperty) : null,
  ].filter((part): part is SQL => part !== null);
  return parts.length > 0 ? sql`greatest(${sql.join(parts, sql`, `)})` : null;
}

const inactiveBefore = (now: Date) => new Date(now.getTime() - WARMUP_INACTIVE_DAYS * DAY_MS);

export function isInactiveContact(activity: Date | null, now: Date): boolean {
  return activity !== null && activity < inactiveBefore(now);
}

/**
 * A warm-up row's place in line: minus its contact's activity in epoch
 * seconds, an unknown one placed at the inactive line, so active contacts
 * go first (the newest activity first), then unknown, then inactive.
 */
export function warmupSendOrder(activity: Date | null, now: Date): number {
  return -Math.floor((activity ?? inactiveBefore(now)).getTime() / 1000);
}

const WENT_OUT = ["sent", "delivered", "delivery_delayed", "opened", "clicked"] as const;
/** The address contacts store for a send's first recipient: inside the angle brackets when a display name wraps it. */
const firstRecipientAddress = sql`lower(btrim(coalesce(substring(${schema.emails.to}->>0 from ${"<([^<>]+)>\\s*$"}), ${schema.emails.to}->>0)))`;

/** The team's transactional mail of the last 30 days that went out: (address, at), the newest per address. */
function recentTransactional(teamId: string, now: Date): SQL {
  const e = schema.emails;
  const since = new Date(now.getTime() - TRANSACTIONAL_WINDOW_DAYS * DAY_MS).toISOString();
  return sql`select ${firstRecipientAddress} as address, max(${e.createdAt}) as at
    from ${e}
    where ${e.teamId} = ${teamId} and ${e.broadcastId} is null
      and ${e.createdAt} >= ${since}::timestamptz
      and ${e.latestStatus} in ${WENT_OUT}
    group by 1`;
}

const TRANSACTIONAL_MAP_MAX = 500_000;

/**
 * recentTransactional as a map by lowercased address, for the fan-out.
 * ponytail: holds the newest 500,000 addresses in memory, so a team that
 * mails more people than that in a month orders the rest without this
 * signal; join recentTransactional per page in SQL if one ever does.
 */
export async function recentTransactionalByAddress(
  db: Db,
  teamId: string,
  now: Date,
): Promise<Map<string, Date>> {
  const rows = resultRows<{ address: string; at_ms: number | string }>(
    await db.execute(sql`
      select address, (extract(epoch from at) * 1000)::float8 as at_ms
      from (${recentTransactional(teamId, now)}) tx
      order by at desc
      limit ${TRANSACTIONAL_MAP_MAX}
    `),
  );
  return new Map(rows.map((r) => [r.address, new Date(Number(r.at_ms))]));
}

/**
 * The contacts `where` matches over `contacts`, how many of them read as
 * inactive by `s` (the fan-out's rule, in SQL), and how many have its order
 * property as a date (null when it orders by none).
 */
async function audienceCounts(
  db: Db,
  teamId: string,
  where: SQL,
  s: OrderSettings,
  now: Date,
): Promise<{ total: number; inactive: number; withProperty: number | null }> {
  const c = schema.contacts;
  const tx = s.orderByTransactional ? recentTransactional(teamId, now) : null;
  const activity = activitySql(s, tx ? sql`tx.at` : null);
  const row = firstRow<{ total: number; inactive: number; with_property: number | null }>(
    await db.execute(sql`
      ${tx ? sql`with tx as (${tx})` : sql``}
      select count(*)::int as total,
        ${activity ? sql`count(*) filter (where ${activity} < ${inactiveBefore(now).toISOString()}::timestamptz)::int` : sql`0`} as inactive,
        ${s.orderProperty ? sql`count(${contactPropertyDateSql(s.orderProperty)})::int` : sql`null::int`} as with_property
      from ${c}
      ${tx ? sql`left join tx on tx.address = lower(${c.email})` : sql``}
      where ${where}
    `),
  );
  return {
    total: Number(row?.total ?? 0),
    inactive: Number(row?.inactive ?? 0),
    withProperty: row?.with_property == null ? null : Number(row.with_property),
  };
}

export interface WarmupPlan {
  /** Each UTC day from the start until the last email, with how many of this send go out on it. */
  perDay: { day: string; count: number }[];
  /** Days the send spans from its start, as the region planner counts them; 0 while paused. */
  days: number;
  /** When the last one goes out; null while the warm-up is paused or past the plan's reach. */
  finishesAt: Date | null;
}

export interface WarmupPlanInput {
  /** When the send starts. */
  now: Date;
  paused: boolean;
  volume: number;
  dailyTarget: number;
  /** The warm-up's row for the start's UTC day, once the drain opened it. */
  today: { day: string; allowance: number; sent: number } | null;
  /** The domain's warm-up mail already waiting, which goes first. */
  waitingAhead: number;
  count: number;
}

/**
 * How a send from a warming domain goes out: each day releases its
 * allowance (growing 1.5 times a day to the target) at a 48th of it per
 * 15-minute drain run, from the start of the day or from now on the first
 * one, and the mail already waiting goes first.
 */
export function planWarmupDays(input: WarmupPlanInput): WarmupPlan {
  if (input.paused || input.count <= 0) return { perDay: [], days: 0, finishesAt: null };
  const perDay: WarmupPlan["perDay"] = [];
  const firstDay = utcDay(input.now);
  let volume = input.volume;
  let ahead = input.waitingAhead;
  let left = input.count;
  for (let i = 0; left > 0 && i < PLAN_MAX_DAYS; i += 1) {
    const start = dayStartMs(firstDay) + i * DAY_MS;
    const known = i === 0 && input.today?.day === firstDay ? input.today : null;
    const allowance = known?.allowance ?? volume;
    const slice = Math.ceil(allowance / WARMUP_SLICES_PER_DAY);
    const from = i === 0 ? input.now.getTime() : start;
    const runs = Math.ceil((start + DAY_MS - from) / SES_QUOTA_SLOT_MS);
    const room = Math.max(0, Math.min(allowance - (known?.sent ?? 0), slice * runs));
    const drained = Math.min(ahead, room);
    const mine = Math.min(left, room - drained);
    ahead -= drained;
    left -= mine;
    perDay.push({ day: utcDay(start), count: mine });
    if (left === 0) {
      const lastRun = Math.ceil((drained + mine) / slice) - 1;
      const finishesAt = new Date(from + lastRun * SES_QUOTA_SLOT_MS);
      const days = Math.max(1, Math.ceil((finishesAt.getTime() - input.now.getTime()) / DAY_MS));
      return { perDay, days, finishesAt };
    }
    volume = movedWarmupVolume(volume, "grow", input.dailyTarget);
  }
  return { perDay, days: perDay.length, finishesAt: null };
}

/**
 * planWarmupDays over a domain's live warm-up for `count` emails starting
 * `at`, behind the domain's mail already waiting (for a `broadcastId`, only
 * the broadcasts the drain lets out before it); null unless it is warming
 * or paused.
 */
export async function planDomainWarmup(
  db: Db,
  input: { teamId: string; domainId: string; count: number; broadcastId?: string; at?: Date },
): Promise<WarmupPlan | null> {
  const row = await getWarmup(db, input.teamId, input.domainId);
  if (!row || (row.status !== "warming" && row.status !== "paused")) return null;
  const at = input.at ?? new Date();
  const [today, waitingAhead] = await Promise.all([
    dayRow(db, input.domainId, utcDay(at)),
    waitingCount(db, input.teamId, input.domainId, input.broadcastId),
  ]);
  return planWarmupDays({
    now: at,
    paused: row.status === "paused",
    volume: row.volume,
    dailyTarget: row.dailyTarget,
    today: today ?? null,
    waitingAhead,
    count: input.count,
  });
}

export interface WarmupOverview {
  /** "off" when the domain has no warm-up row. */
  status: WarmupStatus;
  /** The row's settings, or the defaults a warm-up turned on now would start with. */
  settings: WarmupSettings;
  volume: number;
  sendingDays: number;
  startedAt: Date | null;
  pausedAt: Date | null;
  /** The signals that paused it; null when the team paused it. */
  pauseSignals: WarmupSignals | null;
  doneAt: Date | null;
  /** Today's allowance and what went out against it, while warming or paused; `checked` once yesterday is. */
  today: { day: string; allowance: number; sent: number; checked: boolean } | null;
  /** The newest 60 day rows, newest first. */
  days: Pick<DayRow, "day" | "allowance" | "sent" | "outcome" | "signals" | "checkedAt">[];
  latestSignals: WarmupSignals | null;
  /** The volume of each next day while delivery stays healthy, until the target. */
  projection: { day: string; volume: number }[];
  /** This domain's broadcast mail waiting on a warm-up. */
  waiting: number;
  bestDay: number;
  audience: {
    /** The team's subscribed contacts. */
    total: number;
    /** Of those, inactive by the settings. */
    inactive: number;
    /** Of those, with the order property as a date; null when no order property is set. */
    withProperty: number | null;
  };
  openTracking: boolean;
}

/** Everything the domain page's warm-up tab shows, in one call; null when the domain is not the team's. */
export async function warmupOverview(
  db: Db,
  input: { teamId: string; domainId: string; now?: Date },
): Promise<WarmupOverview | null> {
  const now = input.now ?? new Date();
  const domain = await teamDomain(db, input.teamId, input.domainId);
  if (!domain) return null;
  const row = await getWarmup(db, input.teamId, input.domainId);
  const d = schema.domainWarmupDays;
  const [days, waiting, best, audience] = await Promise.all([
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
      .where(eq(d.domainId, input.domainId))
      .orderBy(desc(d.day))
      .limit(HISTORY_DAYS),
    waitingCount(db, input.teamId, input.domainId),
    bestDay(db, input.teamId, input.domainId, now),
    audienceCounts(
      db,
      input.teamId,
      broadcastAudienceWhere(input.teamId, null, null),
      row ?? DEFAULT_ORDER,
      now,
    ),
  ]);
  const settings = row ? settingsOf(row) : defaultSettings(best, audience.total);
  const live = row && (row.status === "warming" || row.status === "paused") ? row : null;
  const today = utcDay(now);
  const opened = days.find((x) => x.day === today);
  const projection: WarmupOverview["projection"] = [];
  if (row?.status !== "done") {
    let volume = live?.volume ?? settings.startVolume;
    let day = today;
    while (volume < settings.dailyTarget && projection.length < PLAN_MAX_DAYS) {
      volume = movedWarmupVolume(volume, "grow", settings.dailyTarget);
      day = nextDay(day);
      projection.push({ day, volume });
    }
  }
  return {
    status: row?.status ?? "off",
    settings,
    volume: row?.volume ?? settings.startVolume,
    sendingDays: row?.sendingDays ?? 0,
    startedAt: row?.startedAt ?? null,
    pausedAt: row?.pausedAt ?? null,
    pauseSignals: row?.pauseSignals ?? null,
    doneAt: row?.doneAt ?? null,
    today: live
      ? {
          day: today,
          allowance: opened?.allowance ?? live.volume,
          sent: opened?.sent ?? 0,
          checked: (live.checkedThrough ?? "") >= yesterdayOf(now),
        }
      : null,
    days,
    latestSignals: days.find((x) => x.signals)?.signals ?? null,
    projection,
    waiting,
    bestDay: best,
    audience,
    openTracking: domain.openTracking,
  };
}

export interface WarmupSendPreview {
  status: WarmupStatus;
  bestDay: number;
  /** The send's audience. */
  eligible: number;
  /** Of those, inactive by the warm-up's settings (the defaults while it has none). */
  inactive: number;
  /** How the send goes out while the warm-up is warming or paused; null otherwise. */
  plan: WarmupPlan | null;
}

/**
 * What warm-up would do for a broadcast from this domain to an audience
 * (the fan-out's own predicate, segment and topic included), starting `at`:
 * the plan leaves out the inactive contacts the warm-up skips. Null when the
 * domain, segment or topic is not the team's.
 */
export async function warmupSendPreview(
  db: Db,
  input: {
    teamId: string;
    domainId: string;
    segmentId: string | null;
    topicId: string | null;
    at?: Date;
    now?: Date;
  },
): Promise<WarmupSendPreview | null> {
  const now = input.now ?? new Date();
  if (!(await teamDomain(db, input.teamId, input.domainId))) return null;
  const where = await broadcastAudience(db, input.teamId, input);
  if (!where) return null;
  const row = await getWarmup(db, input.teamId, input.domainId);
  const order = row ?? DEFAULT_ORDER;
  const [best, audience] = await Promise.all([
    bestDay(db, input.teamId, input.domainId, now),
    audienceCounts(db, input.teamId, where, order, now),
  ]);
  return {
    status: row?.status ?? "off",
    bestDay: best,
    eligible: audience.total,
    inactive: audience.inactive,
    plan: await planDomainWarmup(db, {
      teamId: input.teamId,
      domainId: input.domainId,
      count: audience.total - (order.skipInactive ? audience.inactive : 0),
      at: input.at ?? now,
    }),
  };
}
