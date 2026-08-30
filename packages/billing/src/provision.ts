import Stripe from "stripe";
import { PAID_PLANS, type PaidPlan, PLAN_LOOKUP_KEYS, PRODUCT_METADATA_KEY } from "./prices.js";

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

const PRODUCT_NAMES: Record<PaidPlan, string> = {
  pro: "MillionSend Pro",
  scale: "MillionSend Scale",
};

export interface ProvisionOptions {
  /** Monthly price per plan in cents (USD). */
  amounts: Record<PaidPlan, number>;
  /** Public URL of /api/billing/webhook; omitted = no endpoint (local `stripe listen`). */
  webhookUrl?: string | undefined;
  /** Create/refresh the customer-portal configuration referenced by STRIPE_PORTAL_CONFIG. */
  portal?: boolean | undefined;
  log?: ((line: string) => void) | undefined;
}

export interface ProvisionResult {
  products: Record<PaidPlan, string>;
  prices: Record<PaidPlan, string>;
  webhook?: { id: string; secret?: string | undefined } | undefined;
  portalConfiguration?: string | undefined;
}

/** Everything the API cannot do; printed after every run so nothing is forgotten. */
export const DASHBOARD_CHECKLIST = [
  "Stripe Tax: enable it and add the tax registrations for the jurisdictions you sell in (Settings → Tax).",
  "Business profile: legal name, support email/URL, and the statement descriptor shown on card statements (Settings → Public details).",
  "Branding: logo, icon, and colors used by Checkout, the customer portal, invoices, and emails (Settings → Branding).",
  "Customer emails: turn on successful-payment receipts and failed-payment notices (Settings → Emails).",
  "Live mode: repeat the provisioning with the live secret key; test and live objects are separate.",
] as const;

/** Cents from a dollar string such as "20" or "19.99"; rejects anything that is not a positive amount. */
export function usdToCents(value: string): number {
  const cents = Math.round(Number(value) * 100);
  if (!Number.isInteger(cents) || cents <= 0) throw new Error(`Invalid USD amount: ${value}`);
  return cents;
}

async function ensureProduct(
  stripe: ProvisionStripe,
  plan: PaidPlan,
  log: (line: string) => void,
): Promise<string> {
  const { data } = await stripe.products.list({ active: true, limit: 100 });
  const existing = data.find((p) => p.metadata[PRODUCT_METADATA_KEY] === plan);
  if (existing) {
    log(`product ${plan}: ${existing.id} (existing)`);
    return existing.id;
  }
  const created = await stripe.products.create({
    name: PRODUCT_NAMES[plan],
    metadata: { [PRODUCT_METADATA_KEY]: plan },
    tax_code: SAAS_BUSINESS_TAX_CODE,
  });
  log(`product ${plan}: ${created.id} (created)`);
  return created.id;
}

/**
 * Prices are immutable in Stripe, so an amount change creates a new price
 * and moves the lookup key onto it (transfer_lookup_key), then archives the
 * old one. Existing subscriptions keep their old price (identified by the
 * product's metadata thereafter); new checkouts pick up the new amount
 * immediately.
 */
async function ensurePrice(
  stripe: ProvisionStripe,
  plan: PaidPlan,
  product: string,
  unitAmount: number,
  log: (line: string) => void,
): Promise<string> {
  const lookupKey = PLAN_LOOKUP_KEYS[plan];
  const { data } = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 10 });
  const current = data.find((p) => p.lookup_key === lookupKey);
  const matches =
    current?.active &&
    current.unit_amount === unitAmount &&
    current.currency === "usd" &&
    current.recurring?.interval === "month";
  if (current && matches) {
    log(`price ${plan}: ${current.id} (existing, ${unitAmount} cents/month)`);
    return current.id;
  }
  const created = await stripe.prices.create({
    product,
    currency: "usd",
    unit_amount: unitAmount,
    recurring: { interval: "month" },
    lookup_key: lookupKey,
    transfer_lookup_key: true,
    tax_behavior: "exclusive",
  });
  if (current) {
    await stripe.prices.update(current.id, { active: false });
    log(`price ${plan}: ${created.id} (replaced ${current.id}, ${unitAmount} cents/month)`);
  } else {
    log(`price ${plan}: ${created.id} (created, ${unitAmount} cents/month)`);
  }
  return created.id;
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
      "webhook: Stripe only reveals the signing secret at creation. To rotate it, delete the endpoint in the dashboard and run again.",
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

function portalFeatures(
  products: Record<PaidPlan, string>,
  prices: Record<PaidPlan, string>,
): Stripe.BillingPortal.ConfigurationCreateParams.Features {
  return {
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    customer_update: { enabled: true, allowed_updates: ["email", "name", "address", "tax_id"] },
    subscription_cancel: { enabled: true, mode: "at_period_end" },
    subscription_update: {
      enabled: true,
      default_allowed_updates: ["price"],
      proration_behavior: "create_prorations",
      products: PAID_PLANS.map((plan) => ({ product: products[plan], prices: [prices[plan]] })),
    },
  };
}

/**
 * The portal must reference the CURRENT price ids, so an existing
 * configuration is always re-pointed after a price rotation.
 */
async function ensurePortal(
  stripe: ProvisionStripe,
  products: Record<PaidPlan, string>,
  prices: Record<PaidPlan, string>,
  log: (line: string) => void,
): Promise<string> {
  const features = portalFeatures(products, prices);
  const { data } = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
  const existing = data.find((c) => c.metadata?.millionsend === PORTAL_METADATA.millionsend);
  if (existing) {
    await stripe.billingPortal.configurations.update(existing.id, { features });
    log(`portal: ${existing.id} (existing, features refreshed)`);
    return existing.id;
  }
  const created = await stripe.billingPortal.configurations.create({
    features,
    metadata: PORTAL_METADATA,
  });
  log(`portal: ${created.id} (created)`);
  return created.id;
}

export async function provision(
  stripe: ProvisionStripe,
  options: ProvisionOptions,
): Promise<ProvisionResult> {
  const log = options.log ?? console.log;
  const products = {} as Record<PaidPlan, string>;
  const prices = {} as Record<PaidPlan, string>;
  for (const plan of PAID_PLANS) {
    products[plan] = await ensureProduct(stripe, plan, log);
    prices[plan] = await ensurePrice(stripe, plan, products[plan], options.amounts[plan], log);
  }
  const result: ProvisionResult = { products, prices };
  if (options.webhookUrl) result.webhook = await ensureWebhook(stripe, options.webhookUrl, log);
  if (options.portal) {
    result.portalConfiguration = await ensurePortal(stripe, products, prices, log);
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
