import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BillingStripe } from "../src/stripe.js";
import { handleWebhook } from "../src/webhook.js";

const SECRET = "whsec_test";
// Signature verification is pure crypto; a key-less real client signs and verifies offline.
const { webhooks } = new Stripe("sk_test_x");

let db: Db;
let close: () => Promise<void>;
let subscriptions: Record<string, Stripe.Subscription>;
let retrieves: string[];

const stripe = {
  webhooks,
  subscriptions: {
    async retrieve(id: string) {
      retrieves.push(id);
      const sub = subscriptions[id];
      if (!sub) throw new Error(`No such subscription: ${id}`);
      return sub;
    },
  },
} as unknown as BillingStripe;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  subscriptions = {};
  retrieves = [];
});

afterEach(() => close());

function subscription(
  id: string,
  customer: string,
  status: Stripe.Subscription.Status,
  lookupKey = "millionsend_pro_monthly",
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
          price: { id: `price_${lookupKey}`, lookup_key: lookupKey },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

let seq = 0;
function event(type: string, object: Record<string, unknown>, id = `evt_${++seq}`): string {
  return JSON.stringify({ id, object: "event", type, data: { object } });
}

function deliver(
  payload: string,
  signature: string | null = webhooks.generateTestHeaderString({ payload, secret: SECRET }),
) {
  return handleWebhook(payload, signature, { db, stripe, webhookSecret: SECRET, log: () => {} });
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

  it("processes an event once; redeliveries are acknowledged without side effects", async () => {
    const teamId = await customerTeam();
    subscriptions.sub_1 = subscription("sub_1", "cus_1", "active");
    const payload = subEvent("customer.subscription.created", subscriptions.sub_1);
    expect(await deliver(payload)).toBe(200);
    expect((await team(teamId))?.plan).toBe("pro");

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

  it("past_due keeps the plan as a grace period; unpaid and canceled drop to free", async () => {
    const teamId = await customerTeam();
    subscriptions.sub_1 = subscription("sub_1", "cus_1", "active");
    await deliver(subEvent("customer.subscription.created", subscriptions.sub_1));

    subscriptions.sub_1 = subscription("sub_1", "cus_1", "past_due");
    await deliver(
      event("invoice.payment_failed", {
        id: "in_1",
        object: "invoice",
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
        parent: { subscription_details: { subscription: "sub_1" } },
      }),
    );
    expect(await team(teamId)).toMatchObject({ plan: "pro", planStatus: "active" });

    subscriptions.sub_1 = subscription("sub_1", "cus_1", "canceled");
    await deliver(subEvent("customer.subscription.deleted", subscriptions.sub_1));
    expect(await team(teamId)).toMatchObject({ plan: "free", planStatus: "canceled" });
  });

  it("checkout.session.completed links the customer via client_reference_id", async () => {
    const teamId = await createTeam(db);
    subscriptions.sub_1 = subscription("sub_1", "cus_new", "active");
    await deliver(
      event("checkout.session.completed", {
        id: "cs_1",
        object: "checkout.session",
        subscription: "sub_1",
        customer: "cus_new",
        client_reference_id: teamId,
      }),
    );
    expect(await team(teamId)).toMatchObject({
      plan: "pro",
      stripeCustomerId: "cus_new",
      stripeSubscriptionId: "sub_1",
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
