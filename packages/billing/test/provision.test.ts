import type Stripe from "stripe";
import { beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_METADATA_KEY } from "../src/prices.js";
import {
  dryRunStripe,
  PORTAL_METADATA,
  type ProvisionStripe,
  provision,
  SAAS_BUSINESS_TAX_CODE,
  usdToCents,
  WEBHOOK_EVENTS,
} from "../src/provision.js";

function list<T>(data: T[]): Stripe.ApiList<T> {
  return { object: "list", data, has_more: false, url: "" };
}

/** In-memory Stripe: enough state to make find-or-create observable across runs. */
function fakeStripe() {
  const state = {
    products: [] as Stripe.Product[],
    prices: [] as Stripe.Price[],
    webhooks: [] as Stripe.WebhookEndpoint[],
    portals: [] as Stripe.BillingPortal.Configuration[],
    calls: [] as string[],
  };
  let seq = 0;
  const id = (prefix: string) => `${prefix}_${++seq}`;
  // biome-ignore lint/suspicious/noExplicitAny: fake objects are cast at the edge
  const row = <T>(data: any): T => data as T;

  const stripe: ProvisionStripe = {
    products: {
      async list() {
        state.calls.push("products.list");
        return list(state.products.filter((p) => p.active));
      },
      async create(p) {
        state.calls.push("products.create");
        const product = row<Stripe.Product>({
          id: id("prod"),
          active: true,
          name: p.name,
          metadata: p.metadata ?? {},
          tax_code: p.tax_code ?? null,
        });
        state.products.push(product);
        return product;
      },
    },
    prices: {
      async list(p) {
        state.calls.push("prices.list");
        const keys = p.lookup_keys ?? [];
        return list(state.prices.filter((x) => keys.includes(x.lookup_key ?? "")));
      },
      async create(p) {
        state.calls.push("prices.create");
        if (p.transfer_lookup_key) {
          for (const x of state.prices) if (x.lookup_key === p.lookup_key) x.lookup_key = null;
        } else if (state.prices.some((x) => x.lookup_key === p.lookup_key)) {
          throw new Error("lookup_key already in use");
        }
        const price = row<Stripe.Price>({
          id: id("price"),
          active: true,
          product: p.product,
          currency: p.currency,
          unit_amount: p.unit_amount ?? null,
          recurring: p.recurring ?? null,
          lookup_key: p.lookup_key ?? null,
          tax_behavior: p.tax_behavior ?? null,
        });
        state.prices.push(price);
        return price;
      },
      async update(priceId, p) {
        state.calls.push(`prices.update ${priceId}`);
        const price = state.prices.find((x) => x.id === priceId);
        if (!price) throw new Error(`no price ${priceId}`);
        if (p.active !== undefined) price.active = p.active;
        return price;
      },
    },
    webhookEndpoints: {
      async list() {
        state.calls.push("webhookEndpoints.list");
        // Secrets are only returned at creation.
        return list(
          state.webhooks.map((w) => row<Stripe.WebhookEndpoint>({ ...w, secret: undefined })),
        );
      },
      async create(p) {
        state.calls.push("webhookEndpoints.create");
        const webhook = row<Stripe.WebhookEndpoint>({
          id: id("we"),
          url: p.url,
          enabled_events: [...p.enabled_events],
          api_version: p.api_version ?? null,
          secret: `whsec_${seq}`,
        });
        state.webhooks.push(webhook);
        return webhook;
      },
      async update(webhookId, p) {
        state.calls.push(`webhookEndpoints.update ${webhookId}`);
        const webhook = state.webhooks.find((w) => w.id === webhookId);
        if (!webhook) throw new Error(`no webhook ${webhookId}`);
        if (p.enabled_events) webhook.enabled_events = [...p.enabled_events];
        return webhook;
      },
    },
    billingPortal: {
      configurations: {
        async list() {
          state.calls.push("portal.list");
          return list(state.portals);
        },
        async create(p) {
          state.calls.push("portal.create");
          const config = row<Stripe.BillingPortal.Configuration>({
            id: id("bpc"),
            active: true,
            metadata: p.metadata ?? {},
            features: p.features,
          });
          state.portals.push(config);
          return config;
        },
        async update(configId, p) {
          state.calls.push(`portal.update ${configId}`);
          const config = state.portals.find((c) => c.id === configId);
          if (!config) throw new Error(`no portal config ${configId}`);
          if (p.features)
            config.features = p.features as unknown as Stripe.BillingPortal.Configuration.Features;
          return config;
        },
      },
    },
  };
  return { stripe, state };
}

const AMOUNTS = { pro: 2000, scale: 10_000 };
const URL = "https://app.example.com/api/billing/webhook";
let log: string[];
const opts = (extra: Record<string, unknown> = {}) => ({
  amounts: AMOUNTS,
  webhookUrl: URL,
  portal: true,
  log: (line: string) => log.push(line),
  ...extra,
});

beforeEach(() => {
  log = [];
});

describe("provision", () => {
  it("creates products, prices, webhook, and portal on a fresh account", async () => {
    const { stripe, state } = fakeStripe();
    const result = await provision(stripe, opts());

    expect(state.products.map((p) => [p.metadata[PRODUCT_METADATA_KEY], p.tax_code])).toEqual([
      ["pro", SAAS_BUSINESS_TAX_CODE],
      ["scale", SAAS_BUSINESS_TAX_CODE],
    ]);
    expect(state.prices).toHaveLength(2);
    for (const price of state.prices) {
      expect(price.tax_behavior).toBe("exclusive");
      expect(price.currency).toBe("usd");
      expect(price.recurring?.interval).toBe("month");
    }
    expect(state.prices.map((p) => [p.lookup_key, p.unit_amount])).toEqual([
      ["millionsend_pro_monthly", 2000],
      ["millionsend_scale_monthly", 10_000],
    ]);
    expect(result.prices).toEqual({ pro: state.prices[0]?.id, scale: state.prices[1]?.id });

    const [webhook] = state.webhooks;
    expect(webhook?.url).toBe(URL);
    expect([...(webhook?.enabled_events ?? [])].sort()).toEqual([...WEBHOOK_EVENTS].sort());
    expect(webhook?.api_version).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(result.webhook?.secret).toBe("whsec_5");
    expect(log).toContain("webhook: STRIPE_WEBHOOK_SECRET=whsec_5");

    const [portal] = state.portals;
    expect(portal?.metadata).toEqual(PORTAL_METADATA);
    expect(result.portalConfiguration).toBe(portal?.id);
    const update = portal?.features.subscription_update;
    expect(update?.enabled).toBe(true);
    expect(update?.products?.map((p) => p.prices)).toEqual([
      [result.prices.pro],
      [result.prices.scale],
    ]);
    expect(portal?.features.subscription_cancel.mode).toBe("at_period_end");
    expect(log.some((l) => l.startsWith("Dashboard-only steps"))).toBe(true);
  });

  it("is idempotent: a second identical run writes nothing new", async () => {
    const { stripe, state } = fakeStripe();
    const first = await provision(stripe, opts());
    state.calls.length = 0;
    log.length = 0;

    const second = await provision(stripe, opts());

    expect(second.products).toEqual(first.products);
    expect(second.prices).toEqual(first.prices);
    expect(second.webhook).toEqual({ id: first.webhook?.id });
    expect(second.portalConfiguration).toBe(first.portalConfiguration);
    expect(state.calls.filter((c) => c.includes("create"))).toEqual([]);
    expect(state.calls.filter((c) => c.startsWith("prices.update"))).toEqual([]);
    expect(state.calls.filter((c) => c.startsWith("webhookEndpoints.update"))).toEqual([]);
    expect(log.some((l) => l.includes("cannot be read back"))).toBe(false);
    expect(log.some((l) => l.includes("only reveals the signing secret at creation"))).toBe(true);
  });

  it("rotates a price when the amount changes: new price takes the lookup key, old one is archived", async () => {
    const { stripe, state } = fakeStripe();
    const first = await provision(stripe, opts());

    const second = await provision(stripe, opts({ amounts: { pro: 2500, scale: 10_000 } }));

    expect(second.prices.scale).toBe(first.prices.scale);
    expect(second.prices.pro).not.toBe(first.prices.pro);
    const old = state.prices.find((p) => p.id === first.prices.pro);
    const fresh = state.prices.find((p) => p.id === second.prices.pro);
    expect(old?.active).toBe(false);
    expect(old?.lookup_key).toBeNull();
    expect(fresh).toMatchObject({
      active: true,
      lookup_key: "millionsend_pro_monthly",
      unit_amount: 2500,
      product: first.products.pro,
    });
    // The portal must offer the current price, not the archived one.
    const portalPrices = state.portals[0]?.features.subscription_update.products?.map(
      (p) => p.prices,
    );
    expect(portalPrices).toEqual([[second.prices.pro], [second.prices.scale]]);
  });

  it("re-syncs a webhook endpoint whose events drifted", async () => {
    const { stripe, state } = fakeStripe();
    await provision(stripe, opts({ portal: false }));
    const webhook = state.webhooks[0];
    if (!webhook) throw new Error("no webhook");
    webhook.enabled_events = ["invoice.paid", "charge.succeeded"];

    const result = await provision(stripe, opts({ portal: false }));

    expect(result.webhook).toEqual({ id: webhook.id });
    expect([...webhook.enabled_events].sort()).toEqual([...WEBHOOK_EVENTS].sort());
    expect(state.webhooks).toHaveLength(1);
  });

  it("skips the webhook and portal when not requested", async () => {
    const { stripe, state } = fakeStripe();
    const result = await provision(stripe, opts({ webhookUrl: undefined, portal: false }));
    expect(result.webhook).toBeUndefined();
    expect(result.portalConfiguration).toBeUndefined();
    expect(state.webhooks).toEqual([]);
    expect(state.portals).toEqual([]);
  });

  it("dry run reads but never writes", async () => {
    const { stripe, state } = fakeStripe();
    const lines: string[] = [];
    await provision(
      dryRunStripe(stripe, (l) => lines.push(l)),
      opts(),
    );
    expect(state.products).toEqual([]);
    expect(state.prices).toEqual([]);
    expect(state.webhooks).toEqual([]);
    expect(state.portals).toEqual([]);
    expect(lines.filter((l) => l.startsWith("[dry-run] "))).toHaveLength(6);
    expect(state.calls.filter((c) => c.includes("create"))).toEqual([]);
  });
});

describe("usdToCents", () => {
  it("converts dollars and rejects non-amounts", () => {
    expect(usdToCents("20")).toBe(2000);
    expect(usdToCents("19.99")).toBe(1999);
    for (const bad of ["0", "-5", "abc", ""]) expect(() => usdToCents(bad)).toThrow();
  });
});
