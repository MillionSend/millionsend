import {
  PLAN_DAILY_LIMIT,
  releaseDailyQuota,
  reserveDailyQuota,
  transitionQueueState,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, eq, isNull, lt } from "drizzle-orm";

export interface DrainDeps {
  isCloud: boolean;
  enqueueSend: (emailId: string) => Promise<void>;
}

export interface DrainResult {
  drained: number;
  stillParked: number;
}

/**
 * Midnight drain of quota-parked emails. Parked emails hold NO reservation
 * (accept-time reservation failed — that is why they parked), so each one
 * must win a reservation against the new day's cap before it may move to
 * "queued": without this, parking would be a quota bypass. Oldest first;
 * once a team's cap fills, its remaining emails stay parked for tomorrow.
 */
export async function drainQuotaParked(db: Db, deps: DrainDeps): Promise<DrainResult> {
  const parked = await db
    .select({
      id: schema.emails.id,
      teamId: schema.emails.teamId,
      plan: schema.teams.plan,
    })
    .from(schema.emails)
    .innerJoin(schema.teams, eq(schema.emails.teamId, schema.teams.id))
    .where(eq(schema.emails.latestStatus, "queued_quota"))
    .orderBy(asc(schema.emails.createdAt));

  const exhausted = new Set<string>();
  let drained = 0;
  for (const email of parked) {
    if (exhausted.has(email.teamId)) continue;
    const limit = deps.isCloud ? PLAN_DAILY_LIMIT[email.plan] : null;
    const quota = await reserveDailyQuota(db, { teamId: email.teamId, count: 1, limit });
    if (!quota.reserved) {
      exhausted.add(email.teamId);
      continue;
    }
    const moved = await transitionQueueState(db, email.id, {
      from: "queued_quota",
      to: "queued",
    });
    if (!moved) {
      // Raced away from queued_quota (e.g. a concurrent drain): give the
      // reservation back rather than burning a send the team never got.
      await releaseDailyQuota(db, { teamId: email.teamId, count: 1 });
      continue;
    }
    try {
      await deps.enqueueSend(email.id);
    } catch (err) {
      // A "queued" email with no job would never send; re-park and let the
      // cron retry pick it up.
      await transitionQueueState(db, email.id, { from: "queued", to: "queued_quota" });
      await releaseDailyQuota(db, { teamId: email.teamId, count: 1 });
      throw err;
    }
    drained += 1;
  }
  return { drained, stillParked: parked.length - drained };
}

/**
 * Nulls body columns past the retention window and stamps bodyPurgedAt;
 * metadata, events, and aggregates keep their own lifecycles. Deliberately
 * unconditional on status: retention is a compliance promise, so even a
 * zombie still-queued email loses its body (the send handler then marks it
 * failed on the missing body).
 */
export async function purgeExpiredEmailBodies(
  db: Db,
  params: { retentionDays: number; now?: Date },
): Promise<number> {
  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - params.retentionDays * 24 * 60 * 60 * 1000);
  const purged = await db
    .update(schema.emails)
    .set({
      bodyCiphertext: null,
      bodyIv: null,
      bodyWrappedDek: null,
      bodyKeyVersion: null,
      bodyPurgedAt: now,
    })
    .where(and(lt(schema.emails.createdAt, cutoff), isNull(schema.emails.bodyPurgedAt)))
    .returning({ id: schema.emails.id });
  return purged.length;
}
