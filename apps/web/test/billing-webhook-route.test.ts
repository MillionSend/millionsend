import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ db: undefined as unknown as Db }));

vi.mock("@millionsend/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@millionsend/db")>();
  return { ...actual, getDb: () => h.db };
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

  it("acknowledges a verified event and records it", async () => {
    const valid = webhooks.generateTestHeaderString({ payload, secret: SECRET });
    expect((await post(valid)).status).toBe(200);
    expect((await post(valid)).status).toBe(200);
    expect(await h.db.select({ id: schema.stripeEvents.id }).from(schema.stripeEvents)).toEqual([
      { id: "evt_1" },
    ]);
  });
});
