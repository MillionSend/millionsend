import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, desc, gte, lt, lte, sql } from "drizzle-orm";
import { resultRows } from "./driver-result.js";
import { DAY_MS } from "./utc-day.js";

/**
 * The instance health probes the worker samples every minute. `bad` probes
 * mean the instance is not doing its job when they fail (the database, the
 * worker, KMS, SES events); `warn` ones are worth a look. `aggregate` is how
 * a history bucket folds its readings into one point: counts, sizes and
 * times draw the highest reading, so every point is one the worker took and
 * a spike stays visible; rates draw the average.
 */
export const PROBES = {
  pg_latency_ms: { severity: "bad", aggregate: "max" },
  pg_size_bytes: { severity: "warn", aggregate: "max" },
  worker_heartbeat: { severity: "bad", aggregate: "max" },
  boss_waiting: { severity: "warn", aggregate: "max" },
  boss_failed: { severity: "warn", aggregate: "max" },
  ses_events_lag_s: { severity: "bad", aggregate: "max" },
  // A transactional row parked at the SES quota line: the reserve was too
  // small for the day, and a password reset waited behind the drain.
  ses_transactional_parked: { severity: "bad", aggregate: "max" },
  webhook_success_rate: { severity: "warn", aggregate: "avg" },
  webhook_tripped: { severity: "warn", aggregate: "max" },
  kms_wrap_ms: { severity: "bad", aggregate: "max" },
  stripe_last_event_s: { severity: "warn", aggregate: "max" },
  retention_purged: { severity: "warn", aggregate: "max" },
  teams_total: { severity: "warn", aggregate: "max" },
  contacts_total: { severity: "warn", aggregate: "max" },
  contacts_unsubscribed: { severity: "warn", aggregate: "max" },
  domains_verified: { severity: "warn", aggregate: "max" },
  queue_waiting: { severity: "warn", aggregate: "max" },
  queue_quota_held: { severity: "warn", aggregate: "max" },
  queue_oldest_s: { severity: "warn", aggregate: "max" },
  monitor_samples_1h: { severity: "warn", aggregate: "max" },
  monitor_unjudged_rate: { severity: "warn", aggregate: "avg" },
} as const satisfies Record<string, { severity: "bad" | "warn"; aggregate: "max" | "avg" }>;

export type ProbeKey = keyof typeof PROBES;
export type ProbeSeverity = (typeof PROBES)[ProbeKey]["severity"];
export const PROBE_KEYS = Object.keys(PROBES) as ProbeKey[];

export function isProbeKey(value: unknown): value is ProbeKey {
  return typeof value === "string" && value in PROBES;
}

/** How long probe history is kept; the console's longest chart window. */
export const PROBE_HISTORY_DAYS = 90;

export interface ProbeSample {
  probe: ProbeKey;
  value: number | null;
  ok: boolean;
}

export async function recordProbes(
  db: Db,
  samples: readonly ProbeSample[],
  takenAt: Date = new Date(),
): Promise<void> {
  if (samples.length === 0) return;
  await db
    .insert(schema.instanceProbes)
    .values(samples.map((s) => ({ ...s, takenAt })))
    .onConflictDoNothing();
}

/** Drops samples older than the history window; returns how many went. */
export async function pruneProbes(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PROBE_HISTORY_DAYS * DAY_MS);
  const rows = await db
    .delete(schema.instanceProbes)
    .where(lt(schema.instanceProbes.takenAt, cutoff))
    .returning({ probe: schema.instanceProbes.probe });
  return rows.length;
}

export interface LatestProbe {
  probe: ProbeKey;
  value: number | null;
  ok: boolean;
  takenAt: Date;
}

/** The newest sample of every probe. */
export async function latestProbes(
  db: Db,
  now: Date = new Date(),
): Promise<Map<ProbeKey, LatestProbe>> {
  const p = schema.instanceProbes;
  // A probe older than a day is stale whatever it says, and the bound keeps
  // the read off the whole 90-day table.
  const rows = await db
    .selectDistinctOn([p.probe], { probe: p.probe, value: p.value, ok: p.ok, takenAt: p.takenAt })
    .from(p)
    .where(gte(p.takenAt, new Date(now.getTime() - DAY_MS)))
    .orderBy(p.probe, desc(p.takenAt));
  const out = new Map<ProbeKey, LatestProbe>();
  for (const row of rows) {
    if (isProbeKey(row.probe)) out.set(row.probe, { ...row, probe: row.probe });
  }
  return out;
}

export interface ProbePoint {
  t: Date;
  value: number | null;
  ok: boolean;
  /** How many readings the bucket folded into the point. */
  readings: number;
}

/**
 * One probe's history between `from` and `to`, one point per bucket of
 * `bucketSeconds` folded by the probe's aggregate; a bucket with any failing
 * sample reads as not ok.
 */
export async function probeHistory(
  db: Db,
  opts: { probe: ProbeKey; from: Date; to: Date; bucketSeconds: number },
): Promise<ProbePoint[]> {
  const p = schema.instanceProbes;
  const bucket = sql`to_timestamp(floor(extract(epoch from ${p.takenAt}) / ${opts.bucketSeconds}) * ${opts.bucketSeconds})`;
  const value =
    PROBES[opts.probe].aggregate === "max" ? sql`max(${p.value})` : sql`avg(${p.value})`;
  const rows = resultRows<{ t: string; value: number | null; ok: boolean; readings: number }>(
    await db.execute(sql`
      select ${bucket} as t, ${value}::float8 as value, bool_and(${p.ok}) as ok, count(*)::int as readings
      from ${p}
      where ${and(sql`${p.probe} = ${opts.probe}`, gte(p.takenAt, opts.from), lte(p.takenAt, opts.to))}
      group by 1
      order by 1
    `),
  );
  return rows.map((r) => ({
    t: new Date(r.t),
    value: r.value === null ? null : Number(r.value),
    ok: r.ok,
    readings: Number(r.readings),
  }));
}
