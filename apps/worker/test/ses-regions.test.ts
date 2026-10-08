import { describe, expect, it } from "vitest";
import { createRegionSendControls } from "../src/handlers/ses-regions.js";

type Quota = { max24h: number; sentLast24h: number; maxSendRate: number };

function harness(
  quotas: Record<string, Quota | Error>,
  ceiling = 14,
  pacing: {
    counts?: Record<string, { sent24h: number; queued: number }> | Error;
    paused?: string[];
    reserve?: number;
  } = {},
) {
  const reads: string[] = [];
  const errors: string[] = [];
  let counted = 0;
  const controls = createRegionSendControls({
    regions: Object.keys(quotas),
    read: async (region) => {
      reads.push(region);
      const quota = quotas[region];
      if (quota instanceof Error) throw quota;
      if (!quota) throw new Error(`unexpected region ${region}`);
      return quota;
    },
    ceiling: async () => ceiling,
    ...(pacing.counts !== undefined
      ? {
          counts: async () => {
            counted += 1;
            if (pacing.counts instanceof Error) throw pacing.counts;
            return new Map(Object.entries(pacing.counts ?? {}));
          },
          paused: async () => new Set(pacing.paused ?? []),
          reserve: async () => pacing.reserve ?? 30,
        }
      : {}),
    initialRate: 14,
    replicas: 1,
    onError: (region) => errors.push(region),
  });
  return { controls, reads, errors, quotas, pacing, counted: () => counted };
}

const production: Quota = { max24h: 50_000, sentLast24h: 10, maxSendRate: 14 };
const sandboxFull: Quota = { max24h: 200, sentLast24h: 199, maxSendRate: 1 };

describe("per-region send controls", () => {
  it("gates each region on its own 24-hour quota, one probe per region", async () => {
    const h = harness({ "sa-east-1": production, "us-east-1": sandboxFull });
    await h.controls.refreshAll();
    expect(h.reads).toEqual(["sa-east-1", "us-east-1"]);
    expect(h.controls.exhausted("sa-east-1")).toBe(false);
    expect(h.controls.exhausted("us-east-1")).toBe(true);
    // No region (platform mail) and an unserved region read the default region's gate.
    expect(h.controls.exhausted()).toBe(false);
    expect(h.controls.exhausted("eu-west-1")).toBe(false);
    expect(h.controls.regions).toEqual(["sa-east-1", "us-east-1"]);
  });

  it("refresh(region) re-probes only that region", async () => {
    const h = harness({ "sa-east-1": production, "us-east-1": sandboxFull });
    h.quotas["us-east-1"] = { ...sandboxFull, sentLast24h: 0 };
    expect(await h.controls.refresh("us-east-1")).toBe(false);
    expect(h.reads).toEqual(["us-east-1"]);
  });

  it("a failed probe keeps the region's last answer and never blocks the others", async () => {
    const h = harness({ "sa-east-1": production, "us-east-1": sandboxFull });
    await h.controls.refreshAll();
    h.quotas["us-east-1"] = new Error("ses down");
    await h.controls.refreshAll();
    expect(h.controls.exhausted("us-east-1")).toBe(true);
    expect(h.controls.exhausted("sa-east-1")).toBe(false);
    expect(h.errors).toEqual(["us-east-1"]);
  });

  it("paces each bucket at the lower of the region's MaxSendRate and the ceiling", async () => {
    const h = harness(
      { fast: { ...production, maxSendRate: 1000 }, slow: { ...production, maxSendRate: 1 } },
      1000,
    );
    await h.controls.refreshAll();
    // 1000/s: ten tokens refill almost at once.
    let start = Date.now();
    for (let i = 0; i < 10; i++) await h.controls.throttle("fast");
    expect(Date.now() - start).toBeLessThan(2000);
    // 1/s: the first token is free, the second waits a full second.
    start = Date.now();
    await h.controls.throttle("slow");
    await h.controls.throttle("slow");
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
  });

  it("the ceiling caps a region whose account rate is higher", async () => {
    const h = harness({ fast: { ...production, maxSendRate: 1000 } }, 2);
    await h.controls.refreshAll();
    const start = Date.now();
    for (let i = 0; i < 3; i++) await h.controls.throttle("fast");
    // 2/s: two free tokens, the third waits half a second.
    expect(Date.now() - start).toBeGreaterThanOrEqual(400);
  });
});

const R = "sa-east-1";

describe("the broadcast share and its room ledger", () => {
  it("splits the quota by the reserve and reads the bulk volume off the count", async () => {
    const h = harness({ [R]: { max24h: 100_000, sentLast24h: 12_000, maxSendRate: 14 } }, 14, {
      counts: { [R]: { sent24h: 10_000, queued: 5_000 } },
    });
    await h.controls.refreshAll();
    expect(h.controls.reserve()).toBe(30);
    expect(h.controls.share(R)).toBe(70_000);
    expect(h.controls.capacity(R)).toEqual({
      max24h: 100_000,
      sentLast24h: 12_000,
      maxSendRate: 14,
    });
    expect(h.controls.rate(R)).toBe(14);
    expect(h.controls.bulkSent24h(R)).toBe(10_000);
    expect(h.controls.room(R)).toBe(55_000);
    expect(h.controls.bulkExhausted(R)).toBe(false);
    expect(h.controls.paused(R)).toBe(false);
    // Between counts the send lane and the drain keep the room honest.
    h.controls.noteBulkSent(R);
    h.controls.noteBulkQueued(R, 999);
    expect(h.controls.bulkSent24h(R)).toBe(10_001);
    expect(h.controls.room(R)).toBe(54_000);
    expect(h.controls.txParkedAt(R)).toBeNull();
    h.controls.noteTransactionalParked(R);
    expect(h.controls.txParkedAt(R)).toBeInstanceOf(Date);
  });

  it("two concurrent walks never share one room, and a grant holds until the count sees its rows", async () => {
    const h = harness({ [R]: { max24h: 100_000, sentLast24h: 10_000, maxSendRate: 14 } }, 14, {
      counts: { [R]: { sent24h: 10_000, queued: 0 } },
    });
    await h.controls.refreshAll();
    expect(h.controls.take(R, "a", 50_000)).toBe(50_000);
    expect(h.controls.take(R, "b", 50_000)).toBe(10_000);
    expect(h.controls.room(R)).toBe(0);
    // Rows a walk has written stay held until a count has seen them.
    h.controls.progress("a", 20_000);
    expect(h.controls.room(R)).toBe(0);
    h.pacing.counts = { [R]: { sent24h: 10_000, queued: 20_000 } };
    await h.controls.recount();
    expect(h.controls.room(R)).toBe(0);
    // A finished walk releases what it never wrote, once the next count runs.
    h.controls.done("a");
    expect(h.controls.room(R)).toBe(0);
    await h.controls.recount();
    expect(h.controls.room(R)).toBe(30_000);
    expect(h.controls.take(R, "c", 100_000)).toBe(30_000);
  });

  it("counts every fifth tick, holds a region at its share or at the total, and honours a hold", async () => {
    const h = harness({ [R]: { max24h: 100_000, sentLast24h: 71_000, maxSendRate: 14 } }, 14, {
      counts: { [R]: { sent24h: 70_000, queued: 0 } },
      paused: [],
    });
    for (let i = 0; i < 6; i++) await h.controls.refreshAll();
    expect(h.counted()).toBe(2);
    expect(h.controls.bulkExhausted(R)).toBe(true);
    expect(h.controls.exhausted(R)).toBe(false);
    expect(h.controls.room(R)).toBe(0);
    h.pacing.counts = { [R]: { sent24h: 60_000, queued: 0 } };
    h.pacing.paused = [R];
    await h.controls.recount();
    expect(h.controls.bulkExhausted(R)).toBe(false);
    expect(h.controls.paused(R)).toBe(true);
    // At the total every class holds and the room is nil.
    h.quotas[R] = { max24h: 100_000, sentLast24h: 98_500, maxSendRate: 14 };
    await h.controls.refresh(R);
    expect(h.controls.exhausted(R)).toBe(true);
    expect(h.controls.bulkExhausted(R)).toBe(true);
    expect(h.controls.room(R)).toBe(0);
  });

  it("closes bulk only until the first count succeeds; a later failure keeps the last counts", async () => {
    const h = harness({ [R]: production }, 14, { counts: new Error("db down") });
    await h.controls.refreshAll();
    expect(h.counted()).toBe(3);
    expect(h.controls.bulkExhausted(R)).toBe(true);
    expect(h.controls.room(R)).toBe(0);
    h.pacing.counts = { [R]: { sent24h: 1_000, queued: 0 } };
    await h.controls.recount();
    expect(h.controls.bulkExhausted(R)).toBe(false);
    expect(h.controls.room(R)).toBe(34_000);
    h.pacing.counts = new Error("db down again");
    await h.controls.recount();
    expect(h.controls.bulkExhausted(R)).toBe(false);
    expect(h.controls.room(R)).toBe(34_000);
  });

  it("a walk that takes again keeps only the rows it wrote, until a count sees them", async () => {
    const h = harness({ [R]: { max24h: 100_000, sentLast24h: 10_000, maxSendRate: 14 } }, 14, {
      counts: { [R]: { sent24h: 10_000, queued: 0 } },
    });
    await h.controls.refreshAll();
    expect(h.controls.take(R, "a", 170_000)).toBe(60_000);
    h.controls.progress("a", 30_000);
    // A retry in the same process: the earlier grant holds its 30,000 rows,
    // not the 30,000 it never wrote.
    expect(h.controls.take(R, "a", 170_000)).toBe(30_000);
    expect(h.controls.room(R)).toBe(0);
    expect(h.controls.take(R, "b", 1_000)).toBe(0);
    h.pacing.counts = { [R]: { sent24h: 10_000, queued: 30_000 } };
    await h.controls.recount();
    expect(h.controls.room(R)).toBe(0);
  });

  it("rows written while a count runs stay on the ledger until the next count", async () => {
    let gate: Promise<Map<string, { sent24h: number; queued: number }>> | null = null;
    let release: () => void = () => {};
    const controls = createRegionSendControls({
      regions: [R],
      read: async () => ({ max24h: 100_000, sentLast24h: 10_000, maxSendRate: 14 }),
      ceiling: async () => 14,
      reserve: async () => 30,
      paused: async () => new Set(),
      counts: () => gate ?? Promise.resolve(new Map([[R, { sent24h: 10_000, queued: 0 }]])),
      initialRate: 14,
      replicas: 1,
    });
    await controls.refreshAll();
    expect(controls.take(R, "a", 170_000)).toBe(60_000);
    controls.progress("a", 20_000);
    gate = new Promise((resolve) => {
      release = () => resolve(new Map([[R, { sent24h: 10_000, queued: 20_000 }]]));
    });
    const recount = controls.recount();
    // Three more pages commit while the count runs; the count did not see them.
    controls.progress("a", 20_300);
    release();
    await recount;
    expect(controls.room(R)).toBe(0);
  });

  it("an unlimited quota never paces", async () => {
    const h = harness({ [R]: { max24h: -1, sentLast24h: 500_000, maxSendRate: 100 } }, 100, {
      counts: new Error("never"),
    });
    await h.controls.refreshAll();
    expect(h.controls.share(R)).toBe(Number.POSITIVE_INFINITY);
    expect(h.controls.room(R)).toBe(Number.POSITIVE_INFINITY);
    expect(h.controls.bulkExhausted(R)).toBe(false);
    expect(h.controls.take(R, "w", 1_000_000)).toBe(1_000_000);
  });
});
