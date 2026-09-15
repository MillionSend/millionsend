import { describe, expect, it } from "vitest";
import { createRegionSendControls } from "../src/handlers/ses-regions.js";

type Quota = { max24h: number; sentLast24h: number; maxSendRate: number };

function harness(quotas: Record<string, Quota | Error>, ceiling = 14) {
  const reads: string[] = [];
  const errors: string[] = [];
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
    initialRate: 14,
    replicas: 1,
    onError: (region) => errors.push(region),
  });
  return { controls, reads, errors, quotas };
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
