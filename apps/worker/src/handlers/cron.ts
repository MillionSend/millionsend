import {
  DAY_MS,
  effectivePlan,
  failQueuedEmailsForDomain,
  getInstanceSettings,
  isIdentitySharedByOtherDomains,
  PLAN_DAILY_LIMIT,
  recordAudit,
  releaseDailyQuota,
  reserveDailyQuota,
  transitionQueueState,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import {
  computeDomainVerification,
  type DnsResolver,
  deleteDomainIdentity,
  getDomainVerification,
  type SesIdentityClient,
} from "@millionsend/ses";
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";

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

/** Parked rows loaded per page; the backlog is unbounded (see acceptEmail). */
const DRAIN_PAGE = 500;

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
  const exhausted = new Set<string>();
  const failures: unknown[] = [];
  let drained = 0;
  // Keyset pages over (createdAt, id): global oldest-first order keeps the
  // per-team fairness, and a row that stays parked (exhausted team, failed
  // enqueue) can never be re-read into an infinite loop.
  let cursor: { createdAt: Date; id: string } | undefined;
  for (;;) {
    const page = await db
      .select({
        id: schema.emails.id,
        teamId: schema.emails.teamId,
        plan: schema.teams.plan,
        currentPeriodEnd: schema.teams.currentPeriodEnd,
        scheduledAt: schema.emails.scheduledAt,
        createdAt: schema.emails.createdAt,
      })
      .from(schema.emails)
      .innerJoin(schema.teams, eq(schema.emails.teamId, schema.teams.id))
      .where(
        and(
          eq(schema.emails.latestStatus, "queued_quota"),
          cursor
            ? sql`(${schema.emails.createdAt}, ${schema.emails.id}) > (${cursor.createdAt}, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(schema.emails.createdAt), asc(schema.emails.id))
      .limit(DRAIN_PAGE);
    const last = page.at(-1);
    if (!last) break;
    cursor = { createdAt: last.createdAt, id: last.id };
    for (const email of page) {
      drained += await drainOne(db, deps, email, exhausted, failures);
    }
  }
  if (failures.length > 0) {
    throw new Error(`quota drain: ${failures.length} email(s) failed`, { cause: failures[0] });
  }
  const [rest] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.emails)
    .where(eq(schema.emails.latestStatus, "queued_quota"));
  return { drained, stillParked: rest?.n ?? 0 };
}

/** Returns 1 when the email moved to queued and its job was enqueued, else 0. */
async function drainOne(
  db: Db,
  deps: DrainDeps,
  email: {
    id: string;
    teamId: string;
    plan: keyof typeof PLAN_DAILY_LIMIT;
    currentPeriodEnd: Date | null;
    scheduledAt: Date | null;
  },
  exhausted: Set<string>,
  failures: unknown[],
): Promise<number> {
  if (exhausted.has(email.teamId)) return 0;
  const limit = deps.isCloud
    ? PLAN_DAILY_LIMIT[effectivePlan(email.plan, email.currentPeriodEnd)]
    : null;
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
      return 0;
    }
    if (outcome === "raced") return 0;
    try {
      await deps.enqueueSend(email.id, email.scheduledAt ?? undefined);
    } catch (err) {
      // A "queued" email with no job would only be picked up by the
      // reconcile sweep; re-park it so the drain retry handles it sooner.
      await transitionQueueState(db, email.id, { from: "queued", to: "queued_quota" });
      await releaseDailyQuota(db, { teamId: email.teamId, count: 1 });
      throw err;
    }
    return 1;
  } catch (err) {
    failures.push(err);
    return 0;
  }
}

/** Re-enqueues per sweep; a larger backlog waits for the next run. */
const RECONCILE_BATCH = 1000;

/**
 * Safety net for the enqueue-after-commit gap: an accepted email whose
 * email.send job was lost (API crashed before enqueueing, drain crashed
 * between commit and enqueue) is re-enqueued. Idempotent by construction —
 * the queue collapses duplicates per emailId while a job is queued, and the
 * send handler's claim makes a stray extra job harmless. Attempts are capped
 * by the queue's dead-letter path, which fails the row after its retries.
 *
 * A claim (sentAt set) that never recorded an SES MessageId is a send
 * interrupted between claim and accept (worker killed mid-flight). Nothing
 * else ever picks such a row up, so after a generous window it is failed
 * with an event rather than left queued forever.
 */
export async function reconcileStalledSends(
  db: Db,
  deps: { enqueueSend: (emailId: string, startAfter?: Date) => Promise<void>; now?: Date },
): Promise<number> {
  const now = deps.now ?? new Date();
  const staleBefore = new Date(now.getTime() - 15 * 60 * 1000);
  const interrupted = await db
    .update(schema.emails)
    .set({ latestStatus: "failed", sentAt: null })
    .where(
      and(
        eq(schema.emails.latestStatus, "queued"),
        isNotNull(schema.emails.sentAt),
        isNull(schema.emails.sesMessageId),
        lt(schema.emails.sentAt, staleBefore),
      ),
    )
    .returning({ id: schema.emails.id });
  if (interrupted.length > 0) {
    await db.insert(schema.emailEvents).values(
      interrupted.map((email) => ({
        emailId: email.id,
        type: "failed" as const,
        occurredAt: now,
        data: { source: "worker", reason: "send_interrupted" },
      })),
    );
  }
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
    .orderBy(asc(schema.emails.createdAt))
    .limit(RECONCILE_BATCH);
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
      // Attachments are content on the same retention clock as the body.
      attachments: null,
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
      if ((err as { name?: string }).name === "NotFoundException") {
        // The SES identity is gone (deleted outside the app): the stored
        // status is a lie the send gate would keep trusting. Terminal —
        // re-adding the domain is the only way back.
        await db
          .update(schema.domains)
          .set({ status: "failed", lastCheckedAt: now })
          .where(eq(schema.domains.id, domain.id));
        console.warn(`domains.reverify: ${domain.name} has no SES identity; marked failed`);
        continue;
      }
      failed += 1;
      console.warn(`domains.reverify: ${domain.name} failed`, err);
    }
  }
  return { checked: batch.length, failed, capped };
}

/**
 * Never-verified domains older than this are reaped. SES stops searching DNS
 * for the DKIM records 72 hours after identity creation and hard-fails the
 * identity, so past this window the row can never verify again — deleting it
 * costs its team nothing and frees the (name, region) slot.
 */
const REAP_UNVERIFIED_AFTER_MS = 72 * 60 * 60 * 1000;

/** Sentinel: the domain verified between the sweep select and the delete. */
class ReapRaced extends Error {}

export interface ReapUnverifiedDomainsDeps {
  clientForRegion: (region: string) => SesIdentityClient;
  now?: Date;
}

/**
 * Cloud-only sweep completing the exclusive domain claim: the create path
 * 409s while any team holds (name, region), so an added-but-never-verified
 * domain would squat the slot forever against the real DNS owner. Only rows
 * that never verified are touched — verifiedAt survives demotion, so a domain
 * that verified even once belongs to a team that proved DNS control and is
 * never auto-deleted (its sends are already gated by status).
 *
 * Same guards as a user-initiated delete: the shared SES identity goes only
 * with the last row referencing it, queued emails fail terminally, and
 * domain-scoped api keys are revoked. Before the irreversible identity delete
 * SES itself is asked — DKIM SUCCESS skips the reap — and the row delete is
 * conditioned on verifiedAt still being null, so a promotion racing the sweep
 * keeps both its identity and its row. One domain's failure never blocks the
 * rest; an SES error leaves the row for the next run to retry.
 */
export async function reapUnverifiedDomains(
  db: Db,
  deps: ReapUnverifiedDomainsDeps,
): Promise<number> {
  const now = deps.now ?? new Date();
  const cutoff = new Date(now.getTime() - REAP_UNVERIFIED_AFTER_MS);
  const d = schema.domains;
  const stale = await db
    .select({ id: d.id })
    .from(d)
    .where(and(isNull(d.verifiedAt), lt(d.createdAt, cutoff)))
    .orderBy(asc(d.createdAt));
  let reaped = 0;
  for (const { id } of stale) {
    try {
      const [domain] = await db
        .select({ id: d.id, teamId: d.teamId, name: d.name, region: d.region })
        .from(d)
        .where(and(eq(d.id, id), isNull(d.verifiedAt)));
      if (!domain) continue;
      if (!(await isIdentitySharedByOtherDomains(db, domain))) {
        try {
          // The stored verifiedAt lags SES by up to a reverify cycle: a DKIM
          // check that succeeded right at SES's 72h deadline may not be
          // stamped yet. SUCCESS is proof the DNS owner published this row's
          // token — never a squatter — so leave it for reverify to promote.
          const live = await getDomainVerification(deps.clientForRegion(domain.region), {
            domain: domain.name,
          });
          if (live.dkimStatus === "SUCCESS") continue;
          await deleteDomainIdentity(deps.clientForRegion(domain.region), {
            domain: domain.name,
          });
        } catch (err) {
          // An identity already gone from SES must not block removing the row.
          if ((err as { name?: string }).name !== "NotFoundException") throw err;
        }
      }
      const deleted = await db
        .transaction(async (tx) => {
          const txDb = tx as unknown as Db;
          await failQueuedEmailsForDomain(txDb, { teamId: domain.teamId, domainId: domain.id });
          await txDb
            .update(schema.apiKeys)
            .set({ revokedAt: now, domainId: null })
            .where(
              and(eq(schema.apiKeys.teamId, domain.teamId), eq(schema.apiKeys.domainId, domain.id)),
            );
          const rows = await txDb
            .delete(d)
            .where(and(eq(d.id, domain.id), isNull(d.verifiedAt)))
            .returning({ id: d.id });
          if (rows.length === 0) throw new ReapRaced();
          return true;
        })
        .catch((err) => {
          if (err instanceof ReapRaced) return false;
          throw err;
        });
      if (!deleted) continue;
      await recordAudit(db, {
        teamId: domain.teamId,
        actor: "system",
        action: "domain.deleted",
        target: { type: "domain", id: domain.id },
        metadata: { name: domain.name, region: domain.region, reason: "unverified_expired" },
      });
      reaped += 1;
      console.log(`domains.reap: removed never-verified ${domain.name} (${domain.region})`);
    } catch (err) {
      console.warn(`domains.reap: domain ${id} failed`, err);
    }
  }
  return reaped;
}

/** Rows per statement in the retention loops; keeps each lock window short on a backlog. */
const PURGE_BATCH = 1000;

/**
 * Metadata retention: whole email rows (recipients, subject, headers, tags —
 * events cascade with them) past the metadata window are deleted in batches.
 * Webhook deliveries only lose their email_id on that cascade, so they age
 * out here on the same clock. Future-scheduled rows are kept like the body
 * purge does. Env-only window; no instance setting overrides it.
 */
export async function purgeExpiredEmailMetadata(
  db: Db,
  params: { retentionDays: number; now?: Date },
): Promise<{ emails: number; deliveries: number }> {
  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - params.retentionDays * DAY_MS);
  const e = schema.emails;
  let emails = 0;
  for (;;) {
    const batch = await db
      .delete(e)
      .where(
        inArray(
          e.id,
          db
            .select({ id: e.id })
            .from(e)
            .where(and(lt(e.createdAt, cutoff), or(isNull(e.scheduledAt), lte(e.scheduledAt, now))))
            .limit(PURGE_BATCH),
        ),
      )
      .returning({ id: e.id });
    emails += batch.length;
    if (batch.length < PURGE_BATCH) break;
  }
  const d = schema.webhookDeliveries;
  let deliveries = 0;
  for (;;) {
    const batch = await db
      .delete(d)
      .where(
        inArray(
          d.id,
          db.select({ id: d.id }).from(d).where(lt(d.createdAt, cutoff)).limit(PURGE_BATCH),
        ),
      )
      .returning({ id: d.id });
    deliveries += batch.length;
    if (batch.length < PURGE_BATCH) break;
  }
  return { emails, deliveries };
}

/**
 * Content-window strip for provider and webhook payloads, on the SAME
 * effective window as email bodies. email_events.data is the raw SES subset
 * (recipient addresses, diagnostics, remote MTAs) and is dropped whole — the
 * typed `type` column keeps the timeline readable. Webhook deliveries keep
 * their envelope (type, created_at, test marker) and lose `data` and the
 * captured response body.
 */
export async function stripExpiredEventPayloads(
  db: Db,
  params: { defaultRetentionDays: number; now?: Date },
): Promise<{ events: number; deliveries: number }> {
  const { emailRetentionDays } = await getInstanceSettings(db);
  const retentionDays = emailRetentionDays ?? params.defaultRetentionDays;
  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const ev = schema.emailEvents;
  let events = 0;
  for (;;) {
    const batch = await db
      .update(ev)
      .set({ data: null })
      .where(
        inArray(
          ev.id,
          db
            .select({ id: ev.id })
            .from(ev)
            .where(and(lt(ev.occurredAt, cutoff), isNotNull(ev.data)))
            .limit(PURGE_BATCH),
        ),
      )
      .returning({ id: ev.id });
    events += batch.length;
    if (batch.length < PURGE_BATCH) break;
  }
  const d = schema.webhookDeliveries;
  let deliveries = 0;
  for (;;) {
    const batch = await db
      .update(d)
      .set({ payload: sql`${d.payload} - 'data'`, lastResponseBody: null })
      .where(
        inArray(
          d.id,
          db
            .select({ id: d.id })
            .from(d)
            .where(
              and(
                lt(d.createdAt, cutoff),
                or(sql`${d.payload} ? 'data'`, isNotNull(d.lastResponseBody)),
              ),
            )
            .limit(PURGE_BATCH),
        ),
      )
      .returning({ id: d.id });
    deliveries += batch.length;
    if (batch.length < PURGE_BATCH) break;
  }
  return { events, deliveries };
}

/** Better Auth never deletes expired sessions; their IP/user-agent would otherwise sit forever. */
export async function purgeExpiredSessions(db: Db, now = new Date()): Promise<number> {
  const rows = await db
    .delete(schema.session)
    .where(lt(schema.session.expiresAt, now))
    .returning({ id: schema.session.id });
  return rows.length;
}

/**
 * Daily plan reconcile against Stripe for every team with a customer: covers
 * webhooks that were dropped or arrived out of order. One team's failure is
 * logged and never blocks the rest.
 */
export async function reconcileBillingPlans(
  db: Db,
  deps: { reconcileTeam: (teamId: string) => Promise<void> },
): Promise<{ reconciled: number; failed: number }> {
  const teams = await db
    .select({ id: schema.teams.id })
    .from(schema.teams)
    .where(isNotNull(schema.teams.stripeCustomerId))
    .orderBy(asc(schema.teams.id));
  let failed = 0;
  for (const team of teams) {
    try {
      await deps.reconcileTeam(team.id);
    } catch (err) {
      failed += 1;
      console.warn(`billing.reconcile: team ${team.id} failed`, err);
    }
  }
  return { reconciled: teams.length - failed, failed };
}
