import {
  type MonitorDeps,
  markLostSamples,
  monitorHealth,
  recordProbes,
  SCREEN_RETRIES,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, gte, or, sql } from "drizzle-orm";
import { mailOperator, type SystemMailer } from "../system-mail.js";

export interface MonitorHealthDeps {
  /** What the env named; null when the monitor is off, and then nothing is sampled or written. */
  judge: { provider: string; model: string } | null;
  mailer?: SystemMailer | undefined;
  appBaseUrl?: string | undefined;
  /** Kept by the caller across runs: when the degraded notice last went out. */
  state: { degradedMailedAt: Date | null };
  /** Queues a lost screening sample again: mail waits on it. */
  enqueueJudge?: MonitorDeps["enqueueJudge"] | undefined;
  now?: Date | undefined;
}

/**
 * Past this unjudged share, on at least this many samples, the operator hears
 * about it; a rejected API key is heard about at any volume.
 */
export const MONITOR_DEGRADED_RATE = 0.2;
export const MONITOR_DEGRADED_MIN_SAMPLES = 20;
export const MONITOR_DEGRADED_MAIL_INTERVAL_MS = 6 * 3600_000;

/**
 * The last hour's sample count and unjudged share as probes for the console,
 * pending samples whose job never came back marked, and one notice to the
 * operator when the judge keeps failing, or gave up on mail screening held
 * before SES, which then waits for the operator. ponytail: the notice's
 * clock lives in the worker's memory, so a restart may repeat it once early.
 */
export async function runMonitorHealth(
  db: Db,
  deps: MonitorHealthDeps,
): Promise<{ samples: number; unjudged: number; lost: number; degraded: boolean }> {
  const now = deps.now ?? new Date();
  if (!deps.judge) return { samples: 0, unjudged: 0, lost: 0, degraded: false };
  const lost = await markLostSamples(db, now, deps.enqueueJudge);
  const health = await monitorHealth(db, now);
  const ms = schema.monitorSamples;
  // A revoked key fails every call until someone replaces it, so one is enough
  // while nothing has been answered since; an answer after it means the key works.
  const [latest] = await db
    .select({ errorClass: ms.errorClass })
    .from(ms)
    .where(
      and(
        gte(ms.createdAt, new Date(now.getTime() - 3600_000)),
        or(eq(ms.status, "judged"), eq(ms.errorClass, "no_credentials")),
      ),
    )
    .orderBy(sql`${ms.judgedAt} desc nulls last`)
    .limit(1);
  // A screening sample the judge failed on, re-runs and all: what waited on
  // it is parked for the review list, so one is enough to tell.
  const [gaveUp] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ms)
    .where(
      and(
        eq(ms.screening, true),
        eq(ms.status, "unjudged"),
        gte(ms.screenRetries, SCREEN_RETRIES),
        gte(ms.judgedAt, new Date(now.getTime() - 3600_000)),
      ),
    );
  const degraded =
    (gaveUp?.n ?? 0) > 0 ||
    latest?.errorClass === "no_credentials" ||
    (health.samples >= MONITOR_DEGRADED_MIN_SAMPLES &&
      (health.unjudgedRate ?? 0) > MONITOR_DEGRADED_RATE);
  await recordProbes(
    db,
    [
      { probe: "monitor_samples_1h", value: health.samples, ok: true },
      { probe: "monitor_unjudged_rate", value: health.unjudgedRate, ok: !degraded },
    ],
    now,
  );
  const last = deps.state.degradedMailedAt;
  if (
    degraded &&
    deps.mailer &&
    (last === null || now.getTime() - last.getTime() >= MONITOR_DEGRADED_MAIL_INTERVAL_MS)
  ) {
    deps.state.degradedMailedAt = now;
    try {
      const [waiting] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.emails)
        .where(
          and(
            eq(schema.emails.latestStatus, "queued_quota"),
            eq(schema.emails.parkReason, "screening"),
          ),
        );
      await mailOperator(
        db,
        deps.mailer,
        "monitor.degraded",
        "/console",
        {
          rate: `${Math.round((health.unjudgedRate ?? 0) * 100)}%`,
          unjudged: String(health.unjudged),
          samples: String(health.samples),
          parked: String(waiting?.n ?? 0),
          provider: deps.judge.provider,
          model: deps.judge.model,
        },
        deps.appBaseUrl,
      );
    } catch (err) {
      console.error("monitor.health: operator mail failed", err);
    }
  }
  return { samples: health.samples, unjudged: health.unjudged, lost, degraded };
}
