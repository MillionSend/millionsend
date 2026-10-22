import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { emailRecipientsSql } from "./accept-email.js";
import { heldByNewDomainLimit, mayWarmUp, warmupCap, warmupSteps } from "./domain-warmup.js";
import { DAY_MS, nextUtcDayStart, utcDay } from "./utc-day.js";

export interface NewDomainLimitStep {
  /** When this daily cap applies from; the first step is today's, from `now`. */
  from: Date;
  /** Emails a day; null from the step that ends the limit. */
  cap: number | null;
}

/** The new domain limit on one domain, as volumes and dates, never a tier. */
export interface NewDomainLimit {
  domainId: string;
  name: string;
  /** Today's cap, and what the domain's registrable name used of it today. */
  cap: number;
  used: number;
  /** The one daily limit the team's new domains share, when more than one shares it. */
  pool: { cap: number; used: number; domains: number } | null;
  /** Its mail the limit holds right now. */
  waiting: number;
  /** The next 00:00 UTC, when the day's counters start over. */
  resetsAt: Date;
  registeredAt: Date | null;
  steps: NewDomainLimitStep[];
  /** When the calendar lifts the limit; null for an unknown age. */
  fullAt: Date | null;
}

/**
 * The new domain limit on each of a team's verified domains under it at
 * `now`, in name order, or on those of `domainIds` that are; a domain the
 * limit does not apply to is left out.
 */
export async function newDomainLimitStatus(
  db: Db,
  input: { teamId: string; domainIds?: readonly string[]; now?: Date },
): Promise<NewDomainLimit[]> {
  if (input.domainIds?.length === 0) return [];
  const now = input.now ?? new Date();
  const d = schema.domains;
  const candidates = await db
    .select({ id: d.id, name: d.name, registeredAt: d.registeredAt })
    .from(d)
    .where(
      and(
        eq(d.teamId, input.teamId),
        mayWarmUp(now),
        input.domainIds ? inArray(d.id, [...input.domainIds]) : undefined,
      ),
    )
    .orderBy(d.name);
  const limited = [];
  for (const row of candidates) {
    const cap = await warmupCap(db, { teamId: input.teamId, domainId: row.id, at: now });
    if (cap) limited.push({ row, cap });
  }
  if (limited.length === 0) return [];
  const day = utcDay(now);
  const u = schema.domainWarmupUsage;
  const usage = await db
    .select({ key: u.registrableDomain, accepted: u.accepted })
    .from(u)
    .where(
      and(
        eq(u.day, day),
        inArray(u.registrableDomain, [...new Set(limited.map((l) => l.cap.key))]),
      ),
    );
  let poolUsed = 0;
  if (limited.some((l) => l.cap.poolDomains > 1)) {
    const p = schema.teamWarmupUsage;
    const [row] = await db
      .select({ accepted: p.accepted })
      .from(p)
      .where(and(eq(p.teamId, input.teamId), eq(p.day, day)));
    poolUsed = row?.accepted ?? 0;
  }
  const e = schema.emails;
  const held = await db
    .select({ domainId: e.domainId, n: sql<number>`count(*)::int` })
    .from(e)
    .where(
      and(
        eq(e.teamId, input.teamId),
        heldByNewDomainLimit(),
        inArray(
          e.domainId,
          limited.map((l) => l.row.id),
        ),
      ),
    )
    .groupBy(e.domainId);
  const resetsAt = nextUtcDayStart(now);
  const out: NewDomainLimit[] = [];
  for (const { row, cap } of limited) {
    out.push({
      domainId: row.id,
      name: row.name,
      cap: cap.cap,
      used: usage.find((x) => x.key === cap.key)?.accepted ?? 0,
      pool:
        cap.poolDomains > 1 ? { cap: cap.pool, used: poolUsed, domains: cap.poolDomains } : null,
      waiting: held.find((h) => h.domainId === row.id)?.n ?? 0,
      resetsAt,
      registeredAt: row.registeredAt,
      steps: await warmupSteps(db, cap, row.registeredAt, now),
      fullAt: cap.fullAt,
    });
  }
  return out;
}

/** The cap on `day` by the schedule; an unknown age has none, so today's stands in. */
function capOn(limit: NewDomainLimit, day: Date): number | null {
  const step = limit.steps.findLast((s) => s.from <= day);
  const cap = step ? step.cap : limit.cap;
  return cap === null ? null : Math.max(1, cap);
}

/**
 * When the first `units` recipients of a domain's line have gone out: `now`
 * while today's room covers them, else the 00:00 UTC of the first day whose
 * cap does.
 */
function sendsAfterIn(limit: NewDomainLimit, units: number, now: Date): Date {
  const room = Math.min(
    limit.cap - limit.used,
    limit.pool ? limit.pool.cap - limit.pool.used : Number.POSITIVE_INFINITY,
  );
  if (units <= room) return now;
  let left = units;
  for (let day = limit.resetsAt; ; day = new Date(day.getTime() + DAY_MS)) {
    const cap = capOn(limit, day);
    if (cap === null || left <= cap) return day;
    left -= cap;
  }
}

export interface NewDomainLimitEta {
  /** Held emails of its domain the drain lets out before it. */
  ahead: number;
  sendsAfter: Date;
  /** Its domain's limit, as newDomainLimitStatus reads it. */
  limit: NewDomainLimit;
}

/**
 * Where each email the new domain limit holds stands in line, by id: how
 * many held emails of its domain the drain lets out before it (transactional
 * first, then oldest first), and when it goes out (sendsAfterIn, never
 * before its scheduled_at). An email the limit does not hold, or whose
 * domain is no longer under it, is left out. One status read and one line
 * read per domain, however many emails.
 * ponytail: one domain's line against its own schedule. Mail accepted after
 * the reset, the pool's other domains and the drain's per-run budget are
 * left out, so a busy domain goes out later than this says; model them here
 * if the estimate keeps landing early.
 */
export async function newDomainLimitEtas(
  db: Db,
  input: { teamId: string; emailIds: readonly string[]; now?: Date },
): Promise<Map<string, NewDomainLimitEta>> {
  const out = new Map<string, NewDomainLimitEta>();
  if (input.emailIds.length === 0) return out;
  const now = input.now ?? new Date();
  const e = schema.emails;
  const held = await db
    .select({ id: e.id, domainId: e.domainId, scheduledAt: e.scheduledAt })
    .from(e)
    .where(
      and(eq(e.teamId, input.teamId), inArray(e.id, [...input.emailIds]), heldByNewDomainLimit()),
    );
  const domainIds = [...new Set(held.flatMap((h) => (h.domainId ? [h.domainId] : [])))];
  const limits = await newDomainLimitStatus(db, { teamId: input.teamId, domainIds, now });
  // The caps count recipients, so the line is measured in them too.
  const recipients = emailRecipientsSql();
  const order = sql`order by ${e.broadcastId} is not null, ${e.createdAt}, ${e.id}`;
  for (const limit of limits) {
    const line = db
      .select({
        id: e.id,
        ahead: sql<number>`(row_number() over (${order}) - 1)::int`.as("ahead"),
        units: sql<number>`(sum(${recipients}) over (${order}))::int`.as("units"),
      })
      .from(e)
      .where(
        and(eq(e.teamId, input.teamId), eq(e.domainId, limit.domainId), heldByNewDomainLimit()),
      )
      .as("line");
    const mine = held.filter((h) => h.domainId === limit.domainId);
    const rows = await db
      .select()
      .from(line)
      .where(
        inArray(
          line.id,
          mine.map((h) => h.id),
        ),
      );
    for (const row of rows) {
      const walked = sendsAfterIn(limit, row.units, now);
      const scheduledAt = mine.find((h) => h.id === row.id)?.scheduledAt;
      out.set(row.id, {
        ahead: row.ahead,
        sendsAfter: scheduledAt && scheduledAt > walked ? scheduledAt : walked,
        limit,
      });
    }
  }
  return out;
}

/** newDomainLimitEtas for one email; null when the limit does not hold it. */
export async function newDomainLimitEta(
  db: Db,
  input: { teamId: string; emailId: string; now?: Date },
): Promise<{ ahead: number; sendsAfter: Date } | null> {
  const etas = await newDomainLimitEtas(db, {
    teamId: input.teamId,
    emailIds: [input.emailId],
    ...(input.now ? { now: input.now } : {}),
  });
  const eta = etas.get(input.emailId);
  return eta ? { ahead: eta.ahead, sendsAfter: eta.sendsAfter } : null;
}
