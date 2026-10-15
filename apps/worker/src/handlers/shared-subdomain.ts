import {
  lockUsedSharedSubdomains,
  SHARED_SUBDOMAIN_FALLBACK_MS,
  SHARED_SUBDOMAIN_RETRY_MS,
  type SharedNameReview,
  settleSharedSubdomain,
  teamsWithoutSharedSubdomain,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import type { JobPayloads } from "@millionsend/queue";

type SharedSubdomainJob = JobPayloads["shared.subdomain"];

/**
 * The shared.subdomain job: settles the team's subdomain label. While the
 * name review can't answer, the job queues its successor an hour on with the
 * same `since`, then completes: pg-boss's own retries, a jittered backoff
 * from 5 s, would all be spent within a few hours. A day after `since`, a
 * team still without a label takes a random one; a renamed team keeps its
 * label and goes on retrying hourly.
 */
export async function runSharedSubdomainJob(
  db: Db,
  deps: {
    sharedInboxDomain: string;
    review: SharedNameReview | undefined;
    requeue: (job: SharedSubdomainJob, startAfter: Date) => Promise<void>;
    now?: Date;
  },
  job: SharedSubdomainJob,
): Promise<void> {
  const now = deps.now ?? new Date();
  const outcome = await settleSharedSubdomain(db, {
    teamId: job.teamId,
    sharedInboxDomain: deps.sharedInboxDomain,
    review: deps.review,
    now,
    giveUp: now.getTime() - Date.parse(job.since) >= SHARED_SUBDOMAIN_FALLBACK_MS,
  });
  if (outcome === "unavailable") {
    await deps.requeue(job, new Date(now.getTime() + SHARED_SUBDOMAIN_RETRY_MS));
  }
}

/**
 * The backfill, run at boot and by the 15-minute sweep: stamps the labels
 * that older code put an inbox on without a stamp, then queues a job, due
 * now, for every team without a label, whose job may have been lost. A job
 * still waiting absorbs its team's new one and keeps its older `since`.
 * Nothing on an instance without a shared domain.
 */
export async function queueMissingSharedSubdomains(
  db: Db,
  deps: {
    sharedInboxDomain: string | null | undefined;
    sendMany: (jobs: SharedSubdomainJob[]) => Promise<void>;
    now?: Date;
  },
): Promise<{ stamped: number; queued: number }> {
  if (!deps.sharedInboxDomain) return { stamped: 0, queued: 0 };
  const stamped = await lockUsedSharedSubdomains(db);
  const since = (deps.now ?? new Date()).toISOString();
  const teamIds = await teamsWithoutSharedSubdomain(db);
  await deps.sendMany(teamIds.map((teamId) => ({ teamId, since })));
  return { stamped, queued: teamIds.length };
}
