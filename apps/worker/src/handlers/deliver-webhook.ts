import {
  decryptWebhookSigningSecrets,
  type Keyring,
  type PostJsonResult,
  retryAfterMs,
  signWebhook,
  WEBHOOK_MAX_AGE_MS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_MAX_RATE_PER_SECOND,
  WEBHOOK_RETRY_SCHEDULE_MS,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, eq, inArray, isNotNull, lte, type SQL, sql } from "drizzle-orm";
import { createTokenBucket } from "./send-email.js";

/**
 * Drains one endpoint's due deliveries. The job payload carries only the
 * endpointId; webhook_deliveries is the backlog and every fact (endpoint,
 * secret, payload) is re-read from it. A pass claims due rows in pages
 * under a lease on next_attempt_at, posts them in order at the platform
 * rate, and re-arms itself for the endpoint's next due instant, so a slow
 * receiver's backlog lives in its own rows and never in the job table.
 */

export interface DrainDeps {
  keyring: Keyring;
  /**
   * SSRF-guarded POST (production: core's postJson; tests: a fake).
   * `retryAfter` is the receiver's raw Retry-After header when it sent one.
   */
  post: (
    url: string,
    body: string,
    headers: Record<string, string>,
  ) => Promise<PostJsonResult & { retryAfter?: string | null }>;
  /** Queue this endpoint's next drain pass, to start no earlier than `at`. */
  rearm: (endpointId: string, at: Date) => Promise<void>;
  now?: () => Date;
}

export interface DrainOutcome {
  posted: number;
  exhausted: number;
  rearmAt: Date | null;
}

/** Wall-clock budget of one pass; whatever is left waits for the re-armed successor. */
const DRAIN_BUDGET_MS = 20_000;
const DRAIN_PAGE = 50;
/** How far a claim pushes next_attempt_at: a pass that dies mid-page releases its rows by itself. */
const LEASE_MS = 60_000;
/**
 * Longest a re-arm may park. A queued drain job is the endpoint's singleton
 * (short policy), so one parked further out would swallow the job a fresh
 * insert tries to arm and delay that row until the park ends.
 */
const DRAIN_IDLE_POLL_MS = 60_000;
const SETTLE_BATCH = 1000;
const RESPONSE_SNIPPET_CHARS = 1024;

const OPEN_STATUSES = ["pending", "failed"] as const;

/**
 * Circuit breaker: once this many of an endpoint's most recent settled
 * deliveries all exhausted their retries with no success in between, the
 * endpoint is auto-disabled and receives nothing further until re-enabled.
 */
export const WEBHOOK_AUTO_DISABLE_AFTER = 20;

/** Exhausts open rows matching `condition` in bounded batches; returns how many. */
export async function exhaustOpenDeliveries(db: Db, condition: SQL, order?: SQL): Promise<number> {
  const d = schema.webhookDeliveries;
  let total = 0;
  for (;;) {
    const batch = await db
      .update(d)
      .set({ status: "exhausted", nextAttemptAt: null })
      .where(
        inArray(
          d.id,
          db
            .select({ id: d.id })
            .from(d)
            .where(and(inArray(d.status, OPEN_STATUSES), condition))
            .orderBy(...(order ? [order] : []))
            .limit(SETTLE_BATCH),
        ),
      )
      .returning({ id: d.id });
    total += batch.length;
    if (batch.length < SETTLE_BATCH) break;
  }
  return total;
}

/**
 * Trips the breaker when the endpoint's last WEBHOOK_AUTO_DISABLE_AFTER
 * settled deliveries are all exhausted. Ordered by delivery creation, which
 * approximates "consecutive" closely enough for a dead endpoint.
 */
async function autoDisableIfDead(db: Db, endpointId: string): Promise<boolean> {
  const d = schema.webhookDeliveries;
  const recent = db
    .select({ status: d.status })
    .from(d)
    .where(and(eq(d.endpointId, endpointId), inArray(d.status, ["success", "exhausted"])))
    // Spelled out so it matches the settled index; a bare desc reads nulls first.
    .orderBy(sql`${d.createdAt} desc nulls last`, sql`${d.id} desc nulls last`)
    .limit(WEBHOOK_AUTO_DISABLE_AFTER)
    .as("recent");
  const [stats] = await db
    .select({
      settled: sql<number>`count(*)::int`,
      succeeded: sql<number>`count(*) filter (where ${recent.status} = 'success')::int`,
    })
    .from(recent);
  if (!stats || stats.settled < WEBHOOK_AUTO_DISABLE_AFTER || stats.succeeded > 0) return false;
  const [row] = await db
    .update(schema.webhookEndpoints)
    .set({ status: "auto_disabled" })
    .where(
      and(
        eq(schema.webhookEndpoints.id, endpointId),
        eq(schema.webhookEndpoints.status, "enabled"),
      ),
    )
    .returning({ id: schema.webhookEndpoints.id });
  if (row)
    console.warn(`webhook.drain: endpoint ${endpointId} auto-disabled after repeated failures`);
  return row !== undefined;
}

/**
 * One statement claims the endpoint's due rows in due order and leases
 * them: SKIP LOCKED keeps two passes on one endpoint (a successor armed
 * while this one runs) off the same rows. RETURNING reads the pre-lease due
 * instant off the locked subquery so the page can be posted in that order.
 */
async function claimDue(db: Db, endpointId: string, now: Date) {
  const d = schema.webhookDeliveries;
  const due = db
    .select({ id: d.id, dueAt: d.nextAttemptAt })
    .from(d)
    .where(
      and(
        eq(d.endpointId, endpointId),
        inArray(d.status, OPEN_STATUSES),
        lte(d.nextAttemptAt, now),
      ),
    )
    .orderBy(asc(d.nextAttemptAt), asc(d.id))
    .limit(DRAIN_PAGE)
    .for("update", { skipLocked: true })
    .as("due");
  const rows = await db
    .update(d)
    .set({ nextAttemptAt: new Date(now.getTime() + LEASE_MS) })
    .from(due)
    .where(eq(d.id, due.id))
    .returning({
      id: d.id,
      messageId: d.messageId,
      payload: d.payload,
      attempts: d.attempts,
      createdAt: d.createdAt,
      dueAt: due.dueAt,
    });
  return rows.sort(
    (a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0) || a.id.localeCompare(b.id),
  );
}

type ClaimedRow = Awaited<ReturnType<typeof claimDue>>[number];

/** Hands leased rows back: due again at `at`, for the next pass to claim. */
async function release(db: Db, rows: readonly ClaimedRow[], at: Date): Promise<void> {
  if (rows.length === 0) return;
  await db
    .update(schema.webhookDeliveries)
    .set({ nextAttemptAt: at })
    .where(
      inArray(
        schema.webhookDeliveries.id,
        rows.map((r) => r.id),
      ),
    );
}

export async function drainWebhookEndpoint(
  db: Db,
  deps: DrainDeps,
  payload: { endpointId: string },
): Promise<DrainOutcome> {
  const { endpointId } = payload;
  const now = deps.now ?? (() => new Date());
  const outcome: DrainOutcome = { posted: 0, exhausted: 0, rearmAt: null };
  const d = schema.webhookDeliveries;
  const [endpoint] = await db
    .select()
    .from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.id, endpointId));
  if (!endpoint) return outcome;
  if (endpoint.status !== "enabled") {
    // Turned off with rows still open: settle them rather than leave a
    // backlog nobody will ever post.
    outcome.exhausted = await exhaustOpenDeliveries(db, eq(d.endpointId, endpointId));
    return outcome;
  }

  const started = now();
  const secrets = await decryptWebhookSigningSecrets(endpoint, deps.keyring, started);
  // ponytail: the bucket is per pass, so a successor pass armed while this
  // one runs shares nothing with it; a process-wide bucket per endpoint is
  // the upgrade if two passes on one endpoint ever overlap for long.
  const bucket = createTokenBucket(WEBHOOK_MAX_RATE_PER_SECOND);
  const overBudget = (at: Date) => at.getTime() - started.getTime() >= DRAIN_BUDGET_MS;

  pass: while (!overBudget(now())) {
    const page = await claimDue(db, endpointId, now());
    if (page.length === 0) break;
    for (let i = 0; i < page.length; i += 1) {
      const row = page[i] as ClaimedRow;
      const rest = page.slice(i + 1);
      const at = now();
      if (overBudget(at)) {
        await release(db, page.slice(i), at);
        break pass;
      }
      if (at.getTime() - row.createdAt.getTime() >= WEBHOOK_MAX_AGE_MS) {
        await db
          .update(d)
          .set({ status: "exhausted", nextAttemptAt: null })
          .where(eq(d.id, row.id));
        outcome.exhausted += 1;
        if (await autoDisableIfDead(db, endpointId)) {
          await release(db, rest, at);
          break pass;
        }
        continue;
      }

      await bucket.take();
      const body = JSON.stringify(row.payload);
      const headers = signWebhook(secrets, {
        msgId: row.messageId,
        timestamp: Math.floor(at.getTime() / 1000),
        payload: body,
      });
      let status: number | null = null;
      let snippet: string;
      let retryAfter: string | null | undefined;
      try {
        const res = await deps.post(endpoint.url, body, { ...headers });
        status = res.status;
        snippet = res.body.slice(0, RESPONSE_SNIPPET_CHARS);
        retryAfter = res.retryAfter;
      } catch (err) {
        snippet = (err instanceof Error ? err.message : String(err)).slice(
          0,
          RESPONSE_SNIPPET_CHARS,
        );
      }
      outcome.posted += 1;

      if (status === 429) {
        // The receiver is asking for room, not failing: no attempt is
        // charged, and the whole page waits out its Retry-After.
        const until = new Date(at.getTime() + retryAfterMs(retryAfter, at));
        await db
          .update(d)
          .set({
            lastAttemptAt: at,
            lastResponseCode: status,
            lastResponseBody: snippet,
            nextAttemptAt: until,
          })
          .where(eq(d.id, row.id));
        await release(db, rest, until);
        break pass;
      }

      const attempts = row.attempts + 1;
      const ok = status !== null && status >= 200 && status < 300;
      const exhausted = !ok && attempts >= WEBHOOK_MAX_ATTEMPTS;
      const nextAttemptAt =
        ok || exhausted
          ? null
          : new Date(at.getTime() + (WEBHOOK_RETRY_SCHEDULE_MS[attempts - 1] ?? 0));
      await db
        .update(d)
        .set({
          status: ok ? "success" : exhausted ? "exhausted" : "failed",
          attempts,
          lastAttemptAt: at,
          lastResponseCode: status,
          lastResponseBody: snippet,
          nextAttemptAt,
        })
        .where(eq(d.id, row.id));
      if (exhausted) {
        outcome.exhausted += 1;
        if (await autoDisableIfDead(db, endpointId)) {
          await release(db, rest, at);
          break pass;
        }
      }
    }
  }

  const [next] = await db
    .select({ at: d.nextAttemptAt })
    .from(d)
    .where(
      and(
        eq(d.endpointId, endpointId),
        inArray(d.status, OPEN_STATUSES),
        isNotNull(d.nextAttemptAt),
      ),
    )
    .orderBy(asc(d.nextAttemptAt))
    .limit(1);
  if (next?.at) {
    outcome.rearmAt = new Date(Math.min(next.at.getTime(), now().getTime() + DRAIN_IDLE_POLL_MS));
    await deps.rearm(endpointId, outcome.rearmAt);
  }
  return outcome;
}
