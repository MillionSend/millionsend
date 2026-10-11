import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QuotaTeamRow } from "../src/plans.js";
import {
  chargeReceived,
  decideRecipient,
  hasReceivingRoom,
  type ReceivingRule,
  receivedEmailScope,
  receivingRule,
  setDomainReceiving,
} from "../src/receiving/rcpt.js";
import { utcDay } from "../src/utc-day.js";

let db: Db;
let close: () => Promise<void>;
const NOW = new Date("2026-10-11T15:00:00Z");
const DAY = utcDay(NOW);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

async function addDomain(
  teamId: string,
  name: string,
  opts: { receiving?: boolean; status?: "verified" | "pending" } = {},
): Promise<string> {
  const [row] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name,
      region: "us-east-1",
      status: opts.status ?? "verified",
      receivingEnabled: opts.receiving ?? false,
      receivingEnabledAt: opts.receiving ? NOW : null,
    })
    .returning({ id: schema.domains.id });
  if (!row) throw new Error("domain insert failed");
  return row.id;
}

async function setPlan(teamId: string, values: Partial<typeof schema.teams.$inferInsert>) {
  await db.update(schema.teams).set(values).where(eq(schema.teams.id, teamId));
}

async function daily(teamId: string) {
  const [row] = await db
    .select({ accepted: schema.usageCounters.accepted, received: schema.usageCounters.received })
    .from(schema.usageCounters)
    .where(and(eq(schema.usageCounters.teamId, teamId), eq(schema.usageCounters.day, DAY)));
  return row ?? { accepted: 0, received: 0 };
}

const team = (overrides: Partial<QuotaTeamRow> = {}): QuotaTeamRow => ({
  plan: "free",
  planQuota: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  overageEnabled: true,
  dailySendCeiling: null,
  ...overrides,
});

describe("receivingRule (the approved pricing)", () => {
  const periodStart = new Date("2026-10-01T00:00:00Z");
  const periodEnd = new Date("2026-11-01T00:00:00Z");

  it("Free shares the sending day's cap, up to the ceiling sends park at", () => {
    expect(receivingRule(team(), true, NOW)).toMatchObject({ kind: "shared_day", ceiling: 150 });
    // An operator ceiling is a hard line the tolerance never crosses.
    expect(receivingRule(team({ dailySendCeiling: 40 }), true, NOW)).toMatchObject({
      kind: "shared_day",
      ceiling: 40,
    });
  });

  it("Starter gets twice its daily cap, whatever the operator caps sending at", () => {
    expect(receivingRule(team({ plan: "starter" }), true, NOW)).toEqual({
      kind: "day",
      allowance: 3000,
    });
    expect(receivingRule(team({ plan: "starter", dailySendCeiling: 10 }), true, NOW)).toEqual({
      kind: "day",
      allowance: 3000,
    });
  });

  it("monthly plans get twice the volume per period, then bill up to the overage hard cap", () => {
    const pro = team({
      plan: "pro",
      planQuota: 100_000,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    });
    expect(receivingRule(pro, true, NOW)).toEqual({
      kind: "month",
      allowance: 200_000,
      periodStart,
      ceiling: 500_000,
    });
    expect(receivingRule({ ...pro, overageEnabled: false }, true, NOW)).toMatchObject({
      ceiling: 100_000,
    });
  });

  it("never caps self-host or the instance's own team", () => {
    expect(receivingRule(team(), false, NOW)).toEqual({ kind: "none" });
    expect(receivingRule(team({ dailySendCeiling: 5 }), false, NOW)).toEqual({ kind: "none" });
    expect(receivingRule(team({ plan: "system" }), true, NOW)).toEqual({ kind: "none" });
  });

  it("follows a lapsed paid plan down to Free", () => {
    const lapsed = team({ plan: "starter", currentPeriodEnd: new Date("2026-09-01T00:00:00Z") });
    expect(receivingRule(lapsed, true, NOW).kind).toBe("shared_day");
  });
});

describe("chargeReceived", () => {
  it("Free: received mail spends the shared daily counter and stops at its ceiling", async () => {
    const teamId = await createTeam(db, "free-charge");
    const rule = receivingRule(team(), true, NOW);
    await db.insert(schema.usageCounters).values({ teamId, day: DAY, accepted: 149 });
    expect(await hasReceivingRoom(db, teamId, rule, NOW)).toBe(true);
    expect(await chargeReceived(db, { teamId, rule, now: NOW })).toBe(true);
    expect(await daily(teamId)).toEqual({ accepted: 150, received: 1 });
    expect(await hasReceivingRoom(db, teamId, rule, NOW)).toBe(false);
    expect(await chargeReceived(db, { teamId, rule, now: NOW })).toBe(false);
    expect(await daily(teamId)).toEqual({ accepted: 150, received: 1 });
    const hours = await db
      .select({ received: schema.usageCountersHourly.received })
      .from(schema.usageCountersHourly)
      .where(eq(schema.usageCountersHourly.teamId, teamId));
    expect(hours).toEqual([{ received: 1 }]);
  });

  it("Starter: its own allowance, sending untouched", async () => {
    const teamId = await createTeam(db, "starter-charge");
    const rule: ReceivingRule = { kind: "day", allowance: 2 };
    expect(await chargeReceived(db, { teamId, rule, now: NOW })).toBe(true);
    expect(await chargeReceived(db, { teamId, rule, now: NOW })).toBe(true);
    expect(await hasReceivingRoom(db, teamId, rule, NOW)).toBe(false);
    expect(await chargeReceived(db, { teamId, rule, now: NOW })).toBe(false);
    expect(await daily(teamId)).toEqual({ accepted: 0, received: 2 });
  });

  it("monthly: free to the allowance, then one email per ten messages, up to the ceiling", async () => {
    const teamId = await createTeam(db, "month-charge");
    const periodStart = new Date("2026-10-01T00:00:00Z");
    const rule: ReceivingRule = { kind: "month", allowance: 3, periodStart, ceiling: 2 };
    const period = async () => {
      const [row] = await db
        .select({ received: schema.usagePeriods.received, accepted: schema.usagePeriods.accepted })
        .from(schema.usagePeriods)
        .where(eq(schema.usagePeriods.teamId, teamId));
      return row;
    };
    // Sends already spent part of the period; free received mail never touches it.
    await db.insert(schema.usagePeriods).values({ teamId, periodStart, accepted: 1 });
    for (let i = 0; i < 3; i++)
      expect(await chargeReceived(db, { teamId, rule, now: NOW })).toBe(true);
    expect(await period()).toEqual({ received: 3, accepted: 1 });
    // Past the allowance: messages 1-9 are free, the 10th charges one email.
    for (let i = 0; i < 9; i++)
      expect(await chargeReceived(db, { teamId, rule, now: NOW })).toBe(true);
    expect(await period()).toEqual({ received: 12, accepted: 1 });
    expect(await chargeReceived(db, { teamId, rule, now: NOW })).toBe(true);
    expect(await period()).toEqual({ received: 13, accepted: 2 });
    // The period sits at its ceiling: no more received mail past the allowance.
    expect(await hasReceivingRoom(db, teamId, rule, NOW)).toBe(false);
    expect(await chargeReceived(db, { teamId, rule, now: NOW })).toBe(false);
    expect(await period()).toEqual({ received: 13, accepted: 2 });
    expect((await daily(teamId)).received).toBe(13);
  });

  it("monthly: the free allowance holds even when sending is out of quota", async () => {
    const teamId = await createTeam(db, "month-free");
    const periodStart = new Date("2026-10-01T00:00:00Z");
    const rule: ReceivingRule = { kind: "month", allowance: 2, periodStart, ceiling: 5 };
    await db.insert(schema.usagePeriods).values({ teamId, periodStart, accepted: 5 });
    expect(await hasReceivingRoom(db, teamId, rule, NOW)).toBe(true);
    expect(await chargeReceived(db, { teamId, rule, now: NOW })).toBe(true);
    expect(await chargeReceived(db, { teamId, rule, now: NOW })).toBe(true);
    expect(await chargeReceived(db, { teamId, rule, now: NOW })).toBe(false);
  });
});

describe("decideRecipient", () => {
  let acme: string;

  beforeAll(async () => {
    acme = await createTeam(db, "rcpt-acme");
    await addDomain(acme, "inbound.acme.test", { receiving: true });
    await addDomain(acme, "xn--bcher-kva.example", { receiving: true });
    await addDomain(acme, "sending-only.acme.test");
    const suspended = await createTeam(db, "rcpt-suspended");
    await setPlan(suspended, { suspendedAt: NOW, suspensionReason: "manual" });
    await addDomain(suspended, "in.suspended.test", { receiving: true });
  });

  const decide = (recipient: string, isCloud = false) =>
    decideRecipient(db, { recipient, isCloud, now: NOW });

  it("accepts any local part on a receiving domain, by its lowercase ASCII name", async () => {
    for (const recipient of [
      "agent@inbound.acme.test",
      "Anything+Tag@INBOUND.Acme.Test.",
      "user@bücher.example",
    ]) {
      expect(await decide(recipient)).toEqual({ accept: true, ttlSeconds: 30 });
    }
  });

  it("refuses unknown and sending-only domains, and garbage, with 550 5.1.1", async () => {
    for (const recipient of [
      "a@unknown.test",
      "a@sending-only.acme.test",
      "not-an-address",
      "a@inbound.acme.test\r\nRCPT TO:<x@y>",
    ]) {
      expect(await decide(recipient)).toMatchObject({
        accept: false,
        code: 550,
        enhanced: "5.1.1",
        // The sender bounces on it: never cached past a domain switching receiving on.
        ttlSeconds: 10,
      });
    }
  });

  it("refuses a suspended team with 550 5.7.1", async () => {
    expect(await decide("a@in.suspended.test")).toMatchObject({
      accept: false,
      code: 550,
      enhanced: "5.7.1",
    });
  });

  it("answers 452 4.2.2 once the team's receiving allowance is spent", async () => {
    await db.insert(schema.usageCounters).values({ teamId: acme, day: DAY, accepted: 150 });
    expect(await decide("agent@inbound.acme.test", true)).toMatchObject({
      accept: false,
      code: 452,
      enhanced: "4.2.2",
    });
    // Self-host never caps receiving.
    expect(await decide("agent@inbound.acme.test", false)).toMatchObject({ accept: true });
  });
});

describe("setDomainReceiving", () => {
  it("needs a verified domain of the team, and one team per name", async () => {
    const a = await createTeam(db, "toggle-a");
    const b = await createTeam(db, "toggle-b");
    const aDomain = await addDomain(a, "shared.toggle.test");
    const bDomain = await addDomain(b, "shared.toggle.test");
    const pending = await addDomain(a, "pending.toggle.test", { status: "pending" });

    expect(await setDomainReceiving(db, { teamId: b, domainId: aDomain, enabled: true })).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await setDomainReceiving(db, { teamId: a, domainId: pending, enabled: true })).toEqual({
      ok: false,
      reason: "not_verified",
    });
    expect(
      await setDomainReceiving(db, { teamId: a, domainId: aDomain, enabled: true, now: NOW }),
    ).toEqual({ ok: true, receivingEnabled: true, receivingEnabledAt: NOW });
    // Idempotent, and the original timestamp stays.
    expect(await setDomainReceiving(db, { teamId: a, domainId: aDomain, enabled: true })).toEqual({
      ok: true,
      receivingEnabled: true,
      receivingEnabledAt: NOW,
    });
    // The database itself refuses a second team receiving the same name.
    expect(await setDomainReceiving(db, { teamId: b, domainId: bDomain, enabled: true })).toEqual({
      ok: false,
      reason: "taken",
    });
    expect(await setDomainReceiving(db, { teamId: a, domainId: aDomain, enabled: false })).toEqual({
      ok: true,
      receivingEnabled: false,
      receivingEnabledAt: null,
    });
    expect(
      await setDomainReceiving(db, { teamId: b, domainId: bDomain, enabled: true }),
    ).toMatchObject({
      ok: true,
      receivingEnabled: true,
    });
  });
});

describe("receivedEmailScope", () => {
  it("limits a domain-scoped key to mail addressed to its domain", async () => {
    const teamId = await createTeam(db, "scope-team");
    const x = await addDomain(teamId, "x.scope.test", { receiving: true });
    const y = await addDomain(teamId, "y.scope.test", { receiving: true });
    const insert = (domainIds: string[], rawSha256: string) =>
      db
        .insert(schema.receivedEmails)
        .values({
          teamId,
          domainIds,
          rawSha256,
          messageId: "<m@x>",
          from: "a@b.example",
          receivedFor: ["a@x.scope.test"],
          envelope: { mailFrom: "", clientIp: "192.0.2.1", helo: "h", tls: null },
          authentication: { spf: "none", dkim: "none", dmarc: "none", arc: "none" },
          sizeBytes: 1,
        })
        .returning({ id: schema.receivedEmails.id });
    const [onlyX] = await insert([x], "a".repeat(64));
    const [both] = await insert([x, y], "b".repeat(64));
    const visible = async (domainId: string | null) =>
      (
        await db
          .select({ id: schema.receivedEmails.id })
          .from(schema.receivedEmails)
          .where(receivedEmailScope({ teamId, domainId }))
      )
        .map((r) => r.id)
        .sort();
    expect(await visible(null)).toEqual([onlyX?.id, both?.id].sort());
    expect(await visible(x)).toEqual([onlyX?.id, both?.id].sort());
    expect(await visible(y)).toEqual([both?.id]);
  });
});
