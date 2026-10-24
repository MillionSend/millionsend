import { env } from "@millionsend/config";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, gte, inArray, isNull, lt, ne, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  loadMonitorState,
  MONITOR_HOLD_CATEGORIES,
  MONITOR_HOLD_REASONS,
  monitorTier,
  teamMonitorRow,
} from "./abuse-monitor.js";
import { firstRow } from "./driver-result.js";
import { SES_MAILBOX_SIMULATOR_DOMAIN } from "./mailbox-providers.js";
import {
  getMonitorSettingsRow,
  type MonitorSettings,
  resolveMonitorSettings,
} from "./monitor-settings.js";
import { ownerDomain } from "./org-domain.js";
import { complaintFilter, hardBounceFilter, recipientDomains } from "./platform-breaker.js";
import { DAY_MS, utcDay } from "./utc-day.js";

/**
 * The new-domain warm-up: a daily cap per registrable domain while it is
 * young, so a domain registered minutes before signup cannot burst, and one
 * daily limit a team's warming domains share, the highest of their caps, so
 * several fresh domains never multiply it. Mail over either parks like
 * over-quota mail and drains as both allow; no plan lifts them. Tiers by
 * registration age: under a day, under a week, under thirty days; past
 * that, no cap.
 */

/** Tier i applies while the domain is younger than WARMUP_TIER_DAYS[i] days; past the last, none. */
const WARMUP_TIER_DAYS = [1, 7, 30] as const;
export const WARMUP_FULL_TIER = WARMUP_TIER_DAYS.length;
/** An unknown age reads as the 1–7 day tier for a team the monitor still counts as new. */
const UNKNOWN_AGE_TIER = 1;

/**
 * Early graduation (the SES, Mailjet and Brevo pattern): this many delivered
 * sends since the last tier change, under these hard-bounce and complaint
 * rates, move a domain up one tier ahead of the calendar.
 */
const WARMUP_GRADUATION_SENDS = 50;
const WARMUP_GRADUATION_MAX_BOUNCE_RATE = 0.02;
const WARMUP_GRADUATION_MAX_COMPLAINT_RATE = 0.001;
/** A send counts toward graduation once its bounce has had time to come back. */
const WARMUP_GRADUATION_SETTLE_MS = 3600_000;
/**
 * A step also needs a day of sending behind it: the window's first delivered
 * send at least this old. Complaints and verdicts lag the send and a phishing
 * domain is spent within hours, so a few clean seed sends to the sender's own
 * inboxes must not lift a fresh domain to full volume on its first day.
 */
const WARMUP_GRADUATION_MIN_SPAN_MS = DAY_MS;

/** The registration age's tier at `at`. */
export function ageTier(registeredAt: Date, at: Date): number {
  const days = (at.getTime() - registeredAt.getTime()) / DAY_MS;
  const tier = WARMUP_TIER_DAYS.findIndex((limit) => days < limit);
  return tier === -1 ? WARMUP_FULL_TIER : tier;
}

/** When the calendar put a domain registered at `registeredAt` into `tier`. */
function tierStart(registeredAt: Date, tier: number): Date {
  return new Date(registeredAt.getTime() + (WARMUP_TIER_DAYS[tier - 1] ?? 0) * DAY_MS);
}

function capOf(s: MonitorSettings, tier: number): number {
  return [s.warmupCapFirstDay, s.warmupCapFirstWeek, s.warmupCapFirstMonth][tier] ?? 0;
}

async function warmupSettings(db: Db): Promise<MonitorSettings> {
  const row = await getMonitorSettingsRow(db);
  return resolveMonitorSettings(row, env as unknown as Record<string, unknown>).settings;
}

/**
 * Domain rows that may still warm up at `at`: verified, not trusted, under
 * the last step by age and by graduation.
 */
export function mayWarmUp(at: Date): SQL | undefined {
  const d = schema.domains;
  return and(
    eq(d.status, "verified"),
    isNull(d.warmupTrustedAt),
    or(
      isNull(d.registeredAt),
      gte(d.registeredAt, new Date(at.getTime() - WARMUP_TIER_DAYS[2] * DAY_MS)),
    ),
    or(isNull(d.warmupTier), lt(d.warmupTier, WARMUP_FULL_TIER)),
  );
}

interface TierColumns {
  registeredAt: Date | null;
  earned: number | null;
  trustedAt: Date | null;
}

/**
 * A domain row's tier at `at` from its own columns: null when it sends at
 * full volume, "unknown" when only its team's standing can tell.
 */
function rowTier(row: TierColumns, at: Date): number | "unknown" | null {
  const earned = row.earned ?? 0;
  if (row.trustedAt || earned >= WARMUP_FULL_TIER) return null;
  if (!row.registeredAt) return "unknown";
  const tier = Math.max(ageTier(row.registeredAt, at), earned);
  return tier >= WARMUP_FULL_TIER ? null : tier;
}

export interface WarmupCap {
  /** The registrable domain (ownerDomain) whose daily counter the cap runs against. */
  key: string;
  cap: number;
  tier: number;
  /**
   * When the calendar alone lifts the cap; clean sends can lift it sooner.
   * Null for an unknown age, which lifts with the team's sending history.
   */
  fullAt: Date | null;
  /** The team whose shared daily counter the pool runs against. */
  teamId: string;
  /** The daily limit the team's warming domains share: the highest of their caps. */
  pool: number;
  /** The team's warming domains sharing the pool, this one included. */
  poolDomains: number;
}

/**
 * The warm-up cap on a send from `domainId` at `at`, null when none applies:
 * the instance's own team, an operator's trust, an old domain, the switch
 * off. An unknown age (no source had a date, or the lookup has not landed)
 * is the 1–7 day tier for a team the monitor counts as new or on probation,
 * and no cap for an established one. With it, the pool: the highest cap
 * among the team's verified domains warming up, this one included, since a
 * domain that cannot send must not raise what the others may.
 */
export async function warmupCap(
  db: Db,
  input: { teamId: string; domainId: string | null; at: Date },
): Promise<WarmupCap | null> {
  if (!input.domainId) return null;
  const d = schema.domains;
  const t = schema.teams;
  const tierColumns = {
    registeredAt: d.registeredAt,
    earned: d.warmupTier,
    trustedAt: d.warmupTrustedAt,
  };
  const [row] = await db
    .select({ name: d.name, ...tierColumns, teamTrustedAt: t.warmupTrustedAt, plan: t.plan })
    .from(d)
    .innerJoin(t, eq(t.id, d.teamId))
    .where(and(eq(d.id, input.domainId), eq(d.teamId, input.teamId)));
  // An old domain is answered from its row alone: no settings read on the common path.
  if (!row || row.plan === "system" || row.teamTrustedAt || rowTier(row, input.at) === null) {
    return null;
  }
  const s = await warmupSettings(db);
  if (!s.warmupEnabled) return null;
  let teamIsNew: Promise<boolean> | undefined;
  const tierOf = async (r: TierColumns): Promise<number | null> => {
    const tier = rowTier(r, input.at);
    if (tier !== "unknown") return tier;
    teamIsNew ??= (async () => {
      const monitor = await teamMonitorRow(db, input.teamId);
      const standing = monitorTier(await loadMonitorState(db, monitor, input.at), s, input.at);
      return standing === "new" || standing === "probation";
    })();
    return (await teamIsNew) ? Math.max(UNKNOWN_AGE_TIER, r.earned ?? 0) : null;
  };
  const tier = await tierOf(row);
  if (tier === null) return null;
  // Read only once the sending domain warms up: a send from an old domain
  // never scans the team's domains, however many it has.
  const others = await db
    .select(tierColumns)
    .from(d)
    .where(and(eq(d.teamId, input.teamId), ne(d.id, input.domainId), mayWarmUp(input.at)));
  let pool = capOf(s, tier);
  let poolDomains = 1;
  for (const other of others) {
    const otherTier = await tierOf(other);
    if (otherTier === null) continue;
    pool = Math.max(pool, capOf(s, otherTier));
    poolDomains += 1;
  }
  return {
    key: ownerDomain(row.name),
    cap: capOf(s, tier),
    tier,
    fullAt: row.registeredAt ? tierStart(row.registeredAt, WARMUP_FULL_TIER) : null,
    teamId: input.teamId,
    pool,
    poolDomains,
  };
}

/**
 * The days ahead under a domain's cap: today's cap from `at`, each later
 * tier's cap from when the registration age reaches it, then no cap (null)
 * from fullAt. Empty for an unknown age, which lifts with the team's sending
 * history instead. Clean sends can move a step sooner than it says.
 */
export async function warmupSteps(
  db: Db,
  cap: WarmupCap,
  registeredAt: Date | null,
  at: Date,
): Promise<{ from: Date; cap: number | null }[]> {
  if (!registeredAt || !cap.fullAt) return [];
  const s = await warmupSettings(db);
  const steps: { from: Date; cap: number | null }[] = [{ from: at, cap: cap.cap }];
  for (let tier = cap.tier + 1; tier < WARMUP_FULL_TIER; tier += 1) {
    steps.push({ from: tierStart(registeredAt, tier), cap: capOf(s, tier) });
  }
  steps.push({ from: cap.fullAt, cap: null });
  return steps;
}

/**
 * Mail the new domain limit holds: parked for the warm-up, less the
 * broadcast copies of a domain whose reputation warm-up is warming or
 * paused, which park with the same reason and go out by that warm-up's own
 * day. The silent holds park with reasons of their own and never match, so
 * they keep reading as a plain wait. The one definition for every surface
 * that counts or labels these rows, as a condition on the query's `emails`.
 */
export function heldByNewDomainLimit(): SQL {
  const e = schema.emails;
  const w = schema.domainWarmups;
  return sql`(${e.latestStatus} = 'queued_quota' and ${e.parkReason} = 'warmup' and (${e.broadcastId} is null or ${e.domainId} not in (select ${w.domainId} from ${w} where ${w.status} in ('warming', 'paused'))))`;
}

type ColumnValues = readonly (readonly [AnyPgColumn, unknown])[];

/**
 * One guarded counter upsert, the pattern of reserveDailyQuota: the row
 * `key` names takes `count` more on `counter` only while it stays within
 * `limit`, which the statement reads itself so racing reservations never
 * overshoot it. An absent row is created with the key, `fill` and the
 * count; the caller checks that the count fits a fresh row. True when the
 * count was taken.
 */
export async function addWithinLimit(
  db: Db,
  input: {
    counter: AnyPgColumn;
    key: ColumnValues;
    fill?: ColumnValues;
    count: number;
    limit: number | SQL;
  },
): Promise<boolean> {
  const values = [...input.key, ...(input.fill ?? []), [input.counter, input.count] as const];
  const names = (pairs: ColumnValues) =>
    sql.join(
      pairs.map(([column]) => sql.identifier(column.name)),
      sql`, `,
    );
  const rows = await db.execute(sql`
    insert into ${input.counter.table} (${names(values)})
    values (${sql.join(
      values.map(([, value]) => sql`${value}`),
      sql`, `,
    )})
    on conflict (${names(input.key)}) do update
      set ${sql.identifier(input.counter.name)} = ${input.counter} + ${input.count}
      where ${input.counter} + ${input.count} <= ${input.limit}
    returning 1 as taken
  `);
  return firstRow(rows) !== undefined;
}

export type WarmupReservation = { reserved: true } | { reserved: false; full: "domain" | "pool" };

/**
 * Reserve `count` recipients against the domain's cap and the team's pool
 * for `day`, each limit re-checked inside its upsert like reserveDailyQuota.
 * When either is full nothing stays reserved, and `full` names which. A row
 * SES later parks, or a stop cancels, keeps its charge for the day: the
 * error only ever holds more.
 */
export async function reserveWarmup(
  db: Db,
  cap: WarmupCap,
  count: number,
  day: string,
): Promise<WarmupReservation> {
  if (count > cap.cap) return { reserved: false, full: "domain" };
  // The team's row before any domain's: a batch holding one young domain
  // must never wait on a send holding another while that send waits on the
  // batch. The pool is never below the domain's cap, so a first insert fits.
  const p = schema.teamWarmupUsage;
  const pool = await addWithinLimit(db, {
    counter: p.accepted,
    key: [
      [p.teamId, cap.teamId],
      [p.day, day],
    ],
    count,
    limit: cap.pool,
  });
  if (!pool) return { reserved: false, full: "pool" };
  const u = schema.domainWarmupUsage;
  const domain = await addWithinLimit(db, {
    counter: u.accepted,
    key: [
      [u.registrableDomain, cap.key],
      [u.day, day],
    ],
    count,
    limit: cap.cap,
  });
  if (domain) return { reserved: true };
  // The caller commits the park, so the pool's charge goes back here.
  await db
    .update(p)
    .set({ accepted: sql`${p.accepted} - ${count}` })
    .where(and(eq(p.teamId, cap.teamId), eq(p.day, day)));
  return { reserved: false, full: "domain" };
}

type WarmupAdmission = { admitted: true } | { admitted: false; cap: WarmupCap };

/**
 * The warm-up gate, run once the team's plan admitted a send: under the
 * sending domain's cap and the team's pool for the delivery day it goes;
 * over either, the caller hands the plan's reservation back and parks the
 * mail with reason "warmup". Every send surface comes through here or
 * through warmupCap and reserveWarmup (accept, batch, broadcast fan-out,
 * the drain).
 */
export async function admitWarmup(
  db: Db,
  input: { teamId: string; domainId: string | null; count: number; at: Date },
): Promise<WarmupAdmission> {
  const cap = await warmupCap(db, input);
  if (!cap || (await reserveWarmup(db, cap, input.count, utcDay(input.at))).reserved) {
    return { admitted: true };
  }
  return { admitted: false, cap };
}

/**
 * Early graduation, run by the safety cron: a domain still warming up moves
 * one tier up when its settled sends since its last tier change are clean —
 * at least WARMUP_GRADUATION_SENDS delivered, the first a day old, hard
 * bounces and complaints under their lines, and no phishing-type verdict from
 * the content monitor on its team. Rows sharing a registrable domain move
 * together, on their pooled sends, as they share a counter. Returns the
 * registrable domains that moved.
 */
export async function graduateWarmupDomains(db: Db, now: Date = new Date()): Promise<string[]> {
  if (!(await warmupSettings(db)).warmupEnabled) return [];
  const d = schema.domains;
  const rows = await db
    .select({
      id: d.id,
      teamId: d.teamId,
      name: d.name,
      registeredAt: d.registeredAt,
      earned: d.warmupTier,
      earnedAt: d.warmupTierAt,
    })
    .from(d)
    .where(mayWarmUp(now));
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = ownerDomain(row.name);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const moved: string[] = [];
  for (const [key, group] of groups) {
    const registeredAt = group.find((r) => r.registeredAt)?.registeredAt ?? null;
    const earned = Math.max(...group.map((r) => r.earned ?? 0));
    const byAge = registeredAt ? ageTier(registeredAt, now) : UNKNOWN_AGE_TIER;
    const tier = Math.max(byAge, earned);
    if (tier >= WARMUP_FULL_TIER) continue;
    const earnedAt = Math.max(0, ...group.map((r) => r.earnedAt?.getTime() ?? 0));
    const since = new Date(
      earned >= byAge || !registeredAt ? earnedAt : tierStart(registeredAt, byAge).getTime(),
    );
    if (!(await cleanSince(db, group, since, now))) continue;
    await db
      .update(d)
      .set({ warmupTier: tier + 1, warmupTierAt: now })
      .where(
        inArray(
          d.id,
          group.map((r) => r.id),
        ),
      );
    moved.push(key);
  }
  return moved;
}

async function cleanSince(
  db: Db,
  group: { id: string; teamId: string }[],
  since: Date,
  now: Date,
): Promise<boolean> {
  const e = schema.emails;
  const teams = [...new Set(group.map((r) => r.teamId))];
  const spanStart = new Date(now.getTime() - WARMUP_GRADUATION_MIN_SPAN_MS).toISOString();
  // Spelled out: inside a subquery drizzle leaves column names unqualified,
  // and emails and email_events both have an id.
  const delivered = sql`exists (select 1 from email_events ev where ev.email_id = emails.id and ev.type = 'delivered')`;
  const bounced = sql`exists (select 1 from email_events where email_events.email_id = emails.id and ${hardBounceFilter})`;
  const [sends] = await db
    .select({
      delivered: sql<number>`count(*) filter (where ${delivered})::int`,
      dayOld: sql<number>`count(*) filter (where ${delivered} and emails.sent_at <= ${spanStart}::timestamptz)::int`,
      deliveredOrBounced: sql<number>`count(*) filter (where ${delivered} or ${bounced})::int`,
      bounced: sql<number>`count(*) filter (where ${bounced})::int`,
      complained: sql<number>`count(*) filter (where exists (select 1 from email_events where email_events.email_id = emails.id and ${complaintFilter}))::int`,
    })
    .from(e)
    .where(
      and(
        inArray(e.teamId, teams),
        inArray(
          e.domainId,
          group.map((r) => r.id),
        ),
        gte(e.sentAt, since),
        lt(e.sentAt, new Date(now.getTime() - WARMUP_GRADUATION_SETTLE_MS)),
        // Only mail that reached a real receiving server speaks for the
        // domain. A send's delivered event may be the mailbox simulator's
        // own, so a simulator address in any field leaves the send out.
        sql`not exists (select 1 from (${recipientDomains}) d where d.domain = ${SES_MAILBOX_SIMULATOR_DOMAIN})`,
      ),
    );
  if (!sends || sends.delivered < WARMUP_GRADUATION_SENDS || !sends.dayOld) return false;
  if (sends.bounced / sends.deliveredOrBounced >= WARMUP_GRADUATION_MAX_BOUNCE_RATE) return false;
  if (sends.complained / sends.delivered >= WARMUP_GRADUATION_MAX_COMPLAINT_RATE) return false;
  const ms = schema.monitorSamples;
  const verdicts = await db
    .select({ categories: ms.categories, reasons: ms.reasons })
    .from(ms)
    .where(
      and(
        inArray(ms.teamId, teams),
        eq(ms.status, "judged"),
        eq(ms.verdict, "abuse"),
        // The whole warm-up, not only since the last step: a calendar step
        // must not wash out a lure the judge saw on the first day.
        gte(ms.judgedAt, new Date(now.getTime() - WARMUP_TIER_DAYS[2] * DAY_MS)),
      ),
    );
  // A phishing-type verdict, the kinds the review hold acts on, blocks graduation.
  return !verdicts.some(
    (v) =>
      v.categories?.some((c) => (MONITOR_HOLD_CATEGORIES as readonly string[]).includes(c)) ||
      v.reasons?.some((r) => (MONITOR_HOLD_REASONS as readonly string[]).includes(r)),
  );
}

/** Counters of days gone: only today and future delivery days are ever reserved against. */
export async function pruneWarmupUsage(db: Db, now: Date = new Date()): Promise<number> {
  const before = utcDay(now.getTime() - DAY_MS);
  const u = schema.domainWarmupUsage;
  const p = schema.teamWarmupUsage;
  const domains = await db.delete(u).where(lt(u.day, before)).returning({ day: u.day });
  const teams = await db.delete(p).where(lt(p.day, before)).returning({ day: p.day });
  return domains.length + teams.length;
}

export interface DomainWarmupRow {
  id: string;
  name: string;
  status: string;
  registeredAt: Date | null;
  ageSource: string | null;
  ageCheckedAt: Date | null;
  trustedAt: Date | null;
  /** Today's cap and what it has used; null when the domain sends at full volume. */
  today: { cap: number; used: number; tier: number; fullAt: Date | null } | null;
  /** Its mail parked for the warm-up that a trust would release now. */
  waiting: number;
}

/**
 * A team's domains as the operator's review page shows their warm-up,
 * today's use of the pool they share (null while none of its verified
 * domains warms up), and the mail a trust would release now, per domain and
 * in all.
 */
export async function teamWarmupOverview(
  db: Db,
  teamId: string,
  now: Date = new Date(),
): Promise<{
  trustedAt: Date | null;
  domains: DomainWarmupRow[];
  pool: { cap: number; used: number } | null;
  waiting: number;
}> {
  const d = schema.domains;
  const [team] = await db
    .select({ trustedAt: schema.teams.warmupTrustedAt })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  const e = schema.emails;
  const parked = await db
    .select({ domainId: e.domainId, n: sql<number>`count(*)::int` })
    .from(e)
    .where(and(eq(e.teamId, teamId), heldByNewDomainLimit()))
    .groupBy(e.domainId);
  const rows = await db
    .select({
      id: d.id,
      name: d.name,
      status: d.status,
      registeredAt: d.registeredAt,
      ageSource: d.ageSource,
      ageCheckedAt: d.ageCheckedAt,
      trustedAt: d.warmupTrustedAt,
    })
    .from(d)
    .where(eq(d.teamId, teamId))
    .orderBy(d.name);
  const u = schema.domainWarmupUsage;
  const domains: DomainWarmupRow[] = [];
  let poolCap: number | null = null;
  for (const row of rows) {
    const cap = await warmupCap(db, { teamId, domainId: row.id, at: now });
    let today: DomainWarmupRow["today"] = null;
    if (cap) {
      const [usage] = await db
        .select({ accepted: u.accepted })
        .from(u)
        .where(and(eq(u.registrableDomain, cap.key), eq(u.day, utcDay(now))));
      today = { cap: cap.cap, used: usage?.accepted ?? 0, tier: cap.tier, fullAt: cap.fullAt };
      if (row.status === "verified") poolCap = cap.pool;
    }
    // Without a cap (trusted, aged out, warm-up off) the warm-up holds none of
    // its rows: what still waits there waits on the plan or the next drain.
    const waiting = today ? (parked.find((p) => p.domainId === row.id)?.n ?? 0) : 0;
    domains.push({ ...row, today, waiting });
  }
  let pool: { cap: number; used: number } | null = null;
  if (poolCap !== null) {
    const p = schema.teamWarmupUsage;
    const [usage] = await db
      .select({ accepted: p.accepted })
      .from(p)
      .where(and(eq(p.teamId, teamId), eq(p.day, utcDay(now))));
    pool = { cap: poolCap, used: usage?.accepted ?? 0 };
  }
  return {
    trustedAt: team?.trustedAt ?? null,
    domains,
    pool,
    waiting: domains.reduce((n, row) => n + row.waiting, 0),
  };
}
