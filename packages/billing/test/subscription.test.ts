import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BillingStripe } from "../src/stripe.js";
import { applySubscription, changeRung, setOverage } from "../src/subscription.js";
import {
  fakeStripe,
  legacyProduct,
  PERIOD_END,
  PERIOD_START,
  price,
  priceId,
  schedule,
  subscription,
  teamRow,
} from "./helpers.js";

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
  extra: { schedule?: Stripe.SubscriptionSchedule } = {},
) => subscription("sub_1", "cus_1", "active", lookupKey, { overageKey, ...extra });

/** What the team's one period row says the meter already knows about. */
async function reportedOverage(teamId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ reportedOverage: schema.usagePeriods.reportedOverage })
    .from(schema.usagePeriods)
    .where(eq(schema.usagePeriods.teamId, teamId));
  return row?.reportedOverage;
}

const callOrder = (first: string, second: string) =>
  expect(state.calls.indexOf(first)).toBeLessThan(state.calls.indexOf(second));

describe("changeRung up", () => {
  it("settles usage under the old rung, then re-prices both items at once and re-reads Stripe", async () => {
    const teamId = await subscribedTeam(withOverage(), 100_500);
    expect(await changeRung(deps(), { teamId, rung: "pro_200k" })).toEqual({ applied: "now" });
    expect(state.meterEvents.map((e) => e.payload.value)).toEqual(["500"]);
    callOrder("billing.meterEvents.create", "subscriptions.update");
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
    expect(state.scheduleCreates).toEqual([]);
    // The row is applied from a fetch taken after the update, not from the pre-move read.
    expect(state.retrieves).toEqual(["sub_1", "sub_1"]);
    expect(state.calls.lastIndexOf("subscriptions.retrieve")).toBeGreaterThan(
      state.calls.indexOf("subscriptions.update"),
    );
    // What the old volume included is not re-judged under the new one.
    expect(await reportedOverage(teamId)).toBe(500);
    expect(await team(teamId)).toMatchObject({
      plan: "pro",
      planQuota: 200_000,
      stripeOverageItemId: "si_sub_1_overage",
      pendingRung: null,
    });
  });

  it("drops a pending downgrade before moving up", async () => {
    const teamId = await subscribedTeam(
      withOverage("millionsend_pro_200k_monthly", "millionsend_pro_200k_overage", {
        schedule: schedule([price("millionsend_pro_100k_monthly")]),
      }),
    );
    expect(await team(teamId)).toMatchObject({ planQuota: 200_000, pendingRung: "pro_100k" });
    expect(await changeRung(deps(), { teamId, rung: "scale_500k" })).toEqual({ applied: "now" });
    expect(state.scheduleReleases).toEqual(["sched_0"]);
    callOrder("subscriptionSchedules.release", "subscriptions.update");
    expect(await team(teamId)).toMatchObject({
      plan: "scale",
      planQuota: 500_000,
      pendingRung: null,
    });
  });

  it("adds the metered item to a pre-ladder subscription that has none", async () => {
    const teamId = await subscribedTeam(
      subscription("sub_1", "cus_1", "active", "millionsend_pro_monthly", {
        product: legacyProduct("pro"),
      }),
    );
    expect(await team(teamId)).toMatchObject({ planQuota: 100_000, stripeOverageItemId: null });
    await changeRung(deps(), { teamId, rung: "pro_200k" });
    expect(state.meterEvents).toEqual([]);
    expect(state.updates[0]?.[1].items).toEqual([
      { id: "si_sub_1", price: priceId("millionsend_pro_200k_monthly") },
      { price: priceId("millionsend_pro_200k_overage") },
    ]);
    expect(await team(teamId)).toMatchObject({
      planQuota: 200_000,
      stripeOverageItemId: "si_sub_1_overage",
    });
  });

  it("refuses a rung that is not for sale", async () => {
    const teamId = await subscribedTeam(withOverage());
    await expect(changeRung(deps(), { teamId, rung: "free" })).rejects.toThrow("not for sale");
    expect(state.updates).toEqual([]);
  });
});

describe("changeRung down", () => {
  const pro200k = () => withOverage("millionsend_pro_200k_monthly", "millionsend_pro_200k_overage");

  it("schedules the cheaper rung for the period end and keeps the paid volume until then", async () => {
    const teamId = await subscribedTeam(pro200k(), 180_000);
    expect(await changeRung(deps(), { teamId, rung: "pro_100k" })).toEqual({
      applied: "period_end",
      at: new Date(PERIOD_END * 1000),
    });
    expect(state.updates).toEqual([]);
    expect(state.meterEvents).toEqual([]);
    expect(state.scheduleCreates).toEqual([{ from_subscription: "sub_1" }]);
    expect(state.scheduleUpdates).toEqual([
      [
        "sched_1",
        {
          end_behavior: "release",
          phases: [
            {
              items: [
                { price: priceId("millionsend_pro_200k_monthly"), quantity: 1 },
                { price: priceId("millionsend_pro_200k_overage") },
              ],
              start_date: PERIOD_START,
              end_date: PERIOD_END,
              proration_behavior: "none",
            },
            {
              items: [
                { price: priceId("millionsend_pro_100k_monthly"), quantity: 1 },
                { price: priceId("millionsend_pro_100k_overage") },
              ],
              duration: { interval: "month", interval_count: 1 },
              proration_behavior: "none",
            },
          ],
        },
      ],
    ]);
    expect(await reportedOverage(teamId)).toBe(0);
    expect(await team(teamId)).toMatchObject({
      plan: "pro",
      planQuota: 200_000,
      pendingRung: "pro_100k",
    });
  });

  it("choosing the current rung drops the pending downgrade", async () => {
    const teamId = await subscribedTeam(pro200k());
    await changeRung(deps(), { teamId, rung: "pro_100k" });
    expect(await changeRung(deps(), { teamId, rung: "pro_200k" })).toEqual({
      applied: "unscheduled",
    });
    expect(state.scheduleReleases).toEqual(["sched_1"]);
    expect(state.scheduleCreates).toHaveLength(1);
    expect(state.updates).toEqual([]);
    expect(await team(teamId)).toMatchObject({ planQuota: 200_000, pendingRung: null });

    // Nothing pending: choosing the current rung touches nothing.
    expect(await changeRung(deps(), { teamId, rung: "pro_200k" })).toEqual({
      applied: "unscheduled",
    });
    expect(state.scheduleReleases).toHaveLength(1);
  });

  it("a daily rung's phase carries only the plan price, and a later move reuses the schedule", async () => {
    const teamId = await subscribedTeam(pro200k());
    await changeRung(deps(), { teamId, rung: "pro_100k" });
    await changeRung(deps(), { teamId, rung: "starter" });
    expect(state.scheduleCreates).toHaveLength(1);
    expect(state.scheduleUpdates.map(([id]) => id)).toEqual(["sched_1", "sched_1"]);
    expect(state.scheduleUpdates[1]?.[1].phases?.[1]?.items).toEqual([
      { price: priceId("millionsend_starter_monthly"), quantity: 1 },
    ]);
    expect(await team(teamId)).toMatchObject({ planQuota: 200_000, pendingRung: "starter" });
  });
});

describe("setOverage", () => {
  it("on is a row flag when the metered item is already there", async () => {
    const teamId = await subscribedTeam(withOverage());
    await setOverage(deps(), { teamId, enabled: true });
    expect(state.calls.filter((c) => c !== "subscriptions.retrieve")).toEqual([]);
    expect(await team(teamId)).toMatchObject({
      overageEnabled: true,
      stripeOverageItemId: "si_sub_1_overage",
    });
  });

  it("on adds the rung's metered item to a subscription without one, once", async () => {
    const teamId = await subscribedTeam(subscription("sub_1", "cus_1", "active"));
    await setOverage(deps(), { teamId, enabled: true });
    expect(state.itemCreates).toEqual([
      { subscription: "sub_1", price: priceId("millionsend_pro_100k_overage") },
    ]);
    expect(await team(teamId)).toMatchObject({
      plan: "pro",
      planQuota: 100_000,
      overageEnabled: true,
      stripeOverageItemId: "si_sub_1_overage",
    });

    await setOverage(deps(), { teamId, enabled: true });
    expect(state.itemCreates).toHaveLength(1);
  });

  it("off flushes unreported usage, then flips the flag and leaves the item", async () => {
    const teamId = await subscribedTeam(withOverage(), 100_500);
    await setOverage(deps(), { teamId, enabled: true });
    await setOverage(deps(), { teamId, enabled: false });
    expect(state.meterEvents.map((e) => e.payload.value)).toEqual(["500"]);
    expect(state.itemDeletes).toEqual([]);
    expect(state.updates).toEqual([]);
    expect(await reportedOverage(teamId)).toBe(500);
    expect(await team(teamId)).toMatchObject({
      overageEnabled: false,
      stripeOverageItemId: "si_sub_1_overage",
    });
  });

  it("is refused on a daily plan", async () => {
    const teamId = await subscribedTeam(
      subscription("sub_1", "cus_1", "active", "millionsend_starter_monthly"),
    );
    await expect(setOverage(deps(), { teamId, enabled: true })).rejects.toThrow(
      "monthly plans only",
    );
    expect(state.itemCreates).toEqual([]);
    expect((await team(teamId))?.overageEnabled).toBe(true);
  });
});
