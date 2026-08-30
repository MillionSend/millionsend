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

/** Products are found again by this metadata key, never by name (names are free to change). */
export const PRODUCT_METADATA_KEY = "millionsend_plan";

export type PaidPlan = keyof typeof PLAN_LOOKUP_KEYS;

export const PAID_PLANS = Object.keys(PLAN_LOOKUP_KEYS) as PaidPlan[];

/**
 * Price id per paid plan. Fetched on every call: checkouts are rare and a
 * price rotation must take effect without a restart.
 */
export async function resolvePrices(stripe: BillingStripe): Promise<Record<PaidPlan, string>> {
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

/** Expansion planFromSubscription needs on a retrieved subscription. */
export const SUBSCRIPTION_EXPAND = ["items.data.price.product"];

/**
 * v1 subscriptions carry exactly one item: the plan's monthly price. The
 * product's metadata is the durable link — a price rotation moves the lookup
 * key to the new price, so a legacy subscription's price no longer has one.
 */
export function planFromSubscription(sub: Stripe.Subscription): PaidPlan | null {
  const price = sub.items.data[0]?.price;
  const product = price?.product;
  const tagged =
    typeof product === "object" && "metadata" in product
      ? product.metadata[PRODUCT_METADATA_KEY]
      : undefined;
  return (
    PAID_PLANS.find((plan) => plan === tagged || PLAN_LOOKUP_KEYS[plan] === price?.lookup_key) ??
    null
  );
}
