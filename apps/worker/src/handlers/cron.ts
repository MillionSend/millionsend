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
import {
  computeDomainVerification,
  type DnsResolver,
  type SesIdentityClient,
} from "@millionsend/ses";
import { and, asc, eq, isNull, lt, lte, ne, or, sql } from "drizzle-orm";

/**
 * Safety net for webhook.deliver jobs lost between the delivery-row insert
 * and the enqueue (or a dropped retry). Only rows well past due are touched;
 * queue dedupe per deliveryId collapses any overlap with a live job, and the
 * delivery handler skips terminal rows, so a stray extra job is harmless.
 */
export async function reconcileWebhookDeliveries(
  db: Db,
  deps: { enqueue: (deliveryId: string) => Promise<void>; now?: Date },
): Promise<number> {
  const now = deps.now ?? new Date();
  const staleBefore = new Date(now.getTime() - 15 * 60 * 1000);
  const stalled = await db
    .select({ id: schema.webhookDeliveries.id })
    .from(schema.webhookDeliveries)
    .where(
      or(
        and(
          eq(schema.webhookDeliveries.status, "pending"),
          lt(schema.webhookDeliveries.createdAt, staleBefore),
        ),
        and(
          eq(schema.webhookDeliveries.status, "failed"),
          lt(schema.webhookDeliveries.nextAttemptAt, staleBefore),
        ),
      ),
    )
    .orderBy(asc(schema.webhookDeliveries.createdAt));
  for (const delivery of stalled) {
    await deps.enqueue(delivery.id);
  }
  return stalled.length;
}

/**
 * Safety net for broadcast.send jobs lost between the schedule commit and the
 * enqueue (or a worker crash mid-fan-out). Scheduled broadcasts past due and
 * sending broadcasts whose fan-out went quiet are re-enqueued; the handler's
 * status re-check plus the (broadcastId, contactId) unique index make a stray
 * extra job harmless.
 */
export async function reconcileStalledBroadcasts(
  db: Db,
  deps: { enqueue: (broadcastId: string) => Promise<void>; now?: Date },
): Promise<number> {
  const now = deps.now ?? new Date();
  const staleBefore = new Date(now.getTime() - 15 * 60 * 1000);
  const stalled = await db
    .select({ id: schema.broadcasts.id })
    .from(schema.broadcasts)
    .where(
      or(
        and(
          eq(schema.broadcasts.status, "scheduled"),
          lt(schema.broadcasts.scheduledAt, staleBefore),
        ),
        and(eq(schema.broadcasts.status, "sending"), lt(schema.broadcasts.updatedAt, staleBefore)),
      ),
    )
    .orderBy(asc(schema.broadcasts.createdAt));
  for (const broadcast of stalled) {
    await deps.enqueue(broadcast.id);
  }
  return stalled.length;
}

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

/**
 * Deletes api_requests rows past the SAME effective retention window as
 * email bodies (instance setting > env default): request logs carry
 * request/response payload fragments, so they age out with content.
 */
export async function purgeExpiredApiRequests(
  db: Db,
  params: { defaultRetentionDays: number; now?: Date },
): Promise<number> {
  const { emailRetentionDays } = await getInstanceSettings(db);
  const retentionDays = emailRetentionDays ?? params.defaultRetentionDays;
  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const purged = await db
    .delete(schema.apiRequests)
    .where(lt(schema.apiRequests.createdAt, cutoff))
    .returning({ id: schema.apiRequests.id });
  return purged.length;
}

/** Domains whose live DNS is re-checked at most this often (bounds SES/DNS load). */
const REVERIFY_STALE_MS = 10 * 60 * 1000;
/** Upper bound on domains reverified per run; oldest lastCheckedAt first. */
const REVERIFY_BATCH = 100;

export interface ReverifyDomainsDeps {
  clientForRegion: (region: string) => SesIdentityClient;
  resolver: DnsResolver;
  now?: Date;
  batchSize?: number;
}

export interface ReverifyResult {
  checked: number;
  failed: number;
  capped: boolean;
}

/**
 * Background re-verification of sender domains. The send gate keys off the
 * stored domains.status (verifySenderDomain), so a required DNS record removed
 * AFTER a domain verified would keep passing the gate until someone reopened
 * the domain page. Running computeDomainVerification on a schedule closes that
 * window: a verified domain that lost a required record now computes `pending`
 * and is demoted, blocking further sends; a pending domain gone fully live is
 * promoted. Terminally-failed domains are skipped (SES DKIM hard-failed —
 * re-adding is the only path forward); temporary_failure and pending are not.
 *
 * verifiedAt is stamped on first promotion only; a demotion keeps the historical
 * value. One domain's DNS/SES error is caught and logged so it can't abort the
 * batch. The batch is capped and ordered oldest-first, so a cap just defers the
 * freshest-checked domains to the next run rather than dropping any.
 */
export async function reverifyDomains(db: Db, deps: ReverifyDomainsDeps): Promise<ReverifyResult> {
  const now = deps.now ?? new Date();
  const batchSize = deps.batchSize ?? REVERIFY_BATCH;
  const staleBefore = new Date(now.getTime() - REVERIFY_STALE_MS);
  const due = await db
    .select({
      id: schema.domains.id,
      name: schema.domains.name,
      region: schema.domains.region,
      mailFromSubdomain: schema.domains.mailFromSubdomain,
      dkimSelector: schema.domains.dkimSelector,
      dkimPublicKey: schema.domains.dkimPublicKey,
      trackingSubdomain: schema.domains.trackingSubdomain,
      verifiedAt: schema.domains.verifiedAt,
    })
    .from(schema.domains)
    .where(
      and(
        ne(schema.domains.status, "failed"),
        or(isNull(schema.domains.lastCheckedAt), lt(schema.domains.lastCheckedAt, staleBefore)),
      ),
    )
    // Never-checked domains (NULL) are the most stale, so they sort first.
    .orderBy(sql`${schema.domains.lastCheckedAt} asc nulls first`)
    .limit(batchSize + 1);

  const capped = due.length > batchSize;
  const batch = capped ? due.slice(0, batchSize) : due;
  if (capped) {
    console.warn(`domains.reverify: batch capped at ${batchSize}; remainder deferred to next run`);
  }

  let failed = 0;
  for (const domain of batch) {
    try {
      const { status } = await computeDomainVerification(
        deps.clientForRegion(domain.region),
        deps.resolver,
        domain,
      );
      await db
        .update(schema.domains)
        .set({
          status,
          lastCheckedAt: now,
          ...(status === "verified" && !domain.verifiedAt ? { verifiedAt: now } : {}),
        })
        .where(eq(schema.domains.id, domain.id));
    } catch (err) {
      failed += 1;
      console.warn(`domains.reverify: ${domain.name} failed`, err);
    }
  }
  return { checked: batch.length, failed, capped };
}
