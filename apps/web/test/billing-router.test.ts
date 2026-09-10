import type { BillingStripe } from "@millionsend/billing";
import {
  DAY_MS,
  PLAN_RUNGS,
  type PlanRungKey,
  rungByKey,
  type SystemMailMessage,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamRole } from "@/server/membership";
import { createBillingRouter } from "@/server/routers/billing";
import { createCallerFactory, router } from "@/server/trpc";

const h = vi.hoisted(() => ({
  runCronNow: vi.fn(async (_name: string) => {}),
  sent: [] as SystemMailMessage[],
}));
vi.mock("@/server/queue", () => ({ getQueue: async () => ({ runCronNow: h.runCronNow }) }));
vi.mock("@/server/system-mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/system-mail")>();
  return { ...actual, sendAccountMail: (m: SystemMailMessage) => void h.sent.push(m) };
});

let db: Db;
let close: () => Promise<void>;
let calls: {
  customers: Stripe.CustomerCreateParams[];
  checkouts: Stripe.Checkout.SessionCreateParams[];
  checkoutOptions: (Stripe.RequestOptions | undefined)[];
  portals: Stripe.BillingPortal.SessionCreateParams[];
  updates: Stripe.SubscriptionUpdateParams[];
  itemCreates: Stripe.SubscriptionItemCreateParams[];
  itemDeletes: string[];
};
let onCustomerCreate: (() => Promise<void>) | undefined;

const PERIOD_START = new Date(Date.now() - 10 * DAY_MS);
const PERIOD_END = new Date(Date.now() + 20 * DAY_MS);

/** A ladder price as Stripe returns it; the rung is read back off the metadata. */
function price(key: PlanRungKey, metered = false): Stripe.Price {
  return {
    id: `price_${key}${metered ? "_overage" : ""}`,
    lookup_key: `millionsend_${key}_${metered ? "overage" : "monthly"}`,
    metadata: { millionsend_rung: key },
    recurring: { usage_type: metered ? "metered" : "licensed" },
    product: "prod_x",
  } as unknown as Stripe.Price;
}
const PRICES = PLAN_RUNGS.filter((r) => r.priceCents > 0).flatMap((r) => [
  price(r.key),
  ...(r.period === "month" ? [price(r.key, true)] : []),
]);
function priceById(id: string): Stripe.Price {
  const found = PRICES.find((p) => p.id === id);
  if (!found) throw new Error(`no price ${id}`);
  return found;
}

function item(id: string, p: Stripe.Price): Stripe.SubscriptionItem {
  return {
    id,
    price: p,
    current_period_start: Math.floor(PERIOD_START.getTime() / 1000),
    current_period_end: Math.floor(PERIOD_END.getTime() / 1000),
  } as unknown as Stripe.SubscriptionItem;
}
function subscription(items: Stripe.SubscriptionItem[]): Stripe.Subscription {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    cancel_at: null,
    items: { data: items },
  } as unknown as Stripe.Subscription;
}
/** The one subscription the fake Stripe holds; item changes rewrite it like Stripe would. */
let sub: Stripe.Subscription;

const stripe = {
  prices: {
    list: async ({ lookup_keys }: Stripe.PriceListParams) => ({
      data: PRICES.filter((p) => lookup_keys?.includes(p.lookup_key ?? "")),
    }),
  },
  customers: {
    create: async (params: Stripe.CustomerCreateParams) => {
      calls.customers.push(params);
      await onCustomerCreate?.();
      return { id: "cus_new" };
    },
  },
  subscriptions: {
    retrieve: async () => sub,
    update: async (_id: string, params: Stripe.SubscriptionUpdateParams) => {
      calls.updates.push(params);
      const kept = sub.items.data.filter(
        (i) => !params.items?.some((u) => u.id === i.id && u.deleted),
      );
      for (const u of params.items ?? []) {
        const existing = kept.find((i) => i.id === u.id);
        if (existing && u.price) existing.price = priceById(u.price);
      }
      sub = subscription(kept);
      return sub;
    },
  },
  subscriptionItems: {
    create: async (params: Stripe.SubscriptionItemCreateParams) => {
      calls.itemCreates.push(params);
      const created = item("si_overage", priceById(params.price ?? ""));
      sub = subscription([...sub.items.data, created]);
      return created;
    },
    del: async (id: string) => {
      calls.itemDeletes.push(id);
      sub = subscription(sub.items.data.filter((i) => i.id !== id));
      return { id, deleted: true };
    },
  },
  billing: { meterEvents: { create: async () => ({}) } },
  checkout: {
    sessions: {
      create: async (
        params: Stripe.Checkout.SessionCreateParams,
        options?: Stripe.RequestOptions,
      ) => {
        calls.checkouts.push(params);
        calls.checkoutOptions.push(options);
        return { url: "https://checkout.stripe.com/c/cs_1" };
      },
    },
  },
  billingPortal: {
    sessions: {
      create: async (params: Stripe.BillingPortal.SessionCreateParams) => {
        calls.portals.push(params);
        return { url: "https://billing.stripe.com/p/1" };
      },
    },
  },
} as unknown as BillingStripe;

const createCaller = createCallerFactory(
  router({ billing: createBillingRouter({ stripe: () => stripe }) }),
);

function callerFor(teamId: string, role: TeamRole) {
  return createCaller({
    db,
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId,
    role,
  });
}

/** A team mid-period on `key`, with the matching subscription in the fake Stripe. */
async function subscribedTeam(key: PlanRungKey, overage = false): Promise<string> {
  const teamId = await createTeam(db);
  const rung = rungByKey(key);
  sub = subscription([
    item("si_base", price(key)),
    ...(overage ? [item("si_overage", price(key, true))] : []),
  ]);
  await db
    .update(schema.teams)
    .set({
      plan: rung.plan,
      planQuota: rung.period === "month" ? rung.included : null,
      planStatus: "active",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      stripeOverageItemId: overage ? "si_overage" : null,
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
    })
    .where(eq(schema.teams.id, teamId));
  return teamId;
}

async function teamRow(teamId: string) {
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  return team;
}

const auditRows = () =>
  db.select({ action: schema.auditLog.action, data: schema.auditLog.data }).from(schema.auditLog);

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  calls = {
    customers: [],
    checkouts: [],
    checkoutOptions: [],
    portals: [],
    updates: [],
    itemCreates: [],
    itemDeletes: [],
  };
  onCustomerCreate = undefined;
  vi.stubEnv("IS_CLOUD", "true");
  vi.stubEnv("APP_BASE_URL", "https://app.example.com");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  h.runCronNow.mockClear();
  h.sent = [];
  await close();
});

describe("billing router", () => {
  it("does not exist on self-host", async () => {
    vi.stubEnv("IS_CLOUD", "");
    const teamId = await createTeam(db);
    const owner = callerFor(teamId, "owner");
    await expect(owner.billing.status()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(owner.billing.checkout({ rung: "pro_100k" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(owner.billing.changePlan({ rung: "pro_100k" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(owner.billing.setOverage({ enabled: true })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(owner.billing.portal()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.checkouts).toEqual([]);
  });

  it("status reports the entitlement to any member", async () => {
    const teamId = await createTeam(db);
    expect(await callerFor(teamId, "member").billing.status()).toEqual({
      plan: "free",
      planQuota: null,
      rung: "free",
      planStatus: "none",
      currentPeriodEnd: null,
      quota: { kind: "day", plan: "free", limit: 100 },
      usage: { accepted: 0, reportedOverage: 0 },
      hasCustomer: false,
      hasLiveSubscription: false,
    });
  });

  it("status counts a monthly plan against its billing period", async () => {
    const teamId = await subscribedTeam("pro_200k", true);
    await db
      .insert(schema.usagePeriods)
      .values({ teamId, periodStart: PERIOD_START, accepted: 1234, reportedOverage: 0 });
    expect(await callerFor(teamId, "member").billing.status()).toMatchObject({
      plan: "pro",
      planQuota: 200_000,
      rung: "pro_200k",
      planStatus: "active",
      currentPeriodEnd: PERIOD_END,
      quota: {
        kind: "month",
        plan: "pro",
        included: 200_000,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        overage: true,
        overageCentsPer1k: 30,
      },
      usage: { accepted: 1234, reportedOverage: 0 },
      hasCustomer: true,
      hasLiveSubscription: true,
    });
  });

  it("checkout, plan changes, overage and the portal are owner/admin only", async () => {
    const teamId = await createTeam(db);
    const member = callerFor(teamId, "member");
    await expect(member.billing.checkout({ rung: "pro_100k" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(member.billing.changePlan({ rung: "pro_100k" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(member.billing.setOverage({ enabled: true })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(member.billing.portal()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("checkout creates the customer once, stores it, and sells the rung's price", async () => {
    const teamId = await createTeam(db, "acme");
    const admin = callerFor(teamId, "admin");
    expect(await admin.billing.checkout({ rung: "scale_1m" })).toEqual({
      url: "https://checkout.stripe.com/c/cs_1",
    });
    expect(calls.customers).toEqual([
      { name: "acme", email: "u1@example.com", metadata: { team_id: teamId } },
    ]);
    expect(calls.checkouts[0]).toMatchObject({
      mode: "subscription",
      customer: "cus_new",
      client_reference_id: teamId,
      line_items: [{ price: "price_scale_1m", quantity: 1 }],
      success_url: "https://app.example.com/settings/billing?checkout=success",
      cancel_url: "https://app.example.com/settings/billing",
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      allow_promotion_codes: true,
      billing_address_collection: "auto",
    });
    expect(calls.checkoutOptions[0]?.idempotencyKey).toMatch(
      new RegExp(`^checkout:${teamId}:scale_1m:\\d+$`),
    );
    expect(await teamRow(teamId)).toMatchObject({
      stripeCustomerId: "cus_new",
      plan: "free",
      planStatus: "none",
    });
    expect(await auditRows()).toEqual([
      { action: "billing.checkout_started", data: { rung: "scale_1m" } },
    ]);

    // Abandoned checkouts (no subscription yet) may be retried freely.
    await admin.billing.checkout({ rung: "pro_100k" });
    expect(calls.customers).toHaveLength(1);
    expect(calls.checkouts[1]).toMatchObject({
      customer: "cus_new",
      line_items: [{ price: "price_pro_100k", quantity: 1 }],
    });
  });

  it("checkout refuses the free rung: Free is reached by cancelling", async () => {
    const teamId = await createTeam(db);
    await expect(callerFor(teamId, "owner").billing.checkout({ rung: "free" })).rejects.toThrow();
    expect(calls.checkouts).toEqual([]);
  });

  it("checkout keeps the customer a concurrent request linked first", async () => {
    const teamId = await createTeam(db);
    onCustomerCreate = async () => {
      await db
        .update(schema.teams)
        .set({ stripeCustomerId: "cus_first" })
        .where(eq(schema.teams.id, teamId));
    };
    await callerFor(teamId, "owner").billing.checkout({ rung: "pro_100k" });
    expect(calls.checkouts[0]).toMatchObject({ customer: "cus_first" });
    expect((await teamRow(teamId))?.stripeCustomerId).toBe("cus_first");
  });

  it("checkout is refused while a subscription is live; status says so", async () => {
    const teamId = await createTeam(db);
    const owner = callerFor(teamId, "owner");
    for (const planStatus of ["active", "trialing", "past_due", "unpaid"] as const) {
      await db
        .update(schema.teams)
        .set({ stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", planStatus })
        .where(eq(schema.teams.id, teamId));
      expect((await owner.billing.status()).hasLiveSubscription).toBe(true);
      await expect(owner.billing.checkout({ rung: "scale_500k" })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
    }
    expect(calls.checkouts).toEqual([]);

    await db
      .update(schema.teams)
      .set({ planStatus: "canceled" })
      .where(eq(schema.teams.id, teamId));
    expect((await owner.billing.status()).hasLiveSubscription).toBe(false);
    expect(await owner.billing.checkout({ rung: "scale_500k" })).toEqual({
      url: "https://checkout.stripe.com/c/cs_1",
    });
  });

  it("changePlan moves the live subscription to the rung with prorations and drains on a raise", async () => {
    const teamId = await subscribedTeam("pro_100k");
    const owner = callerFor(teamId, "owner");
    await owner.billing.changePlan({ rung: "scale_500k" });
    expect(calls.updates).toEqual([
      {
        items: [{ id: "si_base", price: "price_scale_500k" }],
        proration_behavior: "create_prorations",
      },
    ]);
    expect(await teamRow(teamId)).toMatchObject({
      plan: "scale",
      planQuota: 500_000,
      stripeOverageItemId: null,
    });
    expect(h.runCronNow).toHaveBeenCalledWith("quota.drain");
    expect(await auditRows()).toEqual([
      { action: "billing.plan_changed", data: { rung: "scale_500k" } },
    ]);

    // A move down leaves the schedule alone.
    h.runCronNow.mockClear();
    await owner.billing.changePlan({ rung: "pro_100k" });
    expect((await teamRow(teamId))?.planQuota).toBe(100_000);
    expect(h.runCronNow).not.toHaveBeenCalled();
  });

  it("changePlan keeps the metered item in step: re-priced for a monthly rung, dropped for a daily one", async () => {
    const teamId = await subscribedTeam("pro_100k", true);
    const owner = callerFor(teamId, "owner");
    await owner.billing.changePlan({ rung: "pro_200k" });
    expect(calls.updates[0]?.items).toEqual([
      { id: "si_base", price: "price_pro_200k" },
      { id: "si_overage", price: "price_pro_200k_overage" },
    ]);
    expect(await teamRow(teamId)).toMatchObject({
      plan: "pro",
      planQuota: 200_000,
      stripeOverageItemId: "si_overage",
    });

    await owner.billing.changePlan({ rung: "starter" });
    expect(calls.updates[1]?.items).toEqual([
      { id: "si_base", price: "price_starter" },
      { id: "si_overage", deleted: true },
    ]);
    expect(await teamRow(teamId)).toMatchObject({
      plan: "starter",
      planQuota: null,
      stripeOverageItemId: null,
    });
  });

  it("changePlan tells the owners about a move once per period, keyed like the webhook's own report", async () => {
    vi.stubEnv("NOTIFICATIONS_EMAIL_FROM", "MillionSend <notices@mail.example.com>");
    const teamId = await subscribedTeam("pro_100k");
    await db.insert(schema.user).values({ id: "ada", name: "Ada", email: "ada@example.com" });
    await db.insert(schema.teamMembers).values({ teamId, userId: "ada", role: "owner" });
    const owner = callerFor(teamId, "owner");
    await owner.billing.changePlan({ rung: "scale_500k" });
    expect(h.sent.map((m) => [m.kind, m.to, m.subject])).toEqual([
      ["billing.plan_changed", "ada@example.com", "acme moved from Pro 100k to Scale 500k"],
    ]);
    expect(h.sent[0]?.from).toBe("MillionSend <notices@mail.example.com>");
    expect(h.sent[0]?.text).toContain("https://app.example.com/settings/billing");
    // Keyed by the period end as the row holds it (Stripe stamps whole seconds).
    const periodEnd = (await teamRow(teamId))?.currentPeriodEnd?.toISOString();
    expect(
      await db
        .select({ kind: schema.teamNotifications.kind, key: schema.teamNotifications.periodKey })
        .from(schema.teamNotifications),
    ).toEqual([{ kind: "billing.plan_changed", key: `pro_100k>scale_500k:${periodEnd}` }]);

    // Back and forth inside one period: the return trip is news, the same move again is not.
    await owner.billing.changePlan({ rung: "pro_100k" });
    await owner.billing.changePlan({ rung: "scale_500k" });
    expect(h.sent.map((m) => m.subject)).toEqual([
      "acme moved from Pro 100k to Scale 500k",
      "acme moved from Scale 500k to Pro 100k",
    ]);
  });

  it("changePlan needs a live subscription", async () => {
    const teamId = await createTeam(db);
    await expect(
      callerFor(teamId, "owner").billing.changePlan({ rung: "pro_100k" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(calls.updates).toEqual([]);
  });

  it("setOverage adds the rung's metered item and removes it again", async () => {
    const teamId = await subscribedTeam("pro_100k");
    const owner = callerFor(teamId, "owner");
    await owner.billing.setOverage({ enabled: true });
    expect(calls.itemCreates).toEqual([{ subscription: "sub_1", price: "price_pro_100k_overage" }]);
    expect((await teamRow(teamId))?.stripeOverageItemId).toBe("si_overage");
    expect((await owner.billing.status()).quota).toMatchObject({ kind: "month", overage: true });
    // Overage lets parked broadcast mail through: drained at once.
    expect(h.runCronNow).toHaveBeenCalledWith("quota.drain");

    h.runCronNow.mockClear();
    await owner.billing.setOverage({ enabled: false });
    expect(calls.itemDeletes).toEqual(["si_overage"]);
    expect((await teamRow(teamId))?.stripeOverageItemId).toBeNull();
    expect((await owner.billing.status()).quota).toMatchObject({ kind: "month", overage: false });
    expect(h.runCronNow).not.toHaveBeenCalled();
    expect(await auditRows()).toEqual([
      { action: "billing.overage_toggled", data: { enabled: true } },
      { action: "billing.overage_toggled", data: { enabled: false } },
    ]);
  });

  it("setOverage is refused on a daily plan and without a live subscription", async () => {
    const daily = await subscribedTeam("starter");
    await expect(
      callerFor(daily, "owner").billing.setOverage({ enabled: true }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const free = await createTeam(db, "free-team");
    await expect(
      callerFor(free, "owner").billing.setOverage({ enabled: true }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(calls.itemCreates).toEqual([]);
  });

  it("portal needs a customer and passes the configured portal id", async () => {
    const teamId = await createTeam(db);
    const owner = callerFor(teamId, "owner");
    await expect(owner.billing.portal()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await db
      .update(schema.teams)
      .set({ stripeCustomerId: "cus_1" })
      .where(eq(schema.teams.id, teamId));
    expect(await owner.billing.portal()).toEqual({ url: "https://billing.stripe.com/p/1" });
    expect(calls.portals).toEqual([
      { customer: "cus_1", return_url: "https://app.example.com/settings/billing" },
    ]);

    vi.stubEnv("STRIPE_PORTAL_CONFIG", "bpc_1");
    await owner.billing.portal();
    expect(calls.portals[1]).toMatchObject({ configuration: "bpc_1" });
  });
});
