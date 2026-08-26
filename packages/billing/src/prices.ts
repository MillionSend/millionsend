import type Stripe from "stripe";
import type { BillingStripe } from "./stripe.js";

/**
 * Prices are addressed by lookup key so the same code runs against any
 * Stripe account (test/live) without per-environment price ids.
 */
export const PLAN_LOOKUP_KEYS = {
  pro: "millionsend_pro_monthly",
  scale: "millionsend_scale_monthly",
} as const;

export type PaidPlan = keyof typeof PLAN_LOOKUP_KEYS;

export const PAID_PLANS = Object.keys(PLAN_LOOKUP_KEYS) as PaidPlan[];

const cache = new WeakMap<BillingStripe, Promise<Record<PaidPlan, string>>>();

/** Price id per paid plan, fetched once per Stripe client. */
export function resolvePrices(stripe: BillingStripe): Promise<Record<PaidPlan, string>> {
  let prices = cache.get(stripe);
  if (!prices) {
    prices = loadPrices(stripe);
    cache.set(stripe, prices);
    prices.catch(() => cache.delete(stripe));
  }
  return prices;
}

async function loadPrices(stripe: BillingStripe): Promise<Record<PaidPlan, string>> {
  const { data } = await stripe.prices.list({
    lookup_keys: Object.values(PLAN_LOOKUP_KEYS),
    active: true,
  });
  const ids = {} as Record<PaidPlan, string>;
  for (const plan of PAID_PLANS) {
    const price = data.find((p) => p.lookup_key === PLAN_LOOKUP_KEYS[plan]);
    if (!price) throw new Error(`Stripe price with lookup key ${PLAN_LOOKUP_KEYS[plan]} not found`);
    ids[plan] = price.id;
  }
  return ids;
}

/** v1 subscriptions carry exactly one item: the plan's monthly price. */
export function planFromSubscription(sub: Stripe.Subscription): PaidPlan | null {
  const key = sub.items.data[0]?.price.lookup_key;
  return PAID_PLANS.find((plan) => PLAN_LOOKUP_KEYS[plan] === key) ?? null;
}
