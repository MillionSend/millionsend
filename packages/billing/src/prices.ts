import {
  isPlanRungKey,
  PAID_RUNGS,
  PLAN_RUNGS,
  type PlanRung,
  type PlanRungKey,
  rungByKey,
} from "@millionsend/core";
import type Stripe from "stripe";
import type { BillingStripe } from "./stripe.js";

/** Products are found again by this metadata key, never by name (names are free to change). */
export const PRODUCT_METADATA_KEY = "millionsend_plan";
/** Price metadata naming the rung: the durable link from a subscription item back to the ladder. */
export const RUNG_METADATA_KEY = "millionsend_rung";
/** The Stripe meter sends past the included volume are reported to. */
export const METER_EVENT_NAME = "emails_over_quota";

/**
 * Prices are addressed by lookup key so the same code runs against any
 * Stripe account (test/live) without per-environment price ids.
 */
export const rungLookupKey = (rung: PlanRung): string => `millionsend_${rung.key}_monthly`;
export const overageLookupKey = (rung: PlanRung): string => `millionsend_${rung.key}_overage`;

/**
 * Lookup keys of the prices sold before the ladder existed, and the rung
 * each one entitles: the old Pro is the first Pro rung, the old unlimited
 * Scale is the first Scale rung. A subscription still on one keeps its
 * entitlement until it is moved.
 */
export const LEGACY_LOOKUP_KEYS: Record<string, PlanRungKey> = {
  millionsend_pro_monthly: "pro_100k",
  millionsend_scale_monthly: "scale_500k",
};

/** The metadata every ladder price carries; the rung key is what the code reads back. */
export function priceMetadata(rung: PlanRung): Record<string, string> {
  return {
    [RUNG_METADATA_KEY]: rung.key,
    plan: rung.plan,
    included_emails: String(rung.included),
    period: rung.period,
    ...(rung.overageCentsPer1k !== null
      ? { overage_cents_per_1k: String(rung.overageCentsPer1k) }
      : {}),
  };
}

/**
 * The active price behind a lookup key. Fetched on every call: checkouts and
 * plan changes are rare and a price rotation must take effect without a
 * restart.
 */
export async function resolvePriceId(stripe: BillingStripe, lookupKey: string): Promise<string> {
  const { data } = await stripe.prices.list({ lookup_keys: [lookupKey], active: true });
  const price = data.find((p) => p.lookup_key === lookupKey);
  if (!price) throw new Error(`Stripe price with lookup key ${lookupKey} not found`);
  return price.id;
}

/** Expansion rungFromSubscription needs on a retrieved subscription. */
export const SUBSCRIPTION_EXPAND = ["items.data.price.product"];

export const isMeteredPrice = (price: Stripe.Price): boolean =>
  price.recurring?.usage_type === "metered";

/**
 * Which rung a price (plan or metered overage) belongs to. The price's own
 * metadata is the durable link; the lookup key covers prices provisioned
 * before metadata was written; the legacy keys cover the two pre-ladder
 * prices; and the product's metadata catches a rotated price that lost its
 * key, landing on the plan's first rung.
 */
export function rungFromPrice(price: Stripe.Price): PlanRung | null {
  const tagged = price.metadata?.[RUNG_METADATA_KEY];
  if (isPlanRungKey(tagged)) return rungByKey(tagged);
  const key = price.lookup_key;
  if (key) {
    const byKey = PLAN_RUNGS.find((r) => rungLookupKey(r) === key || overageLookupKey(r) === key);
    if (byKey) return byKey;
    const legacy = LEGACY_LOOKUP_KEYS[key];
    if (legacy) return rungByKey(legacy);
  }
  const product = price.product;
  const plan =
    typeof product === "object" && product !== null && "metadata" in product
      ? product.metadata[PRODUCT_METADATA_KEY]
      : undefined;
  return PAID_RUNGS.find((r) => r.plan === plan) ?? null;
}

/** A subscription's plan item and, when overage is on, its metered item. */
export function subscriptionItems(sub: Stripe.Subscription): {
  base: Stripe.SubscriptionItem | null;
  overage: Stripe.SubscriptionItem | null;
} {
  const items = sub.items.data;
  return {
    base: items.find((i) => !isMeteredPrice(i.price)) ?? null,
    overage: items.find((i) => isMeteredPrice(i.price)) ?? null,
  };
}

export function rungFromSubscription(sub: Stripe.Subscription): PlanRung | null {
  const { base } = subscriptionItems(sub);
  return base ? rungFromPrice(base.price) : null;
}
