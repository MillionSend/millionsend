import {
  DAY_MS,
  getInstanceSettings,
  PLAN_DAILY_LIMIT,
  releaseDailyQuota,
  reserveDailyQuota,
  transitionQueueState,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm";

export interface DrainDeps {
  isCloud: boolean;
  /** startAfter defers the job for emails scheduled beyond the drain time. */
  enqueueSend: (emailId: string, startAfter?: Date) => Promise<void>;
}

export interface DrainResult {
  drained: number;
  stillParked: number;
}

/** Sentinel: the row left queued_quota concurrently; roll the reservation back. */
class DrainRaced extends Error {}

/**
 * Midnight drain of quota-parked emails. Parked emails hold NO reservation
 * (accept-time reservation failed — that is why they parked), so each one
 * must win a reservation against the new day's cap before it may move to
 * "queued": without this, parking would be a quota bypass. Oldest first;
 * once a team's cap fills, its remaining emails stay parked for tomorrow.
 *
 * Reserve + transition commit atomically per email (no crash window that
 * burns quota or half-moves a row). One email's failure never blocks the
 * rest — errors are collected and rethrown at the end so the cron retries.
 */
export async function drainQuotaParked(db: Db, deps: DrainDeps): Promise<DrainResult> {
  const parked = await db
    .select({
      id: schema.emails.id,
      teamId: schema.emails.teamId,
      plan: schema.teams.plan,
      scheduledAt: schema.emails.scheduledAt,
    })
    .from(schema.emails)
    .innerJoin(schema.teams, eq(schema.emails.teamId, schema.teams.id))
    .where(eq(schema.emails.latestStatus, "queued_quota"))
    .orderBy(asc(schema.emails.createdAt));

  const exhausted = new Set<string>();
  const failures: unknown[] = [];
  let drained = 0;
  for (const email of parked) {
    if (exhausted.has(email.teamId)) continue;
    const limit = deps.isCloud ? PLAN_DAILY_LIMIT[email.plan] : null;
    try {
      const outcome = await db
        .transaction(async (tx) => {
          const txDb = tx as unknown as Db;
          const quota = await reserveDailyQuota(txDb, { teamId: email.teamId, count: 1, limit });
          if (!quota.reserved) return "exhausted" as const;
          const moved = await transitionQueueState(txDb, email.id, {
            from: "queued_quota",
            to: "queued",
          });
          if (!moved) throw new DrainRaced();
          return "moved" as const;
        })
        .catch((err) => {
          if (err instanceof DrainRaced) return "raced" as const;
          throw err;
        });
      if (outcome === "exhausted") {
        exhausted.add(email.teamId);
        continue;
      }
      if (outcome === "raced") continue;
      try {
        await deps.enqueueSend(email.id, email.scheduledAt ?? undefined);
      } catch (err) {
        // A "queued" email with no job would only be picked up by the
        // reconcile sweep; re-park it so the drain retry handles it sooner.
        await transitionQueueState(db, email.id, { from: "queued", to: "queued_quota" });
        await releaseDailyQuota(db, { teamId: email.teamId, count: 1 });
        throw err;
      }
      drained += 1;
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) {
    throw new Error(`quota drain: ${failures.length} email(s) failed`, { cause: failures[0] });
  }
  return { drained, stillParked: parked.length - drained };
}

/**
 * Safety net for the enqueue-after-commit gap: an accepted email whose
 * email.send job was lost (API crashed before enqueueing, drain crashed
 * between commit and enqueue) is re-enqueued. Idempotent by construction —
 * the queue collapses duplicates per emailId while a job is queued, and the
 * send handler's claim makes a stray extra job harmless. Claimed rows
 * (sentAt set) are deliberately excluded: those may already be at SES.
 */
export async function reconcileStalledSends(
  db: Db,
  deps: { enqueueSend: (emailId: string, startAfter?: Date) => Promise<void>; now?: Date },
): Promise<number> {
  const now = deps.now ?? new Date();
  const staleBefore = new Date(now.getTime() - 15 * 60 * 1000);
  const stalled = await db
    .select({ id: schema.emails.id, scheduledAt: schema.emails.scheduledAt })
    .from(schema.emails)
    .where(
      and(
        eq(schema.emails.latestStatus, "queued"),
        isNull(schema.emails.sentAt),
        lt(schema.emails.createdAt, staleBefore),
      ),
    )
    .orderBy(asc(schema.emails.createdAt));
  for (const email of stalled) {
    await deps.enqueueSend(email.id, email.scheduledAt ?? undefined);
  }
  return stalled.length;
}

/**
 * Nulls body columns past the retention window and stamps bodyPurgedAt;
 * metadata, events, and aggregates keep their own lifecycles. Emails whose
 * scheduled send is still in the future keep their body (the send needs it);
 * everything else past the cutoff is purged unconditionally — retention is
 * a compliance promise, so even a zombie still-queued email loses its body
 * (the send handler then marks it failed on the missing body).
 */
export async function purgeExpiredEmailBodies(
  db: Db,
  params: { defaultRetentionDays: number; now?: Date },
): Promise<number> {
  // Read the instance setting fresh each run so a Settings → Instance change
  // applies to the next purge without a worker restart; NULL falls back to
  // the env-derived default.
  const { emailRetentionDays } = await getInstanceSettings(db);
  const retentionDays = emailRetentionDays ?? params.defaultRetentionDays;
  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const purged = await db
    .update(schema.emails)
    .set({
      bodyCiphertext: null,
      bodyIv: null,
      bodyWrappedDek: null,
      bodyKeyVersion: null,
      bodyPurgedAt: now,
    })
    .where(
      and(
        lt(schema.emails.createdAt, cutoff),
        isNull(schema.emails.bodyPurgedAt),
        or(isNull(schema.emails.scheduledAt), lte(schema.emails.scheduledAt, now)),
      ),
    )
    .returning({ id: schema.emails.id });
  return purged.length;
}
