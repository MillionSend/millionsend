import {
  decryptWebhookSecret,
  type Keyring,
  type PostJsonResult,
  signWebhook,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_SCHEDULE_MS,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";

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
  /** Re-enqueue this delivery for its next attempt. */
  reenqueue: (deliveryId: string, at: Date) => Promise<void>;
  now?: () => Date;
}

export type DeliverOutcome = "success" | "retry" | "exhausted" | "skipped";

const RESPONSE_SNIPPET_CHARS = 1024;

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
    await db
      .update(schema.webhookDeliveries)
      .set({ status: "exhausted", nextAttemptAt: null })
      .where(eq(schema.webhookDeliveries.id, delivery.id));
    return "skipped";
  }

  const secret = await decryptWebhookSecret(
    {
      ciphertext: endpoint.secretCiphertext,
      iv: endpoint.secretIv,
      wrappedDek: endpoint.secretWrappedDek,
      keyVersion: endpoint.secretKeyVersion,
    },
    deps.keyring,
  );

  const now = deps.now?.() ?? new Date();
  const body = JSON.stringify(delivery.payload);
  const headers = signWebhook(secret, {
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
  if (nextAttemptAt) await deps.reenqueue(delivery.id, nextAttemptAt);
  return exhausted ? "exhausted" : "retry";
}
