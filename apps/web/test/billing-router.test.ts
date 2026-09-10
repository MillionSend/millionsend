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
  scheduleCreates: Stripe.SubscriptionScheduleCreateParams[];
  scheduleUpdates: Stripe.SubscriptionScheduleUpdateParams[];
  scheduleReleases: string[];
  meterEvents: Stripe.Billing.MeterEventCreateParams[];
};
let onCustomerCreate: (() => Promise<void>) | undefined;

// Stripe stamps whole seconds; rows and the fake agree from the start.
const wholeSeconds = (ms: number) => new Date(Math.floor(ms / 1000) * 1000);
const PERIOD_START = wholeSeconds(Date.now() - 10 * DAY_MS);
const PERIOD_END = wholeSeconds(Date.now() + 20 * DAY_MS);
const seconds = (d: Date) => d.getTime() / 1000;

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
    ...(p.recurring?.usage_type === "metered" ? {} : { quantity: 1 }),
    current_period_start: seconds(PERIOD_START),
    current_period_end: seconds(PERIOD_END),
  } as unknown as Stripe.SubscriptionItem;
}
/** The one subscription the fake Stripe holds and the schedule pending on it; every change rewrites them like Stripe would. */
let sub: Stripe.Subscription;
let schedule: Stripe.SubscriptionSchedule | null;
function subscription(items: Stripe.SubscriptionItem[]): Stripe.Subscription {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    cancel_at: null,
    items: { data: items },
    schedule,
  } as unknown as Stripe.Subscription;
}

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
        if (u.deleted || !u.price) continue;
        const existing = kept.find((i) => i.id === u.id);
        if (existing) existing.price = priceById(u.price);
        else kept.push(item("si_overage", priceById(u.price)));
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
  subscriptionSchedules: {
    create: async (params: Stripe.SubscriptionScheduleCreateParams) => {
      calls.scheduleCreates.push(params);
      schedule = { id: "sub_sched_1", phases: [] } as unknown as Stripe.SubscriptionSchedule;
      sub = subscription(sub.items.data);
      return schedule;
    },
    update: async (_id: string, params: Stripe.SubscriptionScheduleUpdateParams) => {
      calls.scheduleUpdates.push(params);
      schedule = {
        id: "sub_sched_1",
        phases: (params.phases ?? []).map((phase) => ({
          items: (phase.items ?? []).map((i) => ({
            price: priceById(i.price ?? ""),
            quantity: i.quantity,
          })),
        })),
      } as unknown as Stripe.SubscriptionSchedule;
      sub = subscription(sub.items.data);
      return schedule;
    },
    release: async (id: string) => {
      calls.scheduleReleases.push(id);
      schedule = null;
      sub = subscription(sub.items.data);
      return { id };
    },
  },
  billing: {
    meterEvents: {
      create: async (params: Stripe.Billing.MeterEventCreateParams) => {
        calls.meterEvents.push(params);
        return {};
      },
    },
  },
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

/**
 * A team mid-period on `key`, with the matching subscription in the fake
 * Stripe. A monthly rung carries its metered item unless `metered` is false
 * (a subscription from before the ladder); `overage` is the row's switch.
 */
async function subscribedTeam(
  key: PlanRungKey,
  opts: { overage?: boolean; metered?: boolean } = {},
): Promise<string> {
  const teamId = await createTeam(db);
  const rung = rungByKey(key);
  const metered = opts.metered ?? rung.period === "month";
  schedule = null;
  sub = subscription([
    item("si_base", price(key)),
    ...(metered ? [item("si_overage", price(key, true))] : []),
  ]);
  await db
    .update(schema.teams)
    .set({
      plan: rung.plan,
      planQuota: rung.period === "month" ? rung.included : null,
      planStatus: "active",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      stripeOverageItemId: metered ? "si_overage" : null,
      overageEnabled: opts.overage ?? false,
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

const notificationRows = () =>
  db
    .select({ kind: schema.teamNotifications.kind, key: schema.teamNotifications.periodKey })
    .from(schema.teamNotifications);

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
    scheduleCreates: [],
    scheduleUpdates: [],
    scheduleReleases: [],
    meterEvents: [],
  };
  schedule = null;
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
      pendingRung: null,
      planStatus: "none",
      currentPeriodEnd: null,
      quota: { kind: "day", plan: "free", limit: 100 },
      usage: { accepted: 0, reportedOverage: 0 },
      hasCustomer: false,
      hasLiveSubscription: false,
    });
  });

  it("status counts a monthly plan against its billing period", async () => {
    const teamId = await subscribedTeam("pro_200k", { overage: true });
    await db
      .insert(schema.usagePeriods)
      .values({ teamId, periodStart: PERIOD_START, accepted: 1234, reportedOverage: 0 });
    expect(await callerFor(teamId, "member").billing.status()).toMatchObject({
      plan: "pro",
      planQuota: 200_000,
      rung: "pro_200k",
      pendingRung: null,
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

  it("checkout creates the customer once, stores it, and sells the rung's price with its metered item", async () => {
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
      line_items: [{ price: "price_scale_1m", quantity: 1 }, { price: "price_scale_1m_overage" }],
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
      line_items: [{ price: "price_pro_100k", quantity: 1 }, { price: "price_pro_100k_overage" }],
    });

    // A daily rung has nothing to meter.
    await admin.billing.checkout({ rung: "starter" });
    expect(calls.checkouts[2]?.line_items).toEqual([{ price: "price_starter", quantity: 1 }]);
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

  it("changePlan moves up at once with prorations, re-pricing the metered item, and drains on a raise", async () => {
    const teamId = await subscribedTeam("pro_100k");
    const owner = callerFor(teamId, "owner");
    expect(await owner.billing.changePlan({ rung: "scale_500k" })).toEqual({ applied: "now" });
    expect(calls.updates).toEqual([
      {
        items: [
          { id: "si_base", price: "price_scale_500k" },
          { id: "si_overage", price: "price_scale_500k_overage" },
        ],
        proration_behavior: "create_prorations",
      },
    ]);
    expect(calls.scheduleCreates).toEqual([]);
    expect(await teamRow(teamId)).toMatchObject({
      plan: "scale",
      planQuota: 500_000,
      stripeOverageItemId: "si_overage",
      pendingRung: null,
    });
    expect(h.runCronNow).toHaveBeenCalledWith("quota.drain");
    expect(await auditRows()).toEqual([
      { action: "billing.plan_changed", data: { rung: "scale_500k", applied: "now" } },
    ]);
  });

  it("changePlan adds the metered item a subscription from before the ladder lacks", async () => {
    const teamId = await subscribedTeam("pro_100k", { metered: false });
    await callerFor(teamId, "owner").billing.changePlan({ rung: "pro_200k" });
    expect(calls.updates[0]?.items).toEqual([
      { id: "si_base", price: "price_pro_200k" },
      { price: "price_pro_200k_overage" },
    ]);
    expect(await teamRow(teamId)).toMatchObject({
      planQuota: 200_000,
      stripeOverageItemId: "si_overage",
    });
  });

  it("changePlan schedules a move down for the period end and leaves the row alone until then; the current rung drops it", async () => {
    const teamId = await subscribedTeam("scale_500k");
    const owner = callerFor(teamId, "owner");
    expect(await owner.billing.changePlan({ rung: "pro_100k" })).toEqual({
      applied: "period_end",
      at: PERIOD_END,
    });
    expect(calls.updates).toEqual([]);
    expect(calls.scheduleCreates).toEqual([{ from_subscription: "sub_1" }]);
    expect(calls.scheduleUpdates).toEqual([
      {
        end_behavior: "release",
        phases: [
          {
            items: [
              { price: "price_scale_500k", quantity: 1 },
              { price: "price_scale_500k_overage" },
            ],
            start_date: seconds(PERIOD_START),
            end_date: seconds(PERIOD_END),
            proration_behavior: "none",
          },
          {
            items: [{ price: "price_pro_100k", quantity: 1 }, { price: "price_pro_100k_overage" }],
            duration: { interval: "month", interval_count: 1 },
            proration_behavior: "none",
          },
        ],
      },
    ]);
    expect(await teamRow(teamId)).toMatchObject({
      plan: "scale",
      planQuota: 500_000,
      pendingRung: "pro_100k",
    });
    expect((await owner.billing.status()).pendingRung).toBe("pro_100k");
    expect(h.runCronNow).not.toHaveBeenCalled();

    // Another move down rewrites the same schedule; a daily rung's phase carries no metered item.
    await owner.billing.changePlan({ rung: "starter" });
    expect(calls.scheduleCreates).toHaveLength(1);
    expect(calls.scheduleUpdates[1]?.phases?.[1]?.items).toEqual([
      { price: "price_starter", quantity: 1 },
    ]);
    expect((await teamRow(teamId))?.pendingRung).toBe("starter");

    // Keeping the current rung releases the schedule.
    expect(await owner.billing.changePlan({ rung: "scale_500k" })).toEqual({
      applied: "unscheduled",
    });
    expect(calls.scheduleReleases).toEqual(["sub_sched_1"]);
    expect(await teamRow(teamId)).toMatchObject({
      plan: "scale",
      planQuota: 500_000,
      pendingRung: null,
    });
    expect(await auditRows()).toEqual([
      { action: "billing.plan_changed", data: { rung: "pro_100k", applied: "period_end" } },
      { action: "billing.plan_changed", data: { rung: "starter", applied: "period_end" } },
      { action: "billing.plan_changed", data: { rung: "scale_500k", applied: "unscheduled" } },
    ]);
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
    expect(await notificationRows()).toEqual([
      { kind: "billing.plan_changed", key: `pro_100k>scale_500k:${PERIOD_END.toISOString()}` },
    ]);

    // A scheduled move down is not a move yet; the move up that drops it is news of its own.
    await owner.billing.changePlan({ rung: "pro_200k" });
    expect(h.sent).toHaveLength(1);
    await owner.billing.changePlan({ rung: "scale_1m" });
    expect(calls.scheduleReleases).toEqual(["sub_sched_1"]);
    expect(h.sent.map((m) => m.subject)).toEqual([
      "acme moved from Pro 100k to Scale 500k",
      "acme moved from Scale 500k to Scale 1M",
    ]);
    expect((await teamRow(teamId))?.pendingRung).toBeNull();
  });

  it("changePlan needs a live subscription", async () => {
    const teamId = await createTeam(db);
    await expect(
      callerFor(teamId, "owner").billing.changePlan({ rung: "pro_100k" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(calls.updates).toEqual([]);
  });

  it("setOverage is a switch on the row; off first reports what the meter has not seen", async () => {
    const teamId = await subscribedTeam("pro_100k");
    const owner = callerFor(teamId, "owner");
    await owner.billing.setOverage({ enabled: true });
    expect(calls.itemCreates).toEqual([]);
    expect(calls.updates).toEqual([]);
    expect(await teamRow(teamId)).toMatchObject({
      overageEnabled: true,
      stripeOverageItemId: "si_overage",
    });
    expect((await owner.billing.status()).quota).toMatchObject({ kind: "month", overage: true });
    // Overage lets parked broadcast mail through: drained at once.
    expect(h.runCronNow).toHaveBeenCalledWith("quota.drain");

    h.runCronNow.mockClear();
    await db
      .insert(schema.usagePeriods)
      .values({ teamId, periodStart: PERIOD_START, accepted: 100_500 });
    await owner.billing.setOverage({ enabled: false });
    expect(calls.meterEvents).toEqual([
      expect.objectContaining({
        event_name: "emails_over_quota",
        payload: { stripe_customer_id: "cus_1", value: "500" },
      }),
    ]);
    expect(
      await db
        .select({
          reportedOverage: schema.usagePeriods.reportedOverage,
          pendingOverage: schema.usagePeriods.pendingOverage,
        })
        .from(schema.usagePeriods),
    ).toEqual([{ reportedOverage: 500, pendingOverage: null }]);
    expect(calls.itemDeletes).toEqual([]);
    expect(await teamRow(teamId)).toMatchObject({
      overageEnabled: false,
      stripeOverageItemId: "si_overage",
    });
    expect((await owner.billing.status()).quota).toMatchObject({ kind: "month", overage: false });
    expect(h.runCronNow).not.toHaveBeenCalled();
    expect(await auditRows()).toEqual([
      { action: "billing.overage_toggled", data: { enabled: true } },
      { action: "billing.overage_toggled", data: { enabled: false } },
    ]);
  });

  it("setOverage on adds the metered item to a subscription from before the ladder", async () => {
    const teamId = await subscribedTeam("pro_100k", { metered: false });
    await callerFor(teamId, "owner").billing.setOverage({ enabled: true });
    expect(calls.itemCreates).toEqual([{ subscription: "sub_1", price: "price_pro_100k_overage" }]);
    expect(await teamRow(teamId)).toMatchObject({
      overageEnabled: true,
      stripeOverageItemId: "si_overage",
    });
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
