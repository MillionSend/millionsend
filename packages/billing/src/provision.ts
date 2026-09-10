import { PAID_RUNGS, PLAN_NAME, type Plan, type PlanRung } from "@millionsend/core";
import Stripe from "stripe";
import {
  METER_EVENT_NAME,
  overageLookupKey,
  PRODUCT_METADATA_KEY,
  priceMetadata,
  rungLookupKey,
} from "./prices.js";

/** The Stripe surface provisioning touches; the real client satisfies it, tests inject a fake. */
export interface ProvisionStripe {
  products: {
    list(params: Stripe.ProductListParams): Promise<Stripe.ApiList<Stripe.Product>>;
    create(params: Stripe.ProductCreateParams): Promise<Stripe.Product>;
  };
  prices: {
    list(params: Stripe.PriceListParams): Promise<Stripe.ApiList<Stripe.Price>>;
    create(params: Stripe.PriceCreateParams): Promise<Stripe.Price>;
    update(id: string, params: Stripe.PriceUpdateParams): Promise<Stripe.Price>;
  };
  billing: {
    meters: {
      list(params: Stripe.Billing.MeterListParams): Promise<Stripe.ApiList<Stripe.Billing.Meter>>;
      create(params: Stripe.Billing.MeterCreateParams): Promise<Stripe.Billing.Meter>;
    };
  };
  webhookEndpoints: {
    list(params: Stripe.WebhookEndpointListParams): Promise<Stripe.ApiList<Stripe.WebhookEndpoint>>;
    create(params: Stripe.WebhookEndpointCreateParams): Promise<Stripe.WebhookEndpoint>;
    update(id: string, params: Stripe.WebhookEndpointUpdateParams): Promise<Stripe.WebhookEndpoint>;
  };
  billingPortal: {
    configurations: {
      list(
        params: Stripe.BillingPortal.ConfigurationListParams,
      ): Promise<Stripe.ApiList<Stripe.BillingPortal.Configuration>>;
      create(
        params: Stripe.BillingPortal.ConfigurationCreateParams,
      ): Promise<Stripe.BillingPortal.Configuration>;
      update(
        id: string,
        params: Stripe.BillingPortal.ConfigurationUpdateParams,
      ): Promise<Stripe.BillingPortal.Configuration>;
    };
  };
}

/** Portal configurations carry this marker so re-runs update rather than duplicate. */
export const PORTAL_METADATA = { millionsend: "portal" } as const;
/** Stripe Tax code "Software as a service (SaaS) — business use". */
export const SAAS_BUSINESS_TAX_CODE = "txcd_10103001";

/**
 * Exactly the events handleWebhook consumes. Nothing else is subscribed so
 * the ledger only holds events the app acts on.
 */
export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
] as const satisfies readonly Stripe.WebhookEndpointCreateParams.EnabledEvent[];

/** Plans that are sold: one Stripe product each, holding every rung's prices. */
export const PAID_PLANS = [...new Set(PAID_RUNGS.map((r) => r.plan))] as Plan[];

export interface ProvisionOptions {
  /** Public URL of /api/billing/webhook; omitted = no endpoint (local `stripe listen`). */
  webhookUrl?: string | undefined;
  /** Create/refresh the customer-portal configuration referenced by STRIPE_PORTAL_CONFIG. */
  portal?: boolean | undefined;
  /** Dashboard origin the portal returns to (its Billing page); omitted = Stripe's default. */
  appUrl?: string | undefined;
  log?: ((line: string) => void) | undefined;
}

export interface ProvisionResult {
  products: Record<string, string>;
  /** Plan price per rung key. */
  prices: Record<string, string>;
  /** Metered overage price per monthly rung key. */
  overagePrices: Record<string, string>;
  meter: string;
  webhook?: { id: string; secret?: string | undefined } | undefined;
  portalConfiguration?: string | undefined;
}

/** Everything the API cannot do; printed after every run so nothing is forgotten. */
export const DASHBOARD_CHECKLIST = [
  "Stripe Tax: enable it and add the tax registrations for the jurisdictions you sell in (Settings → Tax).",
  "Business profile: legal name, support email/URL, and the statement descriptor shown on card statements (Settings → Public details).",
  "Branding: logo, icon, and colors used by Checkout, the customer portal, invoices, and emails (Settings → Branding).",
  "Customer emails: turn on successful-payment receipts and failed-payment notices (Settings → Emails).",
  "Existing subscriptions on an archived price keep it; move each one to its new rung price from the subscription page (no proration, at period end).",
  "Live mode: repeat the provisioning with the live secret key; test and live objects are separate.",
] as const;

async function ensureProduct(
  stripe: ProvisionStripe,
  plan: Plan,
  log: (line: string) => void,
): Promise<string> {
  const { data } = await stripe.products.list({ active: true, limit: 100 });
  const existing = data.find((p) => p.metadata[PRODUCT_METADATA_KEY] === plan);
  if (existing) {
    log(`product ${plan}: ${existing.id} (existing)`);
    return existing.id;
  }
  const created = await stripe.products.create({
    name: `MillionSend ${PLAN_NAME[plan]}`,
    metadata: { [PRODUCT_METADATA_KEY]: plan },
    tax_code: SAAS_BUSINESS_TAX_CODE,
  });
  log(`product ${plan}: ${created.id} (created)`);
  return created.id;
}

async function ensureMeter(stripe: ProvisionStripe, log: (line: string) => void): Promise<string> {
  const { data } = await stripe.billing.meters.list({ status: "active", limit: 100 });
  const existing = data.find((m) => m.event_name === METER_EVENT_NAME);
  if (existing) {
    log(`meter ${METER_EVENT_NAME}: ${existing.id} (existing)`);
    return existing.id;
  }
  const created = await stripe.billing.meters.create({
    display_name: "Emails over quota",
    event_name: METER_EVENT_NAME,
    default_aggregation: { formula: "sum" },
    customer_mapping: { event_payload_key: "stripe_customer_id", type: "by_id" },
    value_settings: { event_payload_key: "value" },
  });
  log(`meter ${METER_EVENT_NAME}: ${created.id} (created)`);
  return created.id;
}

interface PriceSpec {
  lookupKey: string;
  product: string;
  unitAmount: number;
  metadata: Record<string, string>;
  /** Present on the metered overage prices. */
  meter?: string | undefined;
}

function priceMatches(price: Stripe.Price, spec: PriceSpec): boolean {
  if (!price.active || price.unit_amount !== spec.unitAmount || price.currency !== "usd") {
    return false;
  }
  if (price.recurring?.interval !== "month") return false;
  if (spec.meter) {
    return (
      price.recurring.usage_type === "metered" &&
      price.recurring.meter === spec.meter &&
      price.transform_quantity?.divide_by === 1000
    );
  }
  return price.recurring.usage_type !== "metered";
}

/**
 * Prices are immutable in Stripe, so a changed amount creates a new price
 * and moves the lookup key onto it (transfer_lookup_key), then archives the
 * old one. Existing subscriptions keep their old price (identified by its
 * metadata or product thereafter); new checkouts pick up the new amount
 * immediately. Metadata alone is mutable and is refreshed in place.
 */
async function ensurePrice(
  stripe: ProvisionStripe,
  spec: PriceSpec,
  log: (line: string) => void,
): Promise<string> {
  const { data } = await stripe.prices.list({ lookup_keys: [spec.lookupKey], limit: 10 });
  const current = data.find((p) => p.lookup_key === spec.lookupKey);
  const label = `${spec.unitAmount} cents${spec.meter ? " per 1,000 over quota" : "/month"}`;
  if (current && priceMatches(current, spec)) {
    const stale = Object.entries(spec.metadata).some(([k, v]) => current.metadata?.[k] !== v);
    if (stale) await stripe.prices.update(current.id, { metadata: spec.metadata });
    log(
      `price ${spec.lookupKey}: ${current.id} (existing, ${label}${stale ? ", metadata refreshed" : ""})`,
    );
    return current.id;
  }
  const created = await stripe.prices.create({
    product: spec.product,
    currency: "usd",
    unit_amount: spec.unitAmount,
    recurring: spec.meter
      ? { interval: "month", usage_type: "metered", meter: spec.meter }
      : { interval: "month" },
    ...(spec.meter
      ? { billing_scheme: "per_unit", transform_quantity: { divide_by: 1000, round: "up" } }
      : {}),
    lookup_key: spec.lookupKey,
    transfer_lookup_key: true,
    tax_behavior: "exclusive",
    metadata: spec.metadata,
  });
  if (current) {
    await stripe.prices.update(current.id, { active: false });
    log(`price ${spec.lookupKey}: ${created.id} (replaced ${current.id}, ${label})`);
  } else {
    log(`price ${spec.lookupKey}: ${created.id} (created, ${label})`);
  }
  return created.id;
}

/**
 * Lookup keys of the two prices sold before the ladder. Stripe never deletes
 * a price a subscription has used, so they are archived: the subscriptions
 * still on them keep working (resolving to the plan's first rung through the
 * product's metadata) until each is moved; only new checkouts stop seeing them.
 */
const LEGACY_PRICE_LOOKUP_KEYS = ["millionsend_pro_monthly", "millionsend_scale_monthly"];

async function archiveLegacyPrices(
  stripe: ProvisionStripe,
  log: (line: string) => void,
): Promise<void> {
  const keys = LEGACY_PRICE_LOOKUP_KEYS;
  const { data } = await stripe.prices.list({ lookup_keys: keys, limit: 10 });
  for (const price of data) {
    if (!price.lookup_key || !keys.includes(price.lookup_key)) continue;
    if (price.active) {
      await stripe.prices.update(price.id, { active: false });
      log(`price ${price.lookup_key}: ${price.id} (archived)`);
    } else {
      log(`price ${price.lookup_key}: ${price.id} (already archived)`);
    }
  }
}

function sameEvents(a: readonly string[], b: readonly string[]): boolean {
  return [...a].sort().join() === [...b].sort().join();
}

async function ensureWebhook(
  stripe: ProvisionStripe,
  url: string,
  log: (line: string) => void,
): Promise<ProvisionResult["webhook"]> {
  const { data } = await stripe.webhookEndpoints.list({ limit: 100 });
  const existing = data.find((w) => w.url === url);
  if (existing) {
    if (!sameEvents(existing.enabled_events, WEBHOOK_EVENTS)) {
      await stripe.webhookEndpoints.update(existing.id, { enabled_events: [...WEBHOOK_EVENTS] });
      log(`webhook: ${existing.id} (existing, events updated)`);
    } else {
      log(`webhook: ${existing.id} (existing)`);
    }
    log(
      "webhook: Stripe only reveals the signing secret at creation. To rotate it, roll it in the dashboard (Developers → Webhooks → the endpoint → Roll secret).",
    );
    return { id: existing.id };
  }
  // Event payload shapes follow the endpoint's API version, not the SDK's;
  // pinning them equal keeps handleWebhook's field reads valid (e.g.
  // invoice.parent.subscription_details).
  const created = await stripe.webhookEndpoints.create({
    url,
    enabled_events: [...WEBHOOK_EVENTS],
    api_version: Stripe.API_VERSION,
    description: "MillionSend billing",
  });
  log(`webhook: ${created.id} (created)`);
  if (created.secret) {
    log(`webhook: STRIPE_WEBHOOK_SECRET=${created.secret}`);
    log("webhook: this signing secret is shown ONCE and cannot be read back later — store it now.");
  }
  return { id: created.id, secret: created.secret };
}

/**
 * Plan switches are NOT offered in the portal: Stripe's portal cannot update
 * a subscription that carries more than one item, and a subscription with
 * overage on carries two. The dashboard moves rungs through the API instead.
 */
function portalFeatures(): Stripe.BillingPortal.ConfigurationCreateParams.Features {
  return {
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    customer_update: { enabled: true, allowed_updates: ["email", "name", "address", "tax_id"] },
    subscription_cancel: {
      enabled: true,
      mode: "at_period_end",
      cancellation_reason: {
        enabled: true,
        options: [
          "too_expensive",
          "missing_features",
          "switched_service",
          "unused",
          "customer_service",
          "too_complex",
          "low_quality",
          "other",
        ],
      },
    },
    subscription_update: { enabled: false },
  };
}

/** The legal links the portal shows; the marketing site hosts them. */
const PORTAL_BUSINESS_PROFILE = {
  terms_of_service_url: "https://millionsend.com/terms",
  privacy_policy_url: "https://millionsend.com/privacy",
} as const;

async function ensurePortal(
  stripe: ProvisionStripe,
  appUrl: string | undefined,
  log: (line: string) => void,
): Promise<string> {
  const settings = {
    features: portalFeatures(),
    business_profile: PORTAL_BUSINESS_PROFILE,
    ...(appUrl ? { default_return_url: `${appUrl.replace(/\/+$/, "")}/settings/billing` } : {}),
  };
  const { data } = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
  const existing = data.find((c) => c.metadata?.millionsend === PORTAL_METADATA.millionsend);
  if (existing) {
    await stripe.billingPortal.configurations.update(existing.id, settings);
    log(`portal: ${existing.id} (existing, settings refreshed)`);
    return existing.id;
  }
  const created = await stripe.billingPortal.configurations.create({
    ...settings,
    metadata: PORTAL_METADATA,
  });
  log(`portal: ${created.id} (created)`);
  return created.id;
}

/** The specs behind the ladder: one plan price per paid rung, one metered price per monthly rung. */
export function priceSpecs(
  products: Record<string, string>,
  meter: string,
): { plan: PriceSpec; overage: PriceSpec | null; rung: PlanRung }[] {
  return PAID_RUNGS.map((rung) => {
    const product = products[rung.plan];
    if (!product) throw new Error(`no product for plan ${rung.plan}`);
    const metadata = priceMetadata(rung);
    return {
      rung,
      plan: { lookupKey: rungLookupKey(rung), product, unitAmount: rung.priceCents, metadata },
      overage:
        rung.overageCentsPer1k === null
          ? null
          : {
              lookupKey: overageLookupKey(rung),
              product,
              unitAmount: rung.overageCentsPer1k,
              metadata,
              meter,
            },
    };
  });
}

export async function provision(
  stripe: ProvisionStripe,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const log = options.log ?? console.log;
  const products: Record<string, string> = {};
  for (const plan of PAID_PLANS) products[plan] = await ensureProduct(stripe, plan, log);
  const meter = await ensureMeter(stripe, log);
  const prices: Record<string, string> = {};
  const overagePrices: Record<string, string> = {};
  for (const spec of priceSpecs(products, meter)) {
    prices[spec.rung.key] = await ensurePrice(stripe, spec.plan, log);
    if (spec.overage) overagePrices[spec.rung.key] = await ensurePrice(stripe, spec.overage, log);
  }
  await archiveLegacyPrices(stripe, log);
  const result: ProvisionResult = { products, prices, overagePrices, meter };
  if (options.webhookUrl) result.webhook = await ensureWebhook(stripe, options.webhookUrl, log);
  if (options.portal) {
    result.portalConfiguration = await ensurePortal(stripe, options.appUrl, log);
    log(`portal: STRIPE_PORTAL_CONFIG=${result.portalConfiguration}`);
  }
  log("");
  log("Dashboard-only steps (the API cannot do these):");
  for (const item of DASHBOARD_CHECKLIST) log(`  - ${item}`);
  return result;
}

/** Reads go to Stripe; every write is logged and answered with a placeholder id. */
export function dryRunStripe(
  stripe: ProvisionStripe,
  log: (line: string) => void,
): ProvisionStripe {
  const stub =
    <T>(label: string) =>
    async (...args: unknown[]): Promise<T> => {
      log(`[dry-run] ${label} ${JSON.stringify(args)}`);
      return { id: `${label.replace(/\W+/g, "_")}_dry_run` } as unknown as T;
    };
  return {
    products: { list: (p) => stripe.products.list(p), create: stub("products.create") },
    prices: {
      list: (p) => stripe.prices.list(p),
      create: stub("prices.create"),
      update: stub("prices.update"),
    },
    billing: {
      meters: { list: (p) => stripe.billing.meters.list(p), create: stub("billing.meters.create") },
    },
    webhookEndpoints: {
      list: (p) => stripe.webhookEndpoints.list(p),
      create: stub("webhookEndpoints.create"),
      update: stub("webhookEndpoints.update"),
    },
    billingPortal: {
      configurations: {
        list: (p) => stripe.billingPortal.configurations.list(p),
        create: stub("billingPortal.configurations.create"),
        update: stub("billingPortal.configurations.update"),
      },
    },
  };
}
