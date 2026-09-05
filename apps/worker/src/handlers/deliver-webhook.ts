import {
  decryptWebhookSigningSecrets,
  type Keyring,
  type PostJsonResult,
  type QueuedWebhookDelivery,
  signWebhook,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_SCHEDULE_MS,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

/**
 * Delivers one webhook. The job payload carries only the deliveryId; every
 * fact (endpoint, secret, payload) is re-read from the database. Safe under
 * redelivery: terminal rows are skipped, and a retry job re-signs with a
 * fresh timestamp but the same webhook-id, so receivers can dedupe.
 */

export interface DeliverDeps {
  keyring: Keyring;
  /** SSRF-guarded POST (production: core's postJson; tests: a fake). */
  post: (url: string, body: string, headers: Record<string, string>) => Promise<PostJsonResult>;
  /** Re-enqueue this delivery for its next attempt, in its endpoint's fairness group. */
  reenqueue: (delivery: QueuedWebhookDelivery, at: Date) => Promise<void>;
  now?: () => Date;
}

export type DeliverOutcome = "success" | "retry" | "exhausted" | "skipped";

const RESPONSE_SNIPPET_CHARS = 1024;

/**
 * Circuit breaker: once this many of an endpoint's most recent settled
 * deliveries all exhausted their retries with no success in between, the
 * endpoint is auto-disabled and receives nothing further until re-enabled.
 */
export const WEBHOOK_AUTO_DISABLE_AFTER = 20;

/** Terminal abandon for a delivery whose job will never run again. */
export async function abandonWebhookDelivery(db: Db, deliveryId: string): Promise<boolean> {
  const [row] = await db
    .update(schema.webhookDeliveries)
    .set({ status: "exhausted", nextAttemptAt: null })
    .where(
      and(
        eq(schema.webhookDeliveries.id, deliveryId),
        inArray(schema.webhookDeliveries.status, ["pending", "failed"]),
      ),
    )
    .returning({ id: schema.webhookDeliveries.id });
  return row !== undefined;
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
    .orderBy(desc(d.createdAt), desc(d.id))
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
    console.warn(`webhook.deliver: endpoint ${endpointId} auto-disabled after repeated failures`);
  return row !== undefined;
}

export async function deliverWebhook(
  db: Db,
  deps: DeliverDeps,
  payload: { deliveryId: string },
): Promise<DeliverOutcome> {
  const [row] = await db
    .select({ delivery: schema.webhookDeliveries, endpoint: schema.webhookEndpoints })
    .from(schema.webhookDeliveries)
    .innerJoin(
      schema.webhookEndpoints,
      eq(schema.webhookDeliveries.endpointId, schema.webhookEndpoints.id),
    )
    .where(eq(schema.webhookDeliveries.id, payload.deliveryId));
  if (!row) return "skipped";
  const { delivery, endpoint } = row;
  if (delivery.status === "success" || delivery.status === "exhausted") return "skipped";
  if (endpoint.status !== "enabled") {
    // Endpoint turned off after the delivery was queued: abandon, don't stall
    // the retry sweep on a row that will never send.
    await abandonWebhookDelivery(db, delivery.id);
    return "skipped";
  }
  // How many deliveries of one endpoint run at once is the queue's job
  // (each job carries the endpoint as its fairness group), so a stalled
  // receiver holds its own two lanes and no one else's.
  const now = deps.now?.() ?? new Date();
  return attemptDelivery(db, deps, delivery, endpoint, now);
}

async function attemptDelivery(
  db: Db,
  deps: DeliverDeps,
  delivery: typeof schema.webhookDeliveries.$inferSelect,
  endpoint: typeof schema.webhookEndpoints.$inferSelect,
  now: Date,
): Promise<DeliverOutcome> {
  const secrets = await decryptWebhookSigningSecrets(endpoint, deps.keyring, now);

  const body = JSON.stringify(delivery.payload);
  const headers = signWebhook(secrets, {
    msgId: delivery.messageId,
    timestamp: Math.floor(now.getTime() / 1000),
    payload: body,
  });

  let status: number | null = null;
  let snippet: string;
  try {
    const res = await deps.post(endpoint.url, body, { ...headers });
    status = res.status;
    snippet = res.body.slice(0, RESPONSE_SNIPPET_CHARS);
  } catch (err) {
    snippet = (err instanceof Error ? err.message : String(err)).slice(0, RESPONSE_SNIPPET_CHARS);
  }

  const attempts = delivery.attempts + 1;
  const ok = status !== null && status >= 200 && status < 300;
  if (ok) {
    await db
      .update(schema.webhookDeliveries)
      .set({
        status: "success",
        attempts,
        lastAttemptAt: now,
        lastResponseCode: status,
        lastResponseBody: snippet,
        nextAttemptAt: null,
      })
      .where(eq(schema.webhookDeliveries.id, delivery.id));
    return "success";
  }

  const exhausted = attempts >= WEBHOOK_MAX_ATTEMPTS;
  const nextAttemptAt = exhausted
    ? null
    : new Date(now.getTime() + (WEBHOOK_RETRY_SCHEDULE_MS[attempts - 1] ?? 0));
  await db
    .update(schema.webhookDeliveries)
    .set({
      status: exhausted ? "exhausted" : "failed",
      attempts,
      lastAttemptAt: now,
      lastResponseCode: status,
      lastResponseBody: snippet,
      nextAttemptAt,
    })
    .where(eq(schema.webhookDeliveries.id, delivery.id));
  if (nextAttemptAt)
    await deps.reenqueue({ id: delivery.id, endpointId: endpoint.id }, nextAttemptAt);
  if (exhausted) await autoDisableIfDead(db, endpoint.id);
  return exhausted ? "exhausted" : "retry";
}
