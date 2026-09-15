import { randomBytes } from "node:crypto";
import {
  type Keyring,
  type ProbeKey,
  type ProbeSample,
  recordProbes,
  sesEventsHealth,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";

export interface ProbeDeps {
  isCloud: boolean;
  /** The worker's keyring; on cloud a timed wrap says whether KMS answers. */
  keyring?: Keyring | undefined;
  /** Whether SES events are expected at all (SNS_TOPIC_ARNS set). */
  eventsConfigured: boolean;
  now?: Date;
}

/** Lines the health card judges against; the probe carries the measurement, not the line. */
export const PG_LATENCY_OK_MS = 250;
export const KMS_WRAP_OK_MS = 2_000;
export const WEBHOOK_SUCCESS_OK_RATE = 0.9;

const HOUR_MS = 3_600_000;

/**
 * One pass of every health probe, each measured on its own so one failure
 * never hides the others: a probe that throws is recorded as not ok with no
 * value. Counts that need a table scan (contacts) come from the planner's
 * estimate, as Chatwoot does for its dashboard.
 */
export async function runInstanceProbes(db: Db, deps: ProbeDeps): Promise<ProbeSample[]> {
  const now = deps.now ?? new Date();
  const samples: ProbeSample[] = [];
  const probe = async (
    key: ProbeKey,
    measure: () => Promise<{ value: number | null; ok: boolean } | null>,
  ) => {
    try {
      const result = await measure();
      if (result) samples.push({ probe: key, ...result });
    } catch (err) {
      console.warn(`instance.probe: ${key} failed`, err);
      samples.push({ probe: key, value: null, ok: false });
    }
  };
  const one = async <T>(query: ReturnType<typeof sql>): Promise<T | undefined> => {
    const rows = (await db.execute(query)) as unknown as { rows?: T[] } | T[];
    return Array.isArray(rows) ? rows[0] : rows.rows?.[0];
  };

  await probe("pg_latency_ms", async () => {
    const started = process.hrtime.bigint();
    await db.execute(sql`select 1`);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    return { value: ms, ok: ms <= PG_LATENCY_OK_MS };
  });
  await probe("pg_size_bytes", async () => {
    const row = await one<{ bytes: string }>(
      sql`select pg_database_size(current_database())::text as bytes`,
    );
    return { value: Number(row?.bytes ?? 0), ok: true };
  });
  await probe("worker_heartbeat", async () => ({ value: 1, ok: true }));

  // pg-boss lives in its own schema; a fresh database has none until the
  // worker starts it, so the probe answers "nothing waiting" rather than fail.
  const bossPresent =
    (await one<{ present: boolean }>(sql`select to_regclass('pgboss.job') is not null as present`))
      ?.present === true;
  await probe("boss_waiting", async () => {
    if (!bossPresent) return { value: 0, ok: true };
    const row = await one<{ n: number }>(
      sql`select count(*)::int as n from pgboss.job where state in ('created', 'retry')`,
    );
    return { value: Number(row?.n ?? 0), ok: true };
  });
  await probe("boss_failed", async () => {
    if (!bossPresent) return { value: 0, ok: true };
    const row = await one<{ n: number }>(
      sql`select count(*)::int as n from pgboss.job where state = 'failed'`,
    );
    const failed = Number(row?.n ?? 0);
    return { value: failed, ok: failed === 0 };
  });
  await probe("queue_waiting", async () => {
    if (!bossPresent) return { value: 0, ok: true };
    const row = await one<{ n: number }>(
      sql`select count(*)::int as n from pgboss.job where name = 'email.send' and state in ('created', 'retry')`,
    );
    return { value: Number(row?.n ?? 0), ok: true };
  });
  await probe("queue_oldest_s", async () => {
    if (!bossPresent) return { value: 0, ok: true };
    const row = await one<{ age: number | null }>(
      sql`select extract(epoch from (now() - min(created_on)))::float8 as age from pgboss.job where name = 'email.send' and state in ('created', 'retry') and start_after <= now()`,
    );
    return { value: row?.age === null || row?.age === undefined ? 0 : Number(row.age), ok: true };
  });
  await probe("queue_quota_held", async () => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.emails)
      .where(eq(schema.emails.latestStatus, "queued_quota"));
    return { value: row?.n ?? 0, ok: true };
  });

  await probe("ses_events_lag_s", async () => {
    if (!deps.eventsConfigured) return null;
    const health = await sesEventsHealth(db, now);
    const ev = schema.emailEvents;
    const [row] = await db
      .select({
        lag: sql<
          number | null
        >`avg(extract(epoch from (${ev.createdAt} - ${ev.occurredAt})))::float8`,
      })
      .from(ev)
      .where(
        and(isNotNull(ev.snsMessageId), gte(ev.createdAt, new Date(now.getTime() - 15 * 60_000))),
      );
    return {
      value: row?.lag === null || row?.lag === undefined ? null : Math.max(0, Number(row.lag)),
      ok: health.status !== "unhealthy",
    };
  });

  await probe("webhook_success_rate", async () => {
    const d = schema.webhookDeliveries;
    const [row] = await db
      .select({
        settled: sql<number>`count(*) filter (where ${d.status} in ('success', 'exhausted'))::int`,
        succeeded: sql<number>`count(*) filter (where ${d.status} = 'success')::int`,
      })
      .from(d)
      .where(gte(d.createdAt, new Date(now.getTime() - HOUR_MS)));
    const settled = row?.settled ?? 0;
    if (settled === 0) return { value: null, ok: true };
    const rate = (row?.succeeded ?? 0) / settled;
    return { value: rate, ok: rate >= WEBHOOK_SUCCESS_OK_RATE };
  });
  await probe("webhook_tripped", async () => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.webhookEndpoints)
      .where(eq(schema.webhookEndpoints.status, "auto_disabled"));
    return { value: row?.n ?? 0, ok: true };
  });

  await probe("kms_wrap_ms", async () => {
    if (!deps.isCloud || !deps.keyring) return null;
    const started = process.hrtime.bigint();
    await deps.keyring.wrapDek(randomBytes(32), { teamId: "instance", purpose: "probe" });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    return { value: ms, ok: ms <= KMS_WRAP_OK_MS };
  });
  await probe("stripe_last_event_s", async () => {
    if (!deps.isCloud) return null;
    const [row] = await db
      .select({ last: sql<string | null>`max(${schema.stripeEvents.receivedAt})` })
      .from(schema.stripeEvents);
    if (!row?.last) return { value: null, ok: true };
    return { value: Math.max(0, (now.getTime() - new Date(row.last).getTime()) / 1000), ok: true };
  });

  await probe("teams_total", async () => {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.teams);
    return { value: row?.n ?? 0, ok: true };
  });
  await probe("contacts_total", async () => {
    // reltuples: the planner's row estimate, refreshed by autovacuum; exact
    // enough for a headline and free, unlike a count over millions of rows.
    const row = await one<{ n: number }>(
      sql`select greatest(reltuples, 0)::float8 as n from pg_class where oid = 'public.contacts'::regclass`,
    );
    return { value: Math.round(Number(row?.n ?? 0)), ok: true };
  });
  await probe("domains_verified", async () => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.domains)
      .where(eq(schema.domains.status, "verified"));
    return { value: row?.n ?? 0, ok: true };
  });

  await recordProbes(db, samples, now);
  return samples;
}
