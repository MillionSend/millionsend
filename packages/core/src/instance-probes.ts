import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, desc, gte, lt, lte, sql } from "drizzle-orm";
import { resultRows } from "./driver-result.js";
import { DAY_MS } from "./utc-day.js";

/**
 * The instance health probes the worker samples every minute. `bad` probes
 * mean the instance is not doing its job when they fail (the database, the
 * worker, KMS, SES events); `warn` ones are worth a look.
 */
export const PROBES = {
  pg_latency_ms: "bad",
  pg_size_bytes: "warn",
  worker_heartbeat: "bad",
  boss_waiting: "warn",
  boss_failed: "warn",
  ses_events_lag_s: "bad",
  webhook_success_rate: "warn",
  webhook_tripped: "warn",
  kms_wrap_ms: "bad",
  stripe_last_event_s: "warn",
  retention_purged: "warn",
  teams_total: "warn",
  contacts_total: "warn",
  contacts_unsubscribed: "warn",
  domains_verified: "warn",
  queue_waiting: "warn",
  queue_quota_held: "warn",
  queue_oldest_s: "warn",
} as const;

export type ProbeKey = keyof typeof PROBES;
export type ProbeSeverity = (typeof PROBES)[ProbeKey];
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
export async function latestProbes(db: Db): Promise<Map<ProbeKey, LatestProbe>> {
  const p = schema.instanceProbes;
  // A probe older than a day is stale whatever it says, and the bound keeps
  // the read off the whole 90-day table.
  const rows = await db
    .selectDistinctOn([p.probe], { probe: p.probe, value: p.value, ok: p.ok, takenAt: p.takenAt })
    .from(p)
    .where(gte(p.takenAt, new Date(Date.now() - DAY_MS)))
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
}

/**
 * One probe's history between `from` and `to`, averaged per bucket of
 * `bucketSeconds`; a bucket with any failing sample reads as not ok.
 */
export async function probeHistory(
  db: Db,
  opts: { probe: ProbeKey; from: Date; to: Date; bucketSeconds: number },
): Promise<ProbePoint[]> {
  const p = schema.instanceProbes;
  const bucket = sql`to_timestamp(floor(extract(epoch from ${p.takenAt}) / ${opts.bucketSeconds}) * ${opts.bucketSeconds})`;
  const rows = resultRows<{ t: string; value: number | null; ok: boolean }>(
    await db.execute(sql`
      select ${bucket} as t, avg(${p.value})::float8 as value, bool_and(${p.ok}) as ok
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
  }));
}
