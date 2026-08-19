import { env } from "@millionsend/config";
import {
  applyStatusCas,
  deriveTrackingKey,
  enqueueWebhookDeliveries,
  utcDay,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

/**
 * Signing key for the open/click tokens the /t/o and /t/c endpoints verify.
 * Absent MASTER_ENCRYPTION_KEY (misconfigured deploy) there is no key, so every
 * token is treated as unverifiable — the endpoints degrade to 404 / blank pixel.
 */
export function trackingKey(): Buffer | null {
  if (!env.MASTER_ENCRYPTION_KEY) return null;
  return deriveTrackingKey(Buffer.from(env.MASTER_ENCRYPTION_KEY, "base64"));
}

/**
 * Repeat hits within this window are dropped entirely: mail proxies (Gmail
 * image cache, Apple MP) refetch the pixel in bursts, and a burst is one
 * engagement, not several.
 */
const DAMP_WINDOW_MS = 60_000;

/**
 * Records an app-layer engagement event for a verified tracking token. The
 * teamId is read from the email row — never taken from the request — so a
 * token can only ever touch its own email's team.
 *
 * Every verified hit records an event row (and fans out webhooks), damped to
 * at most one per minute per (email, type). The daily usage counter still
 * advances only on the FIRST open/click for this email — open/click RATES
 * stay unique-based, mirroring the old SES OPEN/CLICK path. Both endpoints
 * are public, so a missing/foreign/non-uuid emailId returns silently.
 */
export async function recordEngagement(
  db: Db,
  emailId: string,
  type: "opened" | "clicked",
  enqueueWebhookDelivery?: (deliveryId: string) => Promise<void>,
  data?: Record<string, unknown>,
): Promise<void> {
  // A raw non-uuid string must never reach a uuid column — Postgres would 500.
  if (!z.uuid().safeParse(emailId).success) return;

  const [email] = await db
    .select({
      id: schema.emails.id,
      teamId: schema.emails.teamId,
      from: schema.emails.from,
      to: schema.emails.to,
      subject: schema.emails.subject,
    })
    .from(schema.emails)
    .where(eq(schema.emails.id, emailId))
    .limit(1);
  if (!email) return;

  const occurredAt = new Date();
  const deliveryIds: string[] = [];
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [newest] = await tx
      .select({ occurredAt: schema.emailEvents.occurredAt })
      .from(schema.emailEvents)
      .where(and(eq(schema.emailEvents.emailId, email.id), eq(schema.emailEvents.type, type)))
      .orderBy(desc(schema.emailEvents.occurredAt))
      .limit(1);
    // ponytail: two concurrent identical hits could both miss `newest` and
    // slip the damping window — same race the SES path carries. A slightly-
    // high engagement event count is not a correctness/security concern; add
    // row locking if it ever matters.
    if (newest && occurredAt.getTime() - newest.occurredAt.getTime() < DAMP_WINDOW_MS) return;

    await tx
      .insert(schema.emailEvents)
      .values({ emailId: email.id, type, occurredAt, ...(data ? { data } : {}) });
    await applyStatusCas(tx, email.id, type);
    // Counter advances only on the first (unique) open/click per email:
    // dashboards divide it by sent/delivered, so it must count emails
    // engaged, not engagement hits.
    if (!newest) {
      await tx.execute(sql`
        insert into ${schema.usageCounters} (team_id, day, ${sql.raw(type)})
        values (${email.teamId}, ${utcDay(occurredAt)}, 1)
        on conflict (team_id, day) do update
          set ${sql.raw(type)} = ${schema.usageCounters}.${sql.raw(type)} + 1
      `);
    }

    // Fan every recorded open/click out to the team's webhook endpoints
    // (damped no-ops above never reach this): delivery rows join this
    // transaction (so the webhooks.reconcile sweep can recover a lost
    // enqueue), the queue send happens after commit.
    await enqueueWebhookDeliveries(tx, {
      teamId: email.teamId,
      email: { emailId: email.id, from: email.from, to: email.to, subject: email.subject },
      type: `email.${type}`,
      occurredAt,
      enqueue: async (deliveryId) => {
        deliveryIds.push(deliveryId);
      },
    });
  });

  if (enqueueWebhookDelivery) {
    for (const deliveryId of deliveryIds) {
      try {
        await enqueueWebhookDelivery(deliveryId);
      } catch (err) {
        console.error("webhook.deliver enqueue failed; reconcile sweep will recover", err);
      }
    }
  }
}
