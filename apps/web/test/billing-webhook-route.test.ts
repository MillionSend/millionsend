import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: undefined as unknown as Db,
  runCronNow: vi.fn(async (_name: string) => {}),
  // Stands in for Stripe's subscription handling: the route only needs to see
  // the plan column change under a verified event.
  planAfterEvent: null as string | null,
}));

vi.mock("@millionsend/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@millionsend/db")>();
  return { ...actual, getDb: () => h.db };
});
vi.mock("@/server/queue", () => ({ getQueue: async () => ({ runCronNow: h.runCronNow }) }));
vi.mock("@millionsend/billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@millionsend/billing")>();
  return {
    ...actual,
    handleWebhook: async (...args: Parameters<typeof actual.handleWebhook>) => {
      if (!h.planAfterEvent) return actual.handleWebhook(...args);
      await h.db
        .update(schema.teams)
        .set({ plan: h.planAfterEvent as "free" | "pro" | "scale" })
        .where(eq(schema.teams.stripeCustomerId, "cus_1"));
      return 200;
    },
  };
});

const { POST } = await import("@/app/api/billing/webhook/route");

const SECRET = "whsec_test";
const { webhooks } = new Stripe("sk_test_x");
const payload = JSON.stringify({
  id: "evt_1",
  object: "event",
  type: "customer.created",
  livemode: false,
  data: { object: { id: "cus_1" } },
});

function post(signature: string | null): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature) headers.set("stripe-signature", signature);
  return POST(
    new Request("https://app.example.com/api/billing/webhook", {
      method: "POST",
      headers,
      body: payload,
    }),
  );
}

let close: () => Promise<void>;

beforeEach(async () => {
  ({ db: h.db, close } = await createTestDb());
  vi.stubEnv("IS_CLOUD", "true");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  h.planAfterEvent = null;
  h.runCronNow.mockClear();
  await close();
});

describe("POST /api/billing/webhook", () => {
  it("is not mounted on self-host", async () => {
    vi.stubEnv("IS_CLOUD", "");
    const valid = webhooks.generateTestHeaderString({ payload, secret: SECRET });
    expect((await post(valid)).status).toBe(404);
    expect(await h.db.select().from(schema.stripeEvents)).toEqual([]);
  });

  it("rejects unsigned and mis-signed bodies", async () => {
    expect((await post(null)).status).toBe(400);
    expect(
      (await post(webhooks.generateTestHeaderString({ payload, secret: "whsec_other" }))).status,
    ).toBe(400);
    expect(await h.db.select().from(schema.stripeEvents)).toEqual([]);
  });

  it("drains quota-parked mail at once when an event raises the team's plan", async () => {
    const teamId = await createTeam(h.db, "upgrader");
    await h.db
      .update(schema.teams)
      .set({ stripeCustomerId: "cus_1" })
      .where(eq(schema.teams.id, teamId));
    // Subscription events carry the customer id, which is how the route
    // finds the team whose plan may have moved.
    const subscriptionEvent = (id: string) =>
      JSON.stringify({
        id,
        object: "event",
        type: "customer.subscription.updated",
        livemode: false,
        data: { object: { id: "sub_1", customer: "cus_1" } },
      });
    const send = (body: string) =>
      POST(
        new Request("https://app.example.com/api/billing/webhook", {
          method: "POST",
          headers: new Headers({
            "content-type": "application/json",
            "stripe-signature": webhooks.generateTestHeaderString({
              payload: body,
              secret: SECRET,
            }),
          }),
          body,
        }),
      );

    h.planAfterEvent = "pro";
    expect((await send(subscriptionEvent("evt_up"))).status).toBe(200);
    expect(h.runCronNow).toHaveBeenCalledWith("quota.drain");

    // A queue hiccup never fails the webhook: the plan is committed and the
    // scheduled drain releases the mail anyway.
    h.runCronNow.mockClear();
    h.runCronNow.mockRejectedValueOnce(new Error("pg-boss unavailable"));
    h.planAfterEvent = "scale";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await send(subscriptionEvent("evt_up2"))).status).toBe(200);
    expect(h.runCronNow).toHaveBeenCalledTimes(1);
    errors.mockRestore();

    // A downgrade leaves the schedule alone.
    h.runCronNow.mockClear();
    h.planAfterEvent = "free";
    expect((await send(subscriptionEvent("evt_down"))).status).toBe(200);
    expect(h.runCronNow).not.toHaveBeenCalled();
  });

  it("acknowledges a verified event and records it", async () => {
    const valid = webhooks.generateTestHeaderString({ payload, secret: SECRET });
    expect((await post(valid)).status).toBe(200);
    expect((await post(valid)).status).toBe(200);
    expect(await h.db.select({ id: schema.stripeEvents.id }).from(schema.stripeEvents)).toEqual([
      { id: "evt_1" },
    ]);
  });
});
