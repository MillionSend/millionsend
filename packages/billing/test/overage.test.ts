import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reportOverage } from "../src/overage.js";
import type { BillingStripe } from "../src/stripe.js";
import { fakeStripe } from "./helpers.js";

const START = new Date("2026-03-01T00:00:00Z");
const END = new Date("2026-04-01T00:00:00Z");
const NOW = new Date("2026-03-15T12:00:00Z");

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

/** A Pro 100k team with one usage row; `overageItem: null` models overage off. */
async function proTeam(
  slug: string,
  opts: {
    accepted: number;
    overageItem?: string | null;
    periodStart?: Date;
    start?: Date;
    end?: Date;
  },
): Promise<string> {
  const teamId = await createTeam(db, slug);
  await db
    .update(schema.teams)
    .set({
      plan: "pro",
      planQuota: 100_000,
      stripeCustomerId: `cus_${slug}`,
      stripeOverageItemId: opts.overageItem === undefined ? `si_${slug}` : opts.overageItem,
      currentPeriodStart: opts.start ?? START,
      currentPeriodEnd: opts.end ?? END,
    })
    .where(eq(schema.teams.id, teamId));
  await db
    .insert(schema.usagePeriods)
    .values({ teamId, periodStart: opts.periodStart ?? START, accepted: opts.accepted });
  return teamId;
}

async function reported(teamId: string, periodStart = START): Promise<number | undefined> {
  const t = schema.usagePeriods;
  const [row] = await db
    .select({ reportedOverage: t.reportedOverage })
    .from(t)
    .where(and(eq(t.teamId, teamId), eq(t.periodStart, periodStart)));
  return row?.reportedOverage;
}

async function setAccepted(teamId: string, accepted: number) {
  await db
    .update(schema.usagePeriods)
    .set({ accepted })
    .where(eq(schema.usagePeriods.teamId, teamId));
}

describe("reportOverage", () => {
  it("meters what is past the included volume once, advancing from the last report", async () => {
    const teamId = await proTeam("acme", { accepted: 100_500 });

    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 1, failed: 0 });
    expect(state.meterEvents).toEqual([
      {
        event_name: "emails_over_quota",
        identifier: `${teamId}:${START.getTime()}:0`,
        timestamp: Math.floor(NOW.getTime() / 1000),
        payload: { stripe_customer_id: "cus_acme", value: "500" },
      },
    ]);
    expect(await reported(teamId)).toBe(500);

    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 0, failed: 0 });
    expect(state.meterEvents).toHaveLength(1);

    await setAccepted(teamId, 101_200);
    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 1, failed: 0 });
    expect(state.meterEvents[1]).toMatchObject({
      identifier: `${teamId}:${START.getTime()}:500`,
      payload: { stripe_customer_id: "cus_acme", value: "700" },
    });
    expect(await reported(teamId)).toBe(1200);
  });

  it("leaves the row for the next run when Stripe fails", async () => {
    const teamId = await proTeam("acme", { accepted: 100_500 });
    state.meterError = new Error("stripe down");
    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 0, failed: 1 });
    expect(await reported(teamId)).toBe(0);

    state.meterError = null;
    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 1, failed: 0 });
    expect(state.meterEvents[0]).toMatchObject({
      identifier: `${teamId}:${START.getTime()}:0`,
      payload: { value: "500" },
    });
    expect(await reported(teamId)).toBe(500);
  });

  it("stamps usage of an ended period one second before the current one began", async () => {
    const previous = new Date("2026-02-01T00:00:00Z");
    const teamId = await proTeam("acme", { accepted: 100_500, periodStart: previous });
    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 1, failed: 0 });
    expect(state.meterEvents[0]).toMatchObject({
      identifier: `${teamId}:${previous.getTime()}:0`,
      timestamp: START.getTime() / 1000 - 1,
      payload: { value: "500" },
    });
    expect(await reported(teamId, previous)).toBe(500);
  });

  it("stamps a row keyed at the recorded period end (renewal webhook not landed) at now", async () => {
    const later = new Date("2026-04-01T06:00:00Z");
    const teamId = await proTeam("acme", { accepted: 100_500, periodStart: END });
    expect(await reportOverage(deps(), { now: later })).toEqual({ reported: 1, failed: 0 });
    expect(state.meterEvents[0]).toMatchObject({
      identifier: `${teamId}:${END.getTime()}:0`,
      timestamp: Math.floor(later.getTime() / 1000),
      payload: { value: "500" },
    });
    expect(await reported(teamId, END)).toBe(500);
  });

  it("skips teams without overage or under their volume, and narrows to one team", async () => {
    const off = await proTeam("off", { accepted: 100_500, overageItem: null });
    const under = await proTeam("under", { accepted: 99_000 });
    const a = await proTeam("a", { accepted: 100_100 });
    const b = await proTeam("b", { accepted: 100_200 });

    expect(await reportOverage(deps(), { now: NOW, teamId: a })).toEqual({
      reported: 1,
      failed: 0,
    });
    expect(state.meterEvents.map((e) => e.payload.stripe_customer_id)).toEqual(["cus_a"]);
    expect(await reported(b)).toBe(0);

    expect(await reportOverage(deps(), { now: NOW })).toEqual({ reported: 1, failed: 0 });
    expect(state.meterEvents.map((e) => e.payload.stripe_customer_id)).toEqual(["cus_a", "cus_b"]);
    expect(await reported(off)).toBe(0);
    expect(await reported(under)).toBe(0);
  });
});
