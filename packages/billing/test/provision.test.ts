import { PAID_RUNGS, rungByKey } from "@millionsend/core";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it } from "vitest";
import {
  METER_EVENT_NAME,
  overageLookupKey,
  PRODUCT_METADATA_KEY,
  priceMetadata,
  RUNG_METADATA_KEY,
} from "../src/prices.js";
import {
  dryRunStripe,
  PORTAL_METADATA,
  type ProvisionStripe,
  provision,
  SAAS_BUSINESS_TAX_CODE,
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
    meters: [] as Stripe.Billing.Meter[],
    webhooks: [] as Stripe.WebhookEndpoint[],
    portals: [] as Stripe.BillingPortal.Configuration[],
    calls: [] as string[],
  };
  let seq = 0;
  const id = (prefix: string) => `${prefix}_${++seq}`;
  // biome-ignore lint/suspicious/noExplicitAny: fake objects are cast at the edge
  const row = <T>(data: any): T => data as T;
  /** A pre-existing licensed price, as an account provisioned earlier would hold it. */
  const seedPrice = (data: Partial<Stripe.Price>): Stripe.Price => {
    const price = row<Stripe.Price>({
      id: id("price"),
      active: true,
      currency: "usd",
      metadata: {},
      recurring: { interval: "month", usage_type: "licensed", meter: null },
      transform_quantity: null,
      ...data,
    });
    state.prices.push(price);
    return price;
  };

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
          recurring: p.recurring
            ? {
                interval: p.recurring.interval,
                usage_type: p.recurring.usage_type ?? "licensed",
                meter: p.recurring.meter ?? null,
              }
            : null,
          transform_quantity: p.transform_quantity ?? null,
          lookup_key: p.lookup_key ?? null,
          tax_behavior: p.tax_behavior ?? null,
          metadata: p.metadata ?? {},
        });
        state.prices.push(price);
        return price;
      },
      async update(priceId, p) {
        state.calls.push(`prices.update ${priceId}`);
        const price = state.prices.find((x) => x.id === priceId);
        if (!price) throw new Error(`no price ${priceId}`);
        if (p.active !== undefined) price.active = p.active;
        if (p.metadata) price.metadata = p.metadata as Record<string, string>;
        return price;
      },
    },
    billing: {
      meters: {
        async list() {
          state.calls.push("billing.meters.list");
          return list(state.meters);
        },
        async create(p) {
          state.calls.push("billing.meters.create");
          const meter = row<Stripe.Billing.Meter>({
            id: id("mtr"),
            status: "active",
            event_name: p.event_name,
            display_name: p.display_name,
          });
          state.meters.push(meter);
          return meter;
        },
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
  return { stripe, state, seedPrice };
}

const MONTHLY_RUNGS = PAID_RUNGS.filter((r) => r.overageCentsPer1k !== null);
const URL = "https://app.example.com/api/billing/webhook";
let log: string[];
const opts = (extra: Record<string, unknown> = {}) => ({
  webhookUrl: URL,
  portal: true,
  log: (line: string) => log.push(line),
  ...extra,
});

beforeEach(() => {
  log = [];
});

describe("provision", () => {
  it("creates products, the meter, a price per rung, webhook, and portal on a fresh account", async () => {
    const { stripe, state } = fakeStripe();
    const result = await provision(stripe, opts());

    expect(state.products.map((p) => [p.metadata[PRODUCT_METADATA_KEY], p.tax_code])).toEqual([
      ["starter", SAAS_BUSINESS_TAX_CODE],
      ["pro", SAAS_BUSINESS_TAX_CODE],
      ["scale", SAAS_BUSINESS_TAX_CODE],
    ]);
    expect(state.meters.map((m) => [m.id, m.event_name])).toEqual([
      [result.meter, METER_EVENT_NAME],
    ]);

    expect(state.prices).toHaveLength(PAID_RUNGS.length + MONTHLY_RUNGS.length);
    for (const price of state.prices) {
      expect(price.tax_behavior).toBe("exclusive");
      expect(price.currency).toBe("usd");
      expect(price.recurring?.interval).toBe("month");
    }
    for (const rung of PAID_RUNGS) {
      expect(state.prices.find((p) => p.id === result.prices[rung.key])).toMatchObject({
        active: true,
        lookup_key: `millionsend_${rung.key}_monthly`,
        unit_amount: rung.priceCents,
        product: result.products[rung.plan],
        recurring: { usage_type: "licensed", meter: null },
        transform_quantity: null,
        metadata: { [RUNG_METADATA_KEY]: rung.key },
      });
      if (rung.overageCentsPer1k === null) {
        expect(result.overagePrices[rung.key]).toBeUndefined();
        continue;
      }
      expect(state.prices.find((p) => p.id === result.overagePrices[rung.key])).toMatchObject({
        active: true,
        lookup_key: `millionsend_${rung.key}_overage`,
        unit_amount: rung.overageCentsPer1k,
        product: result.products[rung.plan],
        recurring: { usage_type: "metered", meter: result.meter },
        transform_quantity: { divide_by: 1000, round: "up" },
        metadata: { [RUNG_METADATA_KEY]: rung.key },
      });
    }

    const [webhook] = state.webhooks;
    expect(webhook?.url).toBe(URL);
    expect([...(webhook?.enabled_events ?? [])].sort()).toEqual([...WEBHOOK_EVENTS].sort());
    expect(webhook?.api_version).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(result.webhook?.secret).toMatch(/^whsec_/);
    expect(log).toContain(`webhook: STRIPE_WEBHOOK_SECRET=${result.webhook?.secret}`);

    const [portal] = state.portals;
    expect(portal?.metadata).toEqual(PORTAL_METADATA);
    expect(result.portalConfiguration).toBe(portal?.id);
    expect(portal?.features.subscription_update.enabled).toBe(false);
    expect(portal?.features.subscription_cancel.mode).toBe("at_period_end");
    expect(log.some((l) => l.startsWith("Dashboard-only steps"))).toBe(true);
  });

  it("is idempotent: a second identical run writes nothing new", async () => {
    const { stripe, state } = fakeStripe();
    const first = await provision(stripe, opts());
    state.calls.length = 0;
    log.length = 0;

    const second = await provision(stripe, opts());

    expect(second).toMatchObject({
      products: first.products,
      prices: first.prices,
      overagePrices: first.overagePrices,
      meter: first.meter,
      webhook: { id: first.webhook?.id },
      portalConfiguration: first.portalConfiguration,
    });
    expect(state.calls.filter((c) => c.includes("create"))).toEqual([]);
    expect(state.calls.filter((c) => c.startsWith("prices.update"))).toEqual([]);
    expect(state.calls.filter((c) => c.startsWith("webhookEndpoints.update"))).toEqual([]);
    expect(log.some((l) => l.includes("cannot be read back"))).toBe(false);
    expect(log.some((l) => l.includes("only reveals the signing secret at creation"))).toBe(true);
  });

  it("rotates a price when the amount changes: new price takes the lookup key, old one is archived", async () => {
    const { stripe, state } = fakeStripe();
    const first = await provision(stripe, opts());
    const old = state.prices.find((p) => p.id === first.prices.pro_100k);
    if (!old) throw new Error("no pro_100k price");
    // The account holds yesterday's amount; the ladder moved on.
    old.unit_amount = 1500;

    const second = await provision(stripe, opts());

    expect(second.prices.pro_100k).not.toBe(first.prices.pro_100k);
    expect({ ...second.prices, pro_100k: first.prices.pro_100k }).toEqual(first.prices);
    expect(second.overagePrices).toEqual(first.overagePrices);
    expect(old).toMatchObject({ active: false, lookup_key: null });
    expect(state.prices.find((p) => p.id === second.prices.pro_100k)).toMatchObject({
      active: true,
      lookup_key: "millionsend_pro_100k_monthly",
      unit_amount: rungByKey("pro_100k").priceCents,
      product: first.products.pro,
      metadata: priceMetadata(rungByKey("pro_100k")),
    });
  });

  it("refreshes stale price metadata in place", async () => {
    const { stripe, state } = fakeStripe();
    const first = await provision(stripe, opts());
    const price = state.prices.find((p) => p.id === first.overagePrices.scale_1m);
    if (!price) throw new Error("no scale_1m overage price");
    price.metadata = { [RUNG_METADATA_KEY]: "scale_1m" };
    state.calls.length = 0;

    const second = await provision(stripe, opts());

    expect(second.overagePrices.scale_1m).toBe(first.overagePrices.scale_1m);
    expect(price.metadata).toEqual(priceMetadata(rungByKey("scale_1m")));
    expect(state.calls.filter((c) => c.startsWith("prices."))).toEqual(
      expect.arrayContaining([`prices.update ${price.id}`]),
    );
    expect(state.calls.filter((c) => c.includes("create"))).toEqual([]);
    expect(log).toContain(
      `price ${overageLookupKey(rungByKey("scale_1m"))}: ${price.id} (existing, 20 cents per 1,000 over quota, metadata refreshed)`,
    );
  });

  it("archives the pre-ladder prices but leaves their lookup keys in place", async () => {
    const { stripe, state, seedPrice } = fakeStripe();
    const pro = seedPrice({ lookup_key: "millionsend_pro_monthly", unit_amount: 2000 });
    const scale = seedPrice({ lookup_key: "millionsend_scale_monthly", unit_amount: 10_000 });

    await provision(stripe, opts({ portal: false }));
    expect(pro).toMatchObject({ active: false, lookup_key: "millionsend_pro_monthly" });
    expect(scale).toMatchObject({ active: false, lookup_key: "millionsend_scale_monthly" });
    expect(log).toContain(`price millionsend_pro_monthly: ${pro.id} (archived)`);
    // Both keys still resolve to a price, so subscriptions on them keep their rung.
    expect(state.prices.filter((p) => p.lookup_key?.endsWith("_monthly"))).toHaveLength(
      PAID_RUNGS.length + 2,
    );

    state.calls.length = 0;
    await provision(stripe, opts({ portal: false }));
    expect(state.calls.filter((c) => c.startsWith("prices.update"))).toEqual([]);
    expect(log).toContain(`price millionsend_scale_monthly: ${scale.id} (already archived)`);
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
    expect(state.meters).toEqual([]);
    expect(state.prices).toEqual([]);
    expect(state.webhooks).toEqual([]);
    expect(state.portals).toEqual([]);
    // 3 products, the meter, a plan price per paid rung, an overage price per monthly rung, webhook, portal.
    expect(lines.filter((l) => l.startsWith("[dry-run] "))).toHaveLength(
      3 + 1 + PAID_RUNGS.length + MONTHLY_RUNGS.length + 2,
    );
    expect(state.calls.filter((c) => c.includes("create"))).toEqual([]);
  });
});
