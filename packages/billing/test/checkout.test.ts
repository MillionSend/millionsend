import type { Db } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckoutSession } from "../src/checkout.js";
import type { BillingStripe } from "../src/stripe.js";
import { fakeStripe, priceId, teamRow } from "./helpers.js";

let db: Db;
let close: () => Promise<void>;
let stripe: BillingStripe;
let state: ReturnType<typeof fakeStripe>["state"];

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ({ stripe, state } = fakeStripe());
});

afterEach(() => close());

const urls = { successUrl: "https://app/ok", cancelUrl: "https://app/back" };

describe("createCheckoutSession", () => {
  it("a monthly rung carries its plan price and its metered price; a daily rung only the plan", async () => {
    const teamId = await createTeam(db);
    const team = { id: teamId, name: "acme", stripeCustomerId: null };
    const url = await createCheckoutSession(
      { db, stripe },
      { team, rung: "pro_100k", email: "owner@example.com", ...urls },
    );
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(state.customers).toEqual([
      { name: "acme", email: "owner@example.com", metadata: { team_id: teamId } },
    ]);
    expect(state.checkouts[0]).toMatchObject({
      mode: "subscription",
      customer: "cus_1",
      client_reference_id: teamId,
      line_items: [
        { price: priceId("millionsend_pro_100k_monthly"), quantity: 1 },
        { price: priceId("millionsend_pro_100k_overage") },
      ],
    });
    expect((await teamRow(db, teamId))?.stripeCustomerId).toBe("cus_1");

    await createCheckoutSession(
      { db, stripe },
      { team: { ...team, stripeCustomerId: "cus_1" }, rung: "starter", email: "o@x", ...urls },
    );
    expect(state.customers).toHaveLength(1);
    expect(state.checkouts[1]?.line_items).toEqual([
      { price: priceId("millionsend_starter_monthly"), quantity: 1 },
    ]);
  });

  it("refuses the free rung", async () => {
    const teamId = await createTeam(db);
    await expect(
      createCheckoutSession(
        { db, stripe },
        {
          team: { id: teamId, name: "acme", stripeCustomerId: null },
          rung: "free",
          email: "o@x",
          ...urls,
        },
      ),
    ).rejects.toThrow("not for sale");
    expect(state.checkouts).toEqual([]);
  });
});
