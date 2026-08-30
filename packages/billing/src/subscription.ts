import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import type { BillingDeps } from "./checkout.js";
import { planFromSubscription, SUBSCRIPTION_EXPAND } from "./prices.js";

type Plan = (typeof schema.planEnum.enumValues)[number];
type PlanStatus = (typeof schema.planStatusEnum.enumValues)[number];

export function idOf(ref: string | { id: string } | null | undefined): string | null {
  return typeof ref === "string" ? ref : (ref?.id ?? null);
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

/**
 * Every writer of a team's billing columns takes this lock BEFORE fetching
 * the subscription from Stripe, so concurrent deliveries (or a reconcile
 * racing a webhook) can never apply a state older than one already applied.
 * Transaction-scoped: released on commit/rollback.
 */
export function lockCustomer(tx: Db, customerId: string): Promise<unknown> {
  return tx.execute(sql`select pg_advisory_xact_lock(hashtext(${customerId}))`);
}

/**
 * Applies a subscription fetched from Stripe to the team owning its customer.
 * Data we don't own (unknown customer, unknown product) is logged and
 * skipped; callers acknowledge such events so Stripe stops retrying them.
 */
export async function applySubscription(
  tx: Db,
  sub: Stripe.Subscription,
  log: (message: string) => void,
): Promise<void> {
  const customerId = idOf(sub.customer);
  const [team] = customerId
    ? await tx
        .select({
          id: schema.teams.id,
          plan: schema.teams.plan,
          stripeSubscriptionId: schema.teams.stripeSubscriptionId,
        })
        .from(schema.teams)
        .where(eq(schema.teams.stripeCustomerId, customerId))
    : [];
  if (!team) {
    log(`no team for customer ${customerId}`);
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
      log(`subscription ${sub.id} has no known plan price`);
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
      currentPeriodEnd: periodEnd(sub),
    })
    .where(eq(schema.teams.id, team.id));
}

async function loadBillingColumns(db: Db, teamId: string) {
  const [team] = await db
    .select({
      stripeCustomerId: schema.teams.stripeCustomerId,
      stripeSubscriptionId: schema.teams.stripeSubscriptionId,
    })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  return team ?? null;
}

/**
 * Re-derives the team's plan from Stripe's current state, for missed or
 * dropped webhooks. The customer's newest subscription is authoritative:
 * new ones are only created once the previous has ended.
 */
export async function reconcileTeamPlan(deps: BillingDeps, teamId: string): Promise<void> {
  const team = await loadBillingColumns(deps.db, teamId);
  if (!team?.stripeCustomerId) return;
  const customerId = team.stripeCustomerId;
  await deps.db.transaction(async (tx) => {
    await lockCustomer(tx as unknown as Db, customerId);
    const { data } = await deps.stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 1,
      expand: SUBSCRIPTION_EXPAND.map((path) => `data.${path}`),
    });
    const sub = data[0];
    if (!sub) return;
    await applySubscription(tx as unknown as Db, sub, deps.log ?? console.warn);
  });
}

/**
 * Cancels the team's subscription immediately (no final invoice) and clears
 * its plan; used when the team itself goes away. No-op without a live
 * subscription.
 */
export async function cancelTeamSubscription(deps: BillingDeps, teamId: string): Promise<void> {
  const team = await loadBillingColumns(deps.db, teamId);
  if (!team?.stripeSubscriptionId) return;
  const sub = await deps.stripe.subscriptions.retrieve(team.stripeSubscriptionId);
  if (sub.status !== "canceled" && sub.status !== "incomplete_expired") {
    await deps.stripe.subscriptions.cancel(sub.id, { invoice_now: false, prorate: false });
  }
  await deps.db
    .update(schema.teams)
    .set({
      plan: "free",
      planStatus: "canceled",
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
    })
    .where(eq(schema.teams.id, teamId));
}
