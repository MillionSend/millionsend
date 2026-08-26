import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { BillingDeps } from "./checkout.js";
import { planFromSubscription } from "./prices.js";

export interface WebhookDeps extends BillingDeps {
  webhookSecret: string;
  log?: (message: string) => void;
}

type Plan = (typeof schema.planEnum.enumValues)[number];
type PlanStatus = (typeof schema.planStatusEnum.enumValues)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idOf(ref: string | { id: string } | null | undefined): string | null {
  return typeof ref === "string" ? ref : (ref?.id ?? null);
}

/** Which subscription an event is about, plus the team hint a Checkout session carries. */
function subscriptionRef(
  event: Stripe.Event,
): { subscriptionId: string | null; teamIdHint: string | null } | null {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      return {
        subscriptionId: idOf(session.subscription),
        teamIdHint: session.client_reference_id ?? session.metadata?.team_id ?? null,
      };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return { subscriptionId: event.data.object.id, teamIdHint: null };
    case "invoice.paid":
    case "invoice.payment_failed":
      return {
        subscriptionId: idOf(event.data.object.parent?.subscription_details?.subscription),
        teamIdHint: null,
      };
    default:
      return null;
  }
}

function planStatusOf(status: Stripe.Subscription.Status): PlanStatus {
  const known = schema.planStatusEnum.enumValues as readonly string[];
  if (known.includes(status)) return status as PlanStatus;
  return status === "incomplete_expired" ? "incomplete" : "canceled";
}

function periodEnd(sub: Stripe.Subscription): Date | null {
  const end = sub.items.data[0]?.current_period_end;
  return end ? new Date(end * 1000) : null;
}

const teamColumns = {
  id: schema.teams.id,
  plan: schema.teams.plan,
  stripeCustomerId: schema.teams.stripeCustomerId,
  stripeSubscriptionId: schema.teams.stripeSubscriptionId,
};

async function findTeam(db: Db, customerId: string | null, teamIdHint: string | null) {
  if (customerId) {
    const [team] = await db
      .select(teamColumns)
      .from(schema.teams)
      .where(eq(schema.teams.stripeCustomerId, customerId));
    if (team) return team;
  }
  if (teamIdHint && UUID.test(teamIdHint)) {
    const [team] = await db
      .select(teamColumns)
      .from(schema.teams)
      .where(eq(schema.teams.id, teamIdHint));
    return team ?? null;
  }
  return null;
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
    const sub = await deps.stripe.subscriptions.retrieve(ref.subscriptionId);
    const customerId = idOf(sub.customer);
    const team = await findTeam(tx as unknown as Db, customerId, ref.teamIdHint);
    if (!team) {
      log(`stripe webhook ${event.id}: no team for customer ${customerId}`);
      return;
    }

    const entitled = sub.status === "active" || sub.status === "trialing";
    // A superseded subscription ending must not revoke what the team's
    // current subscription grants: events about different subscriptions
    // arrive in any order.
    if (!entitled && team.stripeSubscriptionId && team.stripeSubscriptionId !== sub.id) return;

    let plan: Plan;
    if (entitled) {
      const paid = planFromSubscription(sub);
      if (!paid) {
        log(`stripe webhook ${event.id}: subscription ${sub.id} has no known plan price`);
        return;
      }
      plan = paid;
    } else if (sub.status === "past_due") {
      plan = team.plan;
    } else {
      plan = "free";
    }
    await tx
      .update(schema.teams)
      .set({
        plan,
        planStatus: planStatusOf(sub.status),
        stripeSubscriptionId: sub.id,
        stripeCustomerId: team.stripeCustomerId ?? customerId,
        currentPeriodEnd: periodEnd(sub),
      })
      .where(eq(schema.teams.id, team.id));
  });
  return 200;
}
