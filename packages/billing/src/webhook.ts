import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { lt } from "drizzle-orm";
import type Stripe from "stripe";
import type { BillingDeps } from "./checkout.js";
import { SUBSCRIPTION_EXPAND } from "./prices.js";
import { applySubscription, idOf, lockCustomer } from "./subscription.js";

export interface WebhookDeps extends BillingDeps {
  webhookSecret: string;
  /** Mode of the configured API key; events from the other mode are rejected. */
  livemode: boolean;
}

/** Stripe redelivers for at most 3 days; older dedupe rows are dead weight. */
const EVENT_RETENTION_MS = 90 * 86_400_000;

/** Which subscription an event is about, plus the customer from the payload (lock key only). */
function subscriptionRef(
  event: Stripe.Event,
): { subscriptionId: string | null; customerId: string | null } | null {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      return { subscriptionId: idOf(session.subscription), customerId: idOf(session.customer) };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      return { subscriptionId: sub.id, customerId: idOf(sub.customer) };
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      return {
        subscriptionId: idOf(invoice.parent?.subscription_details?.subscription),
        customerId: idOf(invoice.customer),
      };
    }
    default:
      return null;
  }
}

/**
 * Verifies, dedupes, and applies a Stripe webhook. The plan is derived from
 * the subscription RE-FETCHED from Stripe, never from the event payload, so
 * out-of-order deliveries converge on Stripe's current state. Returns the
 * HTTP status to answer with; data we don't own (unknown customer, unknown
 * price) is logged and acknowledged so Stripe stops retrying it, while
 * infrastructure failures throw and roll back the ledger row so the retry
 * is processed again.
 */
export async function handleWebhook(
  rawBody: string,
  signature: string | null,
  deps: WebhookDeps,
): Promise<200 | 400> {
  let event: Stripe.Event;
  try {
    event = deps.stripe.webhooks.constructEvent(rawBody, signature ?? "", deps.webhookSecret);
  } catch {
    return 400;
  }
  if (event.livemode !== deps.livemode) return 400;
  const log = deps.log ?? console.warn;
  await deps.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.stripeEvents)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing()
      .returning({ id: schema.stripeEvents.id });
    if (inserted.length === 0) return;

    const ref = subscriptionRef(event);
    if (!ref?.subscriptionId) return;
    await lockCustomer(tx as unknown as Db, ref.customerId ?? ref.subscriptionId);
    const sub = await deps.stripe.subscriptions.retrieve(ref.subscriptionId, {
      expand: SUBSCRIPTION_EXPAND,
    });
    await applySubscription(tx as unknown as Db, sub, (m) =>
      log(`stripe webhook ${event.id}: ${m}`),
    );
  });
  return 200;
}

/** Drops dedupe rows past the retention window; returns how many. */
export async function purgeStripeEvents(db: Db, now = new Date()): Promise<number> {
  const rows = await db
    .delete(schema.stripeEvents)
    .where(lt(schema.stripeEvents.receivedAt, new Date(now.getTime() - EVENT_RETENTION_MS)))
    .returning({ id: schema.stripeEvents.id });
  return rows.length;
}
