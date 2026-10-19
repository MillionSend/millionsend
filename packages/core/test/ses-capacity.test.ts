import { describe, expect, it } from "vitest";
import {
  type BroadcastEstimate,
  bulkShare,
  clampReserve,
  type PlanInput,
  pacingHorizonDays,
  planBulkWaves,
  planCaps,
  roundUpToSlot,
  transactionalSent24h,
  usableReserve,
} from "../src/ses-capacity.js";

// Wed 16 Sep 2026 09:14 BRT, an idle window, sa-east-1 at 100k/24h and 14/s
// with ~18k transactional a day; the reserve at its default 30 %.
const START = Date.parse("2026-09-16T12:14:00Z");
const REGION = { share: bulkShare(100_000, 30), rate: 14, txPerDay: 18_000, sentBySlot: [] };

const about = (e: BroadcastEstimate) => roundUpToSlot(e.finishesAt ?? 0).toISOString();
const plan = (broadcasts: PlanInput["broadcasts"], extra: Partial<PlanInput> = {}) =>
  planBulkWaves({ ...REGION, start: START, broadcasts, ...extra });

describe("share arithmetic", () => {
  it("splits the quota and reports what the gate really protects", () => {
    expect(bulkShare(100_000, 30)).toBe(70_000);
    expect(usableReserve(100_000, 30)).toBe(28_000);
    expect(bulkShare(50_000, 30)).toBe(35_000);
    expect(bulkShare(100_000, 80)).toBe(20_000);
    expect(bulkShare(100_000, 55)).toBe(45_000);
    expect(usableReserve(100_000, 80)).toBe(78_000);
    expect(bulkShare(200, 30)).toBe(140);
    expect(bulkShare(-1, 30)).toBe(Number.POSITIVE_INFINITY);
    expect(clampReserve(2)).toBe(5);
    expect(clampReserve(95)).toBe(90);
    expect(pacingHorizonDays(30)).toBe(24);
    expect(pacingHorizonDays(10)).toBe(8);
  });
});

describe("transactionalSent24h", () => {
  // Read live during a burst: SentLast24Hours said 60,645 while our rows already held 69,644 broadcast sends.
  it("counts our own rows while SES's number lags a burst", () => {
    expect(
      transactionalSent24h({ sesSentLast24h: 60_645, allSent24h: 70_844, bulkSent24h: 69_644 }),
    ).toBe(1_200);
  });

  it("keeps SES's number when other senders on the account push it above ours", () => {
    expect(
      transactionalSent24h({ sesSentLast24h: 73_747, allSent24h: 70_844, bulkSent24h: 69_644 }),
    ).toBe(4_103);
  });

  it("with no rows of ours, whatever SES counted is transactional", () => {
    expect(transactionalSent24h({ sesSentLast24h: 250, allSent24h: 0, bulkSent24h: 0 })).toBe(250);
    expect(transactionalSent24h({ sesSentLast24h: 0, allSent24h: 0, bulkSent24h: 0 })).toBe(0);
  });
});

describe("planBulkWaves", () => {
  it("one 170k broadcast: 70k now, the rest in daily waves, done Friday morning", () => {
    const [a] = plan([{ key: "a", admit: 170_000 }]);
    if (!a) throw new Error("no estimate");
    expect(a.first).toBe(70_000);
    expect(a.blocked).toBe(false);
    expect(a.days).toBe(3);
    expect(a.startsAt?.toISOString()).toBe("2026-09-16T12:14:00.000Z");
    // The simulated last row is Fri 18 Sep ≈ 10:26 BRT; the surfaces say "about 10:30".
    expect(about(a)).toBe("2026-09-18T13:30:00.000Z");
    expect(a.releases.reduce((n, r) => n + r.count, 0)).toBe(170_000);
    // Wave 1 fills the share; Thursday's slices start the moment it ages out.
    expect(a.releases[0]?.count).toBe(70_000);
    expect(a.releases[1]?.at.toISOString()).toBe("2026-09-17T12:15:40.000Z");
    expect(a.planHold).toBeNull();
  });

  it("two 170k broadcasts two minutes apart: the second parks whole and both finish over the weekend", () => {
    const [a, b] = plan([
      { key: "a", admit: 170_000 },
      { key: "b", admit: 170_000, at: START + 2 * 60_000 },
    ]);
    if (!a || !b) throw new Error("no estimate");
    expect(a.first).toBe(70_000);
    expect(b.first).toBe(0);
    expect(b.startsAt?.getTime()).toBeGreaterThan(START + 20 * 3_600_000);
    // Round-robin: both share every slice from Thursday, so the first whale
    // finishes Saturday late morning and the second Sunday ≈ 11:41 BRT.
    expect(about(a)).toBe("2026-09-19T14:30:00.000Z");
    expect(about(b)).toBe("2026-09-20T14:45:00.000Z");
    expect(a.days).toBe(4);
    expect(b.days).toBe(5);
  });

  it("one 300k broadcast: five daily waves, done Sunday", () => {
    const [a] = plan([{ key: "a", admit: 300_000 }]);
    if (!a) throw new Error("no estimate");
    expect(a.first).toBe(70_000);
    expect(a.days).toBe(5);
    expect(about(a)).toBe("2026-09-20T13:45:00.000Z");
    expect(a.blocked).toBe(false);
  });

  it("a monthly cap without overage holds rows until the renewal, past the horizon", () => {
    const renews = Date.parse("2026-10-01T00:00:00Z");
    const caps = planCaps(
      {
        kind: "month",
        plan: "pro",
        included: 100_000,
        periodStart: new Date("2026-09-01T00:00:00Z"),
        periodEnd: new Date(renews),
        overage: false,
        overageCentsPer1k: 30,
      },
      { day: 60_000, period: 60_000 },
      START,
    );
    const [a] = plan([{ key: "a", admit: 170_000, caps }]);
    if (!a) throw new Error("no estimate");
    expect(a.first).toBe(40_000);
    expect(a.planHold).toEqual({ heldBack: 130_000, resumesAt: new Date(renews) });
    // 100k more go out in October; the last 30k would wait for November.
    expect(a.blocked).toBe(true);
    // Overage on: nothing holds them but capacity.
    const [withOverage] = plan([
      {
        key: "a",
        admit: 170_000,
        caps: planCaps(
          {
            kind: "month",
            plan: "pro",
            included: 100_000,
            periodStart: new Date("2026-09-01T00:00:00Z"),
            periodEnd: new Date(renews),
            overage: true,
            overageCentsPer1k: 30,
          },
          { day: 60_000, period: 60_000 },
          START,
        ),
      },
    ]);
    expect(withOverage?.blocked).toBe(false);
    expect(withOverage?.planHold).toBeNull();
    expect(withOverage?.days).toBe(3);
  });

  it("a daily cap resets at UTC midnight and names the rows it holds back", () => {
    const caps = planCaps(
      { kind: "day", plan: "starter", limit: 1_500 },
      { day: 750, period: 0 },
      START,
    );
    expect(caps).toEqual([
      {
        remaining: 1_500,
        resetsAt: Date.parse("2026-09-17T00:00:00Z"),
        resetTo: 2_250,
        period: "day",
      },
    ]);
    const [a] = plan([{ key: "a", admit: 5_000, caps }]);
    if (!a) throw new Error("no estimate");
    expect(a.first).toBe(1_500);
    expect(a.planHold).toEqual({ heldBack: 3_500, resumesAt: new Date("2026-09-17T00:00:00Z") });
    expect(a.blocked).toBe(false);
    expect(a.days).toBe(2);
  });

  it("a send behind a full window starts at the first drain that finds room", () => {
    // 70k sent in the last hour: the share is full until they age out.
    const sentBySlot = Array.from({ length: 4 }, (_, i) => ({
      at: START - (4 - i) * 15 * 60_000,
      count: 17_500,
    }));
    const [a] = plan([{ key: "a", admit: 5_000 }], { sentBySlot });
    if (!a) throw new Error("no estimate");
    expect(a.first).toBe(0);
    expect(a.startsAt?.toISOString()).toBe("2026-09-17T11:15:40.000Z");
    expect(a.days).toBe(1);
  });

  it("a wave in flight counts once: what it sent is in the window, what it has not is the queue", () => {
    // 20k queued in the region (a wave in flight) and an idle window: a new
    // 100k send gets 50k now, not 30k.
    const [, a] = plan([
      { key: "other", queued: 20_000 },
      { key: "a", admit: 100_000 },
    ]);
    // The current minute's bucket counts as sent: a few hundred rows of pessimism.
    expect(a?.first).toBeGreaterThan(49_000);
    expect(a?.first).toBeLessThanOrEqual(50_000);
  });

  it("a scheduled send takes the room left after the releases before it", () => {
    // A 300k backlog in flight; a 50k send scheduled two days out starts
    // behind it instead of being handed a full first wave today.
    const [, b] = plan([
      { key: "backlog", queued: 70_000, parked: 230_000 },
      { key: "b", admit: 50_000, at: START + 2 * 24 * 3_600_000 },
    ]);
    if (!b) throw new Error("no estimate");
    expect(b.first).toBe(0);
    expect(b.startsAt?.getTime()).toBeGreaterThan(START + 2 * 24 * 3_600_000);
  });

  it("a throttled team drips one row a second and takes one cadence per slice", () => {
    const [a] = plan([{ key: "a", admit: 2_000, spacingMs: 1_000 }]);
    if (!a) throw new Error("no estimate");
    expect(a.first).toBe(2_000);
    expect(a.finishesAt?.getTime()).toBe(START + 2_000 * 1_000);
  });

  it("an unlimited region never paces", () => {
    const [a] = plan([{ key: "a", admit: 400_000 }], { share: Number.POSITIVE_INFINITY });
    expect(a?.first).toBe(400_000);
    expect(a?.blocked).toBe(false);
  });

  it("refuses past the horizon", () => {
    const [a] = plan([{ key: "a", admit: 2_400_000 }]);
    expect(a?.blocked).toBe(true);
  });

  it("a scheduled send is judged from its own start, not from now", () => {
    const later = START + 23 * 24 * 3_600_000;
    const [a] = plan([{ key: "a", admit: 170_000, at: later }]);
    if (!a) throw new Error("no estimate");
    expect(a.blocked).toBe(false);
    expect(a.first).toBe(70_000);
    expect(a.days).toBe(3);
    expect(a.startsAt?.getTime()).toBe(later);
    // Nothing of it is released before it starts.
    expect(a.releases.every((r) => r.at.getTime() >= later)).toBe(true);
    const [small] = plan([{ key: "b", admit: 4_200, at: START + 3 * 24 * 3_600_000 }]);
    expect(small?.days).toBe(1);
  });
});

describe("window accounting", () => {
  it("keeps every released row in the window until it ages, whatever the rate", () => {
    // A share of three: with a row lost per release the model would release
    // dozens a day; with exact bucketing only three ever fit in a window.
    const [a] = planBulkWaves({
      share: 3,
      rate: 14,
      txPerDay: 0,
      sentBySlot: [],
      start: START,
      broadcasts: [{ key: "a", admit: 100 }],
      horizonDays: 5,
    });
    if (!a) throw new Error("no estimate");
    expect(a.first).toBe(3);
    const sent = a.releases.reduce((n, r) => n + r.count, 0);
    // Three rows a day for five days plus the first wave, no more.
    expect(sent).toBeLessThanOrEqual(3 * 6);
  });
});
