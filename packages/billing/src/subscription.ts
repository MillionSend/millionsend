import { type PlanRungKey, rungByKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import type { BillingDeps } from "./checkout.js";
import { reportOverage } from "./overage.js";
import {
  overageLookupKey,
  resolvePriceId,
  rungFromPrice,
  rungFromSubscription,
  rungLookupKey,
  SUBSCRIPTION_EXPAND,
  subscriptionItems,
} from "./prices.js";
import type { BillingStripe } from "./stripe.js";

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

const stamp = (seconds: number | null | undefined): Date | null =>
  seconds ? new Date(seconds * 1000) : null;

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
 * Data we don't own (unknown customer, unknown price) is logged and
 * skipped; callers acknowledge such events so Stripe stops retrying them.
 * With a Stripe client at hand, a metered item priced for another rung
 * (the plan item moved without it) is re-pointed, best effort.
 */
export async function applySubscription(
  tx: Db,
  sub: Stripe.Subscription,
  log: (message: string) => void,
  stripe?: BillingStripe,
): Promise<void> {
  const customerId = idOf(sub.customer);
  const [team] = customerId
    ? await tx
        .select({
          id: schema.teams.id,
          plan: schema.teams.plan,
          planQuota: schema.teams.planQuota,
          stripeSubscriptionId: schema.teams.stripeSubscriptionId,
          stripeOverageItemId: schema.teams.stripeOverageItemId,
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

  const { base, overage } = subscriptionItems(sub);
  let plan: Plan;
  let planQuota: number | null;
  if (entitled) {
    const rung = rungFromSubscription(sub);
    if (!rung) {
      log(`subscription ${sub.id} has no known plan price`);
      return;
    }
    plan = rung.plan;
    planQuota = rung.period === "month" ? rung.included : null;
    if (stripe && overage && rung.period === "month") {
      const expected = overageLookupKey(rung);
      if (rungFromPrice(overage.price)?.key !== rung.key) {
        try {
          const price = await resolvePriceId(stripe, expected);
          await stripe.subscriptionItems.update(overage.id, { price, proration_behavior: "none" });
        } catch (err) {
          log(`overage item ${overage.id} not re-pointed to ${expected}: ${String(err)}`);
        }
      }
    }
  } else if (sub.status === "past_due") {
    plan = team.plan;
    planQuota = team.planQuota;
  } else {
    plan = "free";
    planQuota = null;
  }
  const overageItemId = entitled || sub.status === "past_due" ? (overage?.id ?? null) : null;
  // The metered item is going (subscription ended, item removed elsewhere):
  // what it has not billed yet must reach the meter while the row still
  // names the item, inside Stripe's draft window for the closing period.
  if (stripe && team.stripeOverageItemId && overageItemId === null) {
    await reportOverage({ db: tx, stripe, log }, { teamId: team.id });
  }
  await tx
    .update(schema.teams)
    .set({
      plan,
      planQuota,
      planStatus: planStatusOf(sub.status),
      stripeSubscriptionId: sub.id,
      stripeOverageItemId: overageItemId,
      currentPeriodStart: stamp(base?.current_period_start),
      currentPeriodEnd: stamp(base?.current_period_end),
      cancelAt: stamp(sub.cancel_at),
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
    await applySubscription(tx as unknown as Db, sub, deps.log ?? console.warn, deps.stripe);
  });
}

/** The team's live subscription, expanded for rung resolution; throws when it has none. */
async function liveSubscription(deps: BillingDeps, teamId: string) {
  const team = await loadBillingColumns(deps.db, teamId);
  if (!team?.stripeCustomerId || !team.stripeSubscriptionId) {
    throw new Error("team has no subscription");
  }
  const sub = await deps.stripe.subscriptions.retrieve(team.stripeSubscriptionId, {
    expand: SUBSCRIPTION_EXPAND,
  });
  return { customerId: team.stripeCustomerId, sub };
}

/** Lock first, then read Stripe: the row never receives a state older than one already applied. */
async function applyLocked(deps: BillingDeps, customerId: string, subscriptionId: string) {
  await deps.db.transaction(async (tx) => {
    await lockCustomer(tx as unknown as Db, customerId);
    const sub = await deps.stripe.subscriptions.retrieve(subscriptionId, {
      expand: SUBSCRIPTION_EXPAND,
    });
    await applySubscription(tx as unknown as Db, sub, deps.log ?? console.warn, deps.stripe);
  });
}

/**
 * Moves a live subscription to another rung, prorated, keeping the metered
 * overage item in step (re-priced for a monthly rung, dropped for a daily
 * one after its usage is reported). Stripe's customer portal cannot switch
 * plans on a subscription with more than one item, so this is the one place
 * plan changes happen; the webhook that follows re-applies the same state.
 */
export async function changeRung(
  deps: BillingDeps,
  input: { teamId: string; rung: PlanRungKey },
): Promise<void> {
  const rung = rungByKey(input.rung);
  if (rung.priceCents <= 0) throw new Error(`rung ${input.rung} is not for sale`);
  const { customerId, sub } = await liveSubscription(deps, input.teamId);
  const { base, overage } = subscriptionItems(sub);
  if (!base) throw new Error(`subscription ${sub.id} has no plan item`);
  const items: Stripe.SubscriptionUpdateParams.Item[] = [
    { id: base.id, price: await resolvePriceId(deps.stripe, rungLookupKey(rung)) },
  ];
  // Sends made under the old rung settle at its rate before the move.
  if (overage) await reportOverage(deps, { teamId: input.teamId });
  if (overage) {
    if (rung.period === "month") {
      items.push({
        id: overage.id,
        price: await resolvePriceId(deps.stripe, overageLookupKey(rung)),
      });
    } else {
      items.push({ id: overage.id, deleted: true });
    }
  }
  await deps.stripe.subscriptions.update(sub.id, {
    items,
    proration_behavior: "create_prorations",
  });
  // What was accepted inside the old volume is never re-judged as overage
  // under a smaller one: the period row counts it as already settled.
  if (rung.period === "month" && base.current_period_start) {
    const p = schema.usagePeriods;
    await deps.db
      .update(p)
      .set({
        reportedOverage: sql`greatest(${p.reportedOverage}, ${p.accepted} - ${rung.included})`,
      })
      .where(
        and(
          eq(p.teamId, input.teamId),
          eq(p.periodStart, new Date(base.current_period_start * 1000)),
        ),
      );
  }
  await applyLocked(deps, customerId, sub.id);
}

/**
 * Turns overage billing on or off for a monthly plan by adding or removing
 * the rung's metered item. Off reports what is still unreported first, so
 * the usage reaches the invoice before the item goes.
 */
export async function setOverage(
  deps: BillingDeps,
  input: { teamId: string; enabled: boolean },
): Promise<void> {
  const { customerId, sub } = await liveSubscription(deps, input.teamId);
  const { base, overage } = subscriptionItems(sub);
  const rung = base ? rungFromPrice(base.price) : null;
  if (rung?.period !== "month") throw new Error("overage applies to monthly plans only");
  if (input.enabled && !overage) {
    await deps.stripe.subscriptionItems.create({
      subscription: sub.id,
      price: await resolvePriceId(deps.stripe, overageLookupKey(rung)),
    });
  } else if (!input.enabled && overage) {
    await reportOverage(deps, { teamId: input.teamId });
    await deps.stripe.subscriptionItems.del(overage.id);
  } else {
    return;
  }
  await applyLocked(deps, customerId, sub.id);
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
      planQuota: null,
      planStatus: "canceled",
      stripeSubscriptionId: null,
      stripeOverageItemId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAt: null,
    })
    .where(eq(schema.teams.id, teamId));
}
