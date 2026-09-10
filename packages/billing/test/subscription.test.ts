import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reportOverage } from "../src/overage.js";
import type { BillingStripe } from "../src/stripe.js";
import { applySubscription, changeRung, setOverage } from "../src/subscription.js";
import { fakeStripe, PERIOD_START, priceId, subscription, teamRow } from "./helpers.js";

let db: Db;
let close: () => Promise<void>;
let stripe: BillingStripe;
let state: ReturnType<typeof fakeStripe>["state"];

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ({ stripe, state } = fakeStripe());
});

afterEach(() => close());

const deps = () => ({ db, stripe, log: () => {} });
const team = (teamId: string) => teamRow(db, teamId);

/** A team whose row mirrors `sub`, with `accepted` sends in the current period. */
async function subscribedTeam(sub: Stripe.Subscription, accepted = 0): Promise<string> {
  const teamId = await createTeam(db);
  state.subscriptions[sub.id] = sub;
  await db
    .update(schema.teams)
    .set({ stripeCustomerId: sub.customer as string })
    .where(eq(schema.teams.id, teamId));
  await applySubscription(db, sub, () => {});
  if (accepted) {
    await db
      .insert(schema.usagePeriods)
      .values({ teamId, periodStart: new Date(PERIOD_START * 1000), accepted });
  }
  return teamId;
}

const withOverage = (
  lookupKey = "millionsend_pro_100k_monthly",
  overageKey = "millionsend_pro_100k_overage",
) => subscription("sub_1", "cus_1", "active", lookupKey, { overageKey });

/** What the team's one period row says the meter already knows about. */
async function reportedOverage(teamId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ reportedOverage: schema.usagePeriods.reportedOverage })
    .from(schema.usagePeriods)
    .where(eq(schema.usagePeriods.teamId, teamId));
  return row?.reportedOverage;
}

describe("changeRung", () => {
  it("re-prices the plan item and the metered item for a monthly rung, then applies the result", async () => {
    const teamId = await subscribedTeam(withOverage());
    await changeRung(deps(), { teamId, rung: "pro_200k" });
    expect(state.updates).toEqual([
      [
        "sub_1",
        {
          items: [
            { id: "si_sub_1", price: priceId("millionsend_pro_200k_monthly") },
            { id: "si_sub_1_overage", price: priceId("millionsend_pro_200k_overage") },
          ],
          proration_behavior: "create_prorations",
        },
      ],
    ]);
    expect(state.meterEvents).toEqual([]);
    expect(await team(teamId)).toMatchObject({
      plan: "pro",
      planQuota: 200_000,
      stripeOverageItemId: "si_sub_1_overage",
    });
  });

  it("settles usage under the old rung before the move, re-reads Stripe after it, and leaves an upgrade's period row alone", async () => {
    const teamId = await subscribedTeam(withOverage(), 100_500);
    await changeRung(deps(), { teamId, rung: "pro_200k" });
    expect(state.meterEvents.map((e) => e.payload.value)).toEqual(["500"]);
    expect(state.calls.indexOf("billing.meterEvents.create")).toBeLessThan(
      state.calls.indexOf("subscriptions.update"),
    );
    // The row is applied from a fetch taken after the update, not from the pre-move read.
    expect(state.retrieves).toEqual(["sub_1", "sub_1"]);
    expect(state.calls.lastIndexOf("subscriptions.retrieve")).toBeGreaterThan(
      state.calls.indexOf("subscriptions.update"),
    );
    expect(await reportedOverage(teamId)).toBe(500);
    expect(await team(teamId)).toMatchObject({ plan: "pro", planQuota: 200_000 });
  });

  it("a move down counts what the old volume included as already settled", async () => {
    const teamId = await subscribedTeam(
      withOverage("millionsend_pro_200k_monthly", "millionsend_pro_200k_overage"),
      180_000,
    );
    await changeRung(deps(), { teamId, rung: "pro_100k" });
    expect(state.meterEvents).toEqual([]);
    expect(await reportedOverage(teamId)).toBe(80_000);
    expect(await team(teamId)).toMatchObject({ plan: "pro", planQuota: 100_000 });
    // The next overage run has nothing to bill at the new rate.
    expect(await reportOverage(deps(), { teamId })).toEqual({ reported: 0, failed: 0 });
  });

  it("drops the metered item after flushing its usage when moving to a daily rung", async () => {
    const teamId = await subscribedTeam(withOverage(), 100_500);
    await changeRung(deps(), { teamId, rung: "starter" });
    expect(state.meterEvents).toHaveLength(1);
    expect(state.meterEvents[0]?.payload.value).toBe("500");
    expect(state.calls.indexOf("billing.meterEvents.create")).toBeLessThan(
      state.calls.indexOf("subscriptions.update"),
    );
    expect(state.updates[0]?.[1].items).toEqual([
      { id: "si_sub_1", price: priceId("millionsend_starter_monthly") },
      { id: "si_sub_1_overage", deleted: true },
    ]);
    expect(await team(teamId)).toMatchObject({
      plan: "starter",
      planQuota: null,
      stripeOverageItemId: null,
    });
  });

  it("refuses a rung that is not for sale", async () => {
    const teamId = await subscribedTeam(withOverage());
    await expect(changeRung(deps(), { teamId, rung: "free" })).rejects.toThrow("not for sale");
    expect(state.updates).toEqual([]);
  });
});

describe("setOverage", () => {
  it("on adds the rung's metered item and applies it; already on is a no-op", async () => {
    const teamId = await subscribedTeam(subscription("sub_1", "cus_1", "active"));
    await setOverage(deps(), { teamId, enabled: true });
    expect(state.itemCreates).toEqual([
      { subscription: "sub_1", price: priceId("millionsend_pro_100k_overage") },
    ]);
    expect(await team(teamId)).toMatchObject({
      plan: "pro",
      planQuota: 100_000,
      stripeOverageItemId: "si_sub_1_overage",
    });

    await setOverage(deps(), { teamId, enabled: true });
    expect(state.itemCreates).toHaveLength(1);
  });

  it("off flushes unreported usage, removes the item and applies it", async () => {
    const teamId = await subscribedTeam(withOverage(), 100_500);
    await setOverage(deps(), { teamId, enabled: false });
    expect(state.meterEvents.map((e) => e.payload.value)).toEqual(["500"]);
    expect(state.calls.indexOf("billing.meterEvents.create")).toBeLessThan(
      state.calls.indexOf("subscriptionItems.del"),
    );
    expect(state.itemDeletes).toEqual(["si_sub_1_overage"]);
    expect(await team(teamId)).toMatchObject({ plan: "pro", stripeOverageItemId: null });
  });

  it("is refused on a daily plan", async () => {
    const teamId = await subscribedTeam(
      subscription("sub_1", "cus_1", "active", "millionsend_starter_monthly"),
    );
    await expect(setOverage(deps(), { teamId, enabled: true })).rejects.toThrow(
      "monthly plans only",
    );
    expect(state.itemCreates).toEqual([]);
  });
});
