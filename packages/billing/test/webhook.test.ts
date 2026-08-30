import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BillingStripe } from "../src/stripe.js";
import { cancelTeamSubscription, reconcileTeamPlan } from "../src/subscription.js";
import { handleWebhook, purgeStripeEvents } from "../src/webhook.js";

const SECRET = "whsec_test";
// Signature verification is pure crypto; a key-less real client signs and verifies offline.
const { webhooks } = new Stripe("sk_test_x");

let db: Db;
let close: () => Promise<void>;
let subscriptions: Record<string, Stripe.Subscription>;
let retrieves: string[];
let retrieveParams: Stripe.SubscriptionRetrieveParams | undefined;
let listParams: Stripe.SubscriptionListParams | undefined;
let cancels: string[];

const stripe = {
  webhooks,
  subscriptions: {
    async retrieve(id: string, params?: Stripe.SubscriptionRetrieveParams) {
      retrieves.push(id);
      retrieveParams = params;
      const sub = subscriptions[id];
      if (!sub) throw new Error(`No such subscription: ${id}`);
      return sub;
    },
    async list(params: Stripe.SubscriptionListParams) {
      listParams = params;
      // Newest first, like Stripe.
      const data = Object.values(subscriptions)
        .filter((s) => s.customer === params.customer)
        .reverse();
      return { data: data.slice(0, params.limit ?? data.length) };
    },
    async cancel(id: string) {
      cancels.push(id);
      const sub = subscriptions[id];
      if (!sub) throw new Error(`No such subscription: ${id}`);
      return { ...sub, status: "canceled" };
    },
  },
} as unknown as BillingStripe;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  subscriptions = {};
  retrieves = [];
  retrieveParams = undefined;
  listParams = undefined;
  cancels = [];
});

afterEach(() => close());

function subscription(
  id: string,
  customer: string,
  status: Stripe.Subscription.Status,
  lookupKey: string | null = "millionsend_pro_monthly",
  product: unknown = "prod_1",
): Stripe.Subscription {
  return {
    id,
    object: "subscription",
    customer,
    status,
    items: {
      data: [
        {
          current_period_end: 1_900_000_000,
          price: { id: `price_${lookupKey}`, lookup_key: lookupKey, product },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

let seq = 0;
function event(
  type: string,
  object: Record<string, unknown>,
  id = `evt_${++seq}`,
  livemode = false,
): string {
  return JSON.stringify({ id, object: "event", type, livemode, data: { object } });
}

function deliver(
  payload: string,
  signature: string | null = webhooks.generateTestHeaderString({ payload, secret: SECRET }),
) {
  return handleWebhook(payload, signature, {
    db,
    stripe,
    webhookSecret: SECRET,
    livemode: false,
    log: () => {},
  });
}

async function team(teamId: string) {
  const [row] = await db
    .select({
      plan: schema.teams.plan,
      planStatus: schema.teams.planStatus,
      stripeCustomerId: schema.teams.stripeCustomerId,
      stripeSubscriptionId: schema.teams.stripeSubscriptionId,
      currentPeriodEnd: schema.teams.currentPeriodEnd,
    })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  return row;
}

async function customerTeam(customer = "cus_1"): Promise<string> {
  const teamId = await createTeam(db);
  await db
    .update(schema.teams)
    .set({ stripeCustomerId: customer })
    .where(eq(schema.teams.id, teamId));
  return teamId;
}

const subEvent = (type: string, sub: Stripe.Subscription, id?: string) =>
  event(type, { id: sub.id, object: "subscription", customer: sub.customer }, id);

describe("handleWebhook", () => {
  it("rejects a bad signature without recording the event", async () => {
    const payload = event("customer.subscription.updated", { id: "sub_1" });
    expect(await deliver(payload, "t=1,v1=bad")).toBe(400);
    expect(await deliver(payload, null)).toBe(400);
    expect(
      await deliver(payload, webhooks.generateTestHeaderString({ payload, secret: "whsec_other" })),
    ).toBe(400);
    expect(await db.select().from(schema.stripeEvents)).toEqual([]);
  });

  it("rejects an event whose mode does not match the configured key", async () => {
    await customerTeam();
    subscriptions.sub_1 = subscription("sub_1", "cus_1", "active");
    const payload = event(
      "customer.subscription.created",
      { id: "sub_1", object: "subscription", customer: "cus_1" },
      "evt_live",
      true,
    );
    expect(await deliver(payload)).toBe(400);
    expect(await db.select().from(schema.stripeEvents)).toEqual([]);
    expect(retrieves).toEqual([]);
  });

  it("processes an event once; redeliveries are acknowledged without side effects", async () => {
    const teamId = await customerTeam();
    subscriptions.sub_1 = subscription("sub_1", "cus_1", "active");
    const payload = subEvent("customer.subscription.created", subscriptions.sub_1);
    expect(await deliver(payload)).toBe(200);
    expect((await team(teamId))?.plan).toBe("pro");
    expect(retrieveParams).toEqual({ expand: ["items.data.price.product"] });

    subscriptions.sub_1 = subscription("sub_1", "cus_1", "canceled");
    expect(await deliver(payload)).toBe(200);
    expect(retrieves).toEqual(["sub_1"]);
    expect((await team(teamId))?.plan).toBe("pro");
  });

  it("active/trialing grant the plan from the price lookup key", async () => {
    const teamId = await customerTeam();
    subscriptions.sub_1 = subscription("sub_1", "cus_1", "trialing", "millionsend_scale_monthly");
    await deliver(subEvent("customer.subscription.created", subscriptions.sub_1));
    expect(await team(teamId)).toEqual({
      plan: "scale",
      planStatus: "trialing",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      currentPeriodEnd: new Date(1_900_000_000 * 1000),
    });

    subscriptions.sub_1 = subscription("sub_1", "cus_1", "active");
    await deliver(subEvent("customer.subscription.updated", subscriptions.sub_1));
    expect(await team(teamId)).toMatchObject({ plan: "pro", planStatus: "active" });
  });

  it("resolves a rotated (key-less) price through the product's plan metadata", async () => {
    const teamId = await customerTeam();
    subscriptions.sub_1 = subscription("sub_1", "cus_1", "active", null, {
      id: "prod_scale",
      object: "product",
      metadata: { millionsend_plan: "scale" },
    });
    await deliver(subEvent("customer.subscription.created", subscriptions.sub_1));
    expect(await team(teamId)).toMatchObject({ plan: "scale", planStatus: "active" });
  });

  it("past_due keeps the plan as a grace period; unpaid and canceled drop to free", async () => {
    const teamId = await customerTeam();
    subscriptions.sub_1 = subscription("sub_1", "cus_1", "active");
    await deliver(subEvent("customer.subscription.created", subscriptions.sub_1));

    subscriptions.sub_1 = subscription("sub_1", "cus_1", "past_due");
    await deliver(
      event("invoice.payment_failed", {
        id: "in_1",
        object: "invoice",
        customer: "cus_1",
        parent: { subscription_details: { subscription: "sub_1" } },
      }),
    );
    expect(await team(teamId)).toMatchObject({ plan: "pro", planStatus: "past_due" });

    subscriptions.sub_1 = subscription("sub_1", "cus_1", "unpaid");
    await deliver(subEvent("customer.subscription.updated", subscriptions.sub_1));
    expect(await team(teamId)).toMatchObject({ plan: "free", planStatus: "unpaid" });

    subscriptions.sub_1 = subscription("sub_1", "cus_1", "active");
    await deliver(
      event("invoice.paid", {
        id: "in_2",
        object: "invoice",
        customer: "cus_1",
        parent: { subscription_details: { subscription: "sub_1" } },
      }),
    );
    expect(await team(teamId)).toMatchObject({ plan: "pro", planStatus: "active" });

    subscriptions.sub_1 = subscription("sub_1", "cus_1", "canceled");
    await deliver(subEvent("customer.subscription.deleted", subscriptions.sub_1));
    expect(await team(teamId)).toMatchObject({ plan: "free", planStatus: "canceled" });
  });

  it("checkout.session.completed applies the plan to the pre-created customer only", async () => {
    const linked = await customerTeam("cus_1");
    const other = await createTeam(db, "other");
    subscriptions.sub_1 = subscription("sub_1", "cus_1", "active");
    subscriptions.sub_x = subscription("sub_x", "cus_unknown", "active");
    await deliver(
      event("checkout.session.completed", {
        id: "cs_1",
        object: "checkout.session",
        subscription: "sub_1",
        customer: "cus_1",
        client_reference_id: linked,
      }),
    );
    expect(await team(linked)).toMatchObject({ plan: "pro", stripeSubscriptionId: "sub_1" });

    // A team id in the session is never trusted to link an unknown customer.
    expect(
      await deliver(
        event("checkout.session.completed", {
          id: "cs_2",
          object: "checkout.session",
          subscription: "sub_x",
          customer: "cus_unknown",
          client_reference_id: other,
          metadata: { team_id: other },
        }),
      ),
    ).toBe(200);
    expect(await team(other)).toMatchObject({
      plan: "free",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });
  });

  it("ignores the end of a superseded subscription", async () => {
    const teamId = await customerTeam();
    subscriptions.sub_old = subscription("sub_old", "cus_1", "canceled");
    subscriptions.sub_new = subscription("sub_new", "cus_1", "active", "millionsend_scale_monthly");
    await deliver(subEvent("customer.subscription.created", subscriptions.sub_new));
    await deliver(subEvent("customer.subscription.deleted", subscriptions.sub_old));
    expect(await team(teamId)).toMatchObject({
      plan: "scale",
      planStatus: "active",
      stripeSubscriptionId: "sub_new",
    });
  });

  it("acknowledges events for unknown customers, unknown prices, and unhandled types", async () => {
    const teamId = await customerTeam();
    subscriptions.sub_x = subscription("sub_x", "cus_unknown", "active");
    expect(await deliver(subEvent("customer.subscription.created", subscriptions.sub_x))).toBe(200);

    subscriptions.sub_1 = subscription("sub_1", "cus_1", "active", "someone_elses_price");
    expect(await deliver(subEvent("customer.subscription.created", subscriptions.sub_1))).toBe(200);

    expect(await deliver(event("customer.created", { id: "cus_1", object: "customer" }))).toBe(200);
    expect(await team(teamId)).toMatchObject({
      plan: "free",
      planStatus: "none",
      stripeSubscriptionId: null,
    });
    expect((await db.select().from(schema.stripeEvents)).length).toBe(3);
  });

  it("rolls back the ledger row when Stripe cannot be reached, so the retry is processed", async () => {
    await customerTeam();
    await expect(
      deliver(
        subEvent("customer.subscription.created", subscription("sub_gone", "cus_1", "active")),
      ),
    ).rejects.toThrow("No such subscription");
    expect(await db.select().from(schema.stripeEvents)).toEqual([]);
  });
});

describe("purgeStripeEvents", () => {
  it("drops only rows older than the retention window", async () => {
    const now = new Date("2026-06-01T00:00:00Z");
    await db.insert(schema.stripeEvents).values([
      { id: "evt_old", type: "x", receivedAt: new Date("2026-02-01T00:00:00Z") },
      { id: "evt_recent", type: "x", receivedAt: new Date("2026-05-01T00:00:00Z") },
    ]);
    expect(await purgeStripeEvents(db, now)).toBe(1);
    expect(await db.select({ id: schema.stripeEvents.id }).from(schema.stripeEvents)).toEqual([
      { id: "evt_recent" },
    ]);
  });
});

describe("reconcileTeamPlan", () => {
  it("applies the customer's newest subscription; no customer or no subscription is a no-op", async () => {
    const teamId = await customerTeam();
    const noCustomer = await createTeam(db, "other");
    await reconcileTeamPlan({ db, stripe, log: () => {} }, noCustomer);
    await reconcileTeamPlan({ db, stripe, log: () => {} }, teamId);
    expect(listParams).toMatchObject({ customer: "cus_1", status: "all", limit: 1 });
    expect(await team(teamId)).toMatchObject({ plan: "free", planStatus: "none" });

    subscriptions.sub_old = subscription("sub_old", "cus_1", "canceled");
    subscriptions.sub_new = subscription("sub_new", "cus_1", "active", "millionsend_scale_monthly");
    await reconcileTeamPlan({ db, stripe, log: () => {} }, teamId);
    expect(listParams?.expand).toEqual(["data.items.data.price.product"]);
    expect(await team(teamId)).toMatchObject({
      plan: "scale",
      planStatus: "active",
      stripeSubscriptionId: "sub_new",
    });
  });
});

describe("cancelTeamSubscription", () => {
  it("cancels the live subscription immediately and clears the plan; no subscription is a no-op", async () => {
    const teamId = await customerTeam();
    await cancelTeamSubscription({ db, stripe }, teamId);
    expect(cancels).toEqual([]);

    subscriptions.sub_1 = subscription("sub_1", "cus_1", "active");
    await deliver(subEvent("customer.subscription.created", subscriptions.sub_1));
    await cancelTeamSubscription({ db, stripe }, teamId);
    expect(cancels).toEqual(["sub_1"]);
    expect(await team(teamId)).toMatchObject({
      plan: "free",
      planStatus: "canceled",
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
      stripeCustomerId: "cus_1",
    });

    // Already ended in Stripe (e.g. from the dashboard): nothing to cancel.
    await db
      .update(schema.teams)
      .set({ stripeSubscriptionId: "sub_1", plan: "pro", planStatus: "active" })
      .where(eq(schema.teams.id, teamId));
    subscriptions.sub_1 = subscription("sub_1", "cus_1", "canceled");
    await cancelTeamSubscription({ db, stripe }, teamId);
    expect(cancels).toEqual(["sub_1"]);
    expect(await team(teamId)).toMatchObject({ plan: "free", stripeSubscriptionId: null });
  });
});
