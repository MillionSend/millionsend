import { describe, expect, it } from "vitest";
import {
  createSesQuotaGate,
  isSesQuotaRefusal,
  isSesThrottle,
  SES_QUOTA_MARGIN,
} from "../src/handlers/ses-quota.js";

describe("SES quota gate", () => {
  it("holds from the margin of the 24-hour quota and reopens with headroom", async () => {
    let quota = { max24h: 50_000, sentLast24h: 10 };
    const gate = createSesQuotaGate(async () => quota);
    expect(gate.exhausted()).toBe(false);
    expect(await gate.refresh()).toBe(false);
    quota = { max24h: 50_000, sentLast24h: Math.ceil(50_000 * SES_QUOTA_MARGIN) };
    expect(await gate.refresh()).toBe(true);
    expect(gate.exhausted()).toBe(true);
    quota = { max24h: 50_000, sentLast24h: 40_000 };
    expect(await gate.refresh()).toBe(false);
  });

  it("keeps the last answer when the read fails, and never holds on an unset quota", async () => {
    let fail = false;
    let quota = { max24h: 100, sentLast24h: 100 };
    const errors: unknown[] = [];
    const gate = createSesQuotaGate(
      async () => {
        if (fail) throw new Error("ses down");
        return quota;
      },
      (err) => errors.push(err),
    );
    expect(await gate.refresh()).toBe(true);
    fail = true;
    expect(await gate.refresh()).toBe(true);
    expect(errors).toHaveLength(1);
    fail = false;
    quota = { max24h: 0, sentLast24h: 0 };
    expect(await gate.refresh()).toBe(false);
  });

  it("tells the daily-quota refusal from a rate refusal by SES's own wording", () => {
    const quota = Object.assign(new Error("Daily message quota exceeded"), {
      name: "TooManyRequestsException",
    });
    const rate = Object.assign(new Error("Maximum sending rate exceeded"), {
      name: "TooManyRequestsException",
    });
    expect(isSesThrottle(quota)).toBe(true);
    expect(isSesThrottle(rate)).toBe(true);
    expect(isSesQuotaRefusal(quota)).toBe(true);
    expect(isSesQuotaRefusal(rate)).toBe(false);
    expect(isSesThrottle(Object.assign(new Error("nope"), { name: "MessageRejected" }))).toBe(
      false,
    );
  });
});
