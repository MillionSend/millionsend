import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverageInFlightError } from "../src/overage.js";
import type { BillingStripe } from "../src/stripe.js";
import {
  applySubscription,
  cancelAndRefundFraud,
  changeRung,
  setOverage,
} from "../src/subscription.js";
import {
  charge,
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
          proration_behavior: "always_invoice",
          payment_behavior: "pending_if_incomplete",
          expand: ["latest_invoice"],
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

  it("moves nothing while the charge waits on the bank, and hands back the invoice that applies it", async () => {
    const teamId = await subscribedTeam(
      withOverage("millionsend_pro_100k_monthly", "millionsend_pro_100k_overage", {
        schedule: schedule([price("millionsend_starter_monthly")]),
      }),
      450_000,
    );
    state.declineUpdates = true;
    expect(await changeRung(deps(), { teamId, rung: "pro_200k" })).toEqual({
      applied: "payment_required",
      url: "https://invoice.stripe.com/i/in_pending",
    });
    // The overage so far reached the meter under the old rung, for that invoice to bill.
    expect(state.meterEvents.map((e) => e.payload.value)).toEqual(["350000"]);
    // The downgrade went with the request to move up; the volume stays the paid one.
    expect(state.scheduleReleases).toEqual(["sched_0"]);
    expect(await team(teamId)).toMatchObject({
      plan: "pro",
      planQuota: 100_000,
      pendingRung: null,
    });
  });

  it("waits while a step Stripe refused is still pinned, and sends it again on the retry", async () => {
    const teamId = await subscribedTeam(withOverage(), 400_000);
    state.meterError = new Error("Stripe is down");
    await expect(changeRung(deps(), { teamId, rung: "pro_200k" })).rejects.toBeInstanceOf(
      OverageInFlightError,
    );
    expect(state.updates).toEqual([]);
    expect(await reportedOverage(teamId)).toBe(0);

    state.meterError = null;
    expect(await changeRung(deps(), { teamId, rung: "pro_200k" })).toEqual({ applied: "now" });
    expect(state.meterEvents.map((e) => e.payload.value)).toEqual(["300000"]);
    expect(await reportedOverage(teamId)).toBe(300_000);
  });

  it("waits while Stripe has not counted a large overage step, and moves nothing", async () => {
    const teamId = await subscribedTeam(
      withOverage("millionsend_pro_100k_monthly", "millionsend_pro_100k_overage", {
        schedule: schedule([price("millionsend_starter_monthly")]),
      }),
      400_000,
    );
    state.meterCounted = 0;
    await expect(changeRung(deps(), { teamId, rung: "pro_200k" })).rejects.toBeInstanceOf(
      OverageInFlightError,
    );
    // The burst reached the meter, but nothing re-priced it and the downgrade stands.
    expect(state.meterEvents.map((e) => e.payload.value)).toEqual(["300000"]);
    expect(state.summaryParams[0]?.[0]).toBe("mtr_1");
    expect(state.summaryParams[0]?.[1]).toMatchObject({ customer: "cus_1" });
    expect(state.updates).toEqual([]);
    expect(state.scheduleReleases).toEqual([]);
    expect(await team(teamId)).toMatchObject({ planQuota: 100_000, pendingRung: "starter" });

    // Once counted, the same move goes through.
    state.meterCounted = null;
    expect(await changeRung(deps(), { teamId, rung: "pro_200k" })).toEqual({ applied: "now" });
  });

  it("lets a small uncounted step through: it is at most a minute of overage", async () => {
    const teamId = await subscribedTeam(withOverage(), 100_900);
    state.meterCounted = 0;
    expect(await changeRung(deps(), { teamId, rung: "pro_200k" })).toEqual({ applied: "now" });
    expect(state.calls).not.toContain("billing.meters.listEventSummaries");
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

describe("cancelAndRefundFraud", () => {
  const NOW = new Date("2026-10-11T12:00:00Z");
  const ago = (days: number) => Math.floor(NOW.getTime() / 1000) - days * 86_400;
  const refunded = () => state.refunds.map(([params]) => params.charge);

  it("cancels at once, then refunds each payment of the last 120 days in full as fraud under its own key", async () => {
    const teamId = await subscribedTeam(withOverage(), 100_500);
    state.charges = [
      charge("ch_old", "cus_1", ago(119), { amount: 900 }),
      charge("ch_new", "cus_1", ago(2)),
      charge("ch_stale", "cus_1", ago(121)),
      charge("ch_elsewhere", "cus_2", ago(1)),
    ];
    expect(await cancelAndRefundFraud(deps(), teamId, NOW)).toEqual({
      canceled: "sub_1",
      refunds: [
        { charge: "ch_new", amount: 2000, currency: "usd" },
        { charge: "ch_old", amount: 900, currency: "usd" },
      ],
      failed: null,
    });
    expect(state.cancels).toEqual(["sub_1"]);
    // No final invoice: its charge would land after the refunds, on the same card.
    expect(state.cancelParams).toEqual({ invoice_now: false, prorate: false });
    expect(state.meterEvents).toEqual([]);
    callOrder("subscriptions.cancel", "charges.list");
    expect(state.chargeListParams).toEqual({
      customer: "cus_1",
      created: { gte: ago(120) },
      limit: 100,
    });
    expect(state.refunds).toEqual([
      [{ charge: "ch_new", reason: "fraudulent" }, { idempotencyKey: "fraud-refund:ch_new" }],
      [{ charge: "ch_old", reason: "fraudulent" }, { idempotencyKey: "fraud-refund:ch_old" }],
    ]);
    expect(await team(teamId)).toMatchObject({
      plan: "free",
      planQuota: null,
      planStatus: "canceled",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: null,
    });
  });

  it("leaves disputed, refunded and failed payments alone, and returns the rest of a partly refunded one", async () => {
    const teamId = await subscribedTeam(withOverage());
    state.charges = [
      charge("ch_disputed", "cus_1", ago(10), { disputed: true }),
      charge("ch_refunded", "cus_1", ago(20), { amount_refunded: 2000, refunded: true }),
      charge("ch_failed", "cus_1", ago(30), { status: "failed" }),
      charge("ch_partly", "cus_1", ago(40), { amount_refunded: 500 }),
    ];
    const { refunds, failed } = await cancelAndRefundFraud(deps(), teamId, NOW);
    expect(refunds).toEqual([{ charge: "ch_partly", amount: 1500, currency: "usd" }]);
    expect(refunded()).toEqual(["ch_partly"]);
    expect(failed).toBeNull();
  });

  it("returns a Stripe failure with what was done before it, and a retry never refunds twice", async () => {
    const teamId = await subscribedTeam(withOverage());
    state.charges = [charge("ch_a", "cus_1", ago(1)), charge("ch_b", "cus_1", ago(2))];
    state.refundErrors.ch_b = new Error("Stripe is down");
    expect(await cancelAndRefundFraud(deps(), teamId, NOW)).toEqual({
      canceled: "sub_1",
      refunds: [{ charge: "ch_a", amount: 2000, currency: "usd" }],
      failed: "Error: Stripe is down",
    });

    delete state.refundErrors.ch_b;
    expect(await cancelAndRefundFraud(deps(), teamId, NOW)).toEqual({
      canceled: null,
      refunds: [{ charge: "ch_b", amount: 2000, currency: "usd" }],
      failed: null,
    });
    expect(refunded()).toEqual(["ch_a", "ch_b"]);
    expect(state.cancels).toEqual(["sub_1"]);
  });

  it("refunds nothing when the cancel fails", async () => {
    const teamId = await createTeam(db);
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_gone", plan: "pro" })
      .where(eq(schema.teams.id, teamId));
    state.charges = [charge("ch_a", "cus_1", ago(1))];
    expect(await cancelAndRefundFraud(deps(), teamId, NOW)).toEqual({
      canceled: null,
      refunds: [],
      failed: "Error: No such subscription: sub_gone",
    });
    expect(state.calls).not.toContain("charges.list");
    expect((await team(teamId))?.plan).toBe("pro");
  });

  it("touches nothing in Stripe for a team that never had a customer", async () => {
    const teamId = await createTeam(db);
    expect(await cancelAndRefundFraud(deps(), teamId, NOW)).toEqual({
      canceled: null,
      refunds: [],
      failed: null,
    });
    expect(state.calls).toEqual([]);
  });
});
