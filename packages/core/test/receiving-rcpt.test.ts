import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INBOX_FLOOD_PER_HOUR } from "../src/inboxes/limits.js";
import { defaultSafety } from "../src/inboxes/safety.js";
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
  opts: { receiving?: boolean; status?: "verified" | "pending"; catchAll?: boolean } = {},
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
      receivingCatchAll: opts.catchAll ?? opts.receiving ?? false,
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
  planStatus: "none",
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

  it("Free: one creator's teams spend one pooled counter, received mail included", async () => {
    const owner = "u-receive-pool";
    const a = await createTeam(db, "free-pool-a", { poolOwnerId: owner });
    const b = await createTeam(db, "free-pool-b", { poolOwnerId: owner });
    const rule = receivingRule(team({ poolOwnerId: owner }), true, NOW);
    await db.insert(schema.freePoolUsage).values({ ownerId: owner, day: DAY, accepted: 148 });
    expect(await chargeReceived(db, { teamId: a, rule, now: NOW })).toBe(true);
    expect(await hasReceivingRoom(db, b, rule, NOW)).toBe(true);
    expect(await chargeReceived(db, { teamId: b, rule, now: NOW })).toBe(true);
    // Each team received one message of its own, yet the pool is at its ceiling.
    expect(await hasReceivingRoom(db, a, rule, NOW)).toBe(false);
    expect(await hasReceivingRoom(db, b, rule, NOW)).toBe(false);
    expect(await chargeReceived(db, { teamId: b, rule, now: NOW })).toBe(false);
    expect([await daily(a), await daily(b)]).toEqual([
      { accepted: 1, received: 1 },
      { accepted: 1, received: 1 },
    ]);
  });

  it("Free: an operator ceiling on a pooled team holds its own day, not the pool's", async () => {
    const owner = "u-receive-ceiling";
    const pooled = await createTeam(db, "free-pool-ceiling", { poolOwnerId: owner });
    const rule = receivingRule(team({ poolOwnerId: owner, dailySendCeiling: 20 }), true, NOW);
    // Another team of the pool spent 50 today, this one nothing.
    await db.insert(schema.freePoolUsage).values({ ownerId: owner, day: DAY, accepted: 50 });
    expect(await hasReceivingRoom(db, pooled, rule, NOW)).toBe(true);
    expect(await chargeReceived(db, { teamId: pooled, rule, now: NOW })).toBe(true);
    await db
      .update(schema.usageCounters)
      .set({ accepted: 20 })
      .where(and(eq(schema.usageCounters.teamId, pooled), eq(schema.usageCounters.day, DAY)));
    expect(await hasReceivingRoom(db, pooled, rule, NOW)).toBe(false);
    expect(await chargeReceived(db, { teamId: pooled, rule, now: NOW })).toBe(false);
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

  it("answers 452 4.2.2 to a Free team whose pool is spent, though its own count is not", async () => {
    const pooled = await createTeam(db, "rcpt-pooled", { poolOwnerId: "u-rcpt-pool" });
    await addDomain(pooled, "in.pooled.test", { receiving: true });
    expect(await decide("agent@in.pooled.test", true)).toMatchObject({ accept: true });
    await db
      .insert(schema.freePoolUsage)
      .values({ ownerId: "u-rcpt-pool", day: DAY, accepted: 150 });
    expect(await decide("agent@in.pooled.test", true)).toMatchObject({
      accept: false,
      code: 452,
      enhanced: "4.2.2",
    });
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
    ).toEqual({
      ok: true,
      changed: true,
      name: "shared.toggle.test",
      receivingEnabled: true,
      receivingEnabledAt: NOW,
    });
    // Idempotent, and the original timestamp stays.
    expect(await setDomainReceiving(db, { teamId: a, domainId: aDomain, enabled: true })).toEqual({
      ok: true,
      changed: false,
      name: "shared.toggle.test",
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
      changed: true,
      name: "shared.toggle.test",
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
          .where(receivedEmailScope({ teamId, domainId, held: "include" }))
      )
        .map((r) => r.id)
        .sort();
    expect(await visible(null)).toEqual([onlyX?.id, both?.id].sort());
    expect(await visible(x)).toEqual([onlyX?.id, both?.id].sort());
    expect(await visible(y)).toEqual([both?.id]);
  });
});

async function addInbox(
  teamId: string,
  values: Partial<typeof schema.inboxes.$inferInsert> & { emailAddress: string },
): Promise<string> {
  const [row] = await db
    .insert(schema.inboxes)
    .values({
      teamId,
      kind: "agent",
      localPart: values.emailAddress.split("@")[0] as string,
      name: "Inbox",
      safety: defaultSafety(values.kind ?? "agent", false),
      ...values,
    })
    .returning({ id: schema.inboxes.id });
  if (!row) throw new Error("inbox insert failed");
  return row.id;
}

describe("decideRecipient with inboxes (S1, S29, S30)", () => {
  let team: string;
  let strictDomain: string;
  let agentInbox: string;

  beforeAll(async () => {
    team = await createTeam(db, "rcpt-inboxes");
    strictDomain = await addDomain(team, "strict.inbox.test", { receiving: true, catchAll: false });
    await addDomain(team, "open.inbox.test", { receiving: true, catchAll: true });
    await addDomain(team, "plain.inbox.test", { receiving: true, catchAll: true });
    agentInbox = await addInbox(team, {
      emailAddress: "bot@strict.inbox.test",
      domainId: strictDomain,
    });
    await addInbox(team, {
      emailAddress: "old@strict.inbox.test",
      domainId: strictDomain,
      expiresAt: new Date(NOW.getTime() - 1000),
    });
    const [openDomain] = await db
      .select({ id: schema.domains.id })
      .from(schema.domains)
      .where(eq(schema.domains.name, "open.inbox.test"));
    await addInbox(team, {
      emailAddress: "desk@open.inbox.test",
      domainId: openDomain?.id ?? null,
      kind: "human",
    });
  });

  const decide = (recipient: string) =>
    decideRecipient(db, { recipient, isCloud: false, now: NOW });

  it("refuses an address with no live inbox where catch-all is off, never cached", async () => {
    for (const recipient of ["nobody@strict.inbox.test", "old@strict.inbox.test"]) {
      expect(await decide(recipient)).toEqual({
        accept: false,
        code: 550,
        enhanced: "5.1.1",
        message: "No such recipient here",
        ttlSeconds: 0,
      });
    }
  });

  it("accepts an inbox address, exactly or by its +tag, without letting the MX cache it", async () => {
    for (const recipient of [
      "bot@strict.inbox.test",
      "BOT@Strict.Inbox.Test",
      "bot+signup@strict.inbox.test",
    ]) {
      expect(await decide(recipient)).toEqual({ accept: true, ttlSeconds: 0 });
    }
  });

  it("accepts any local part on a catch-all domain: cached only while no inbox lives there", async () => {
    expect(await decide("anyone@plain.inbox.test")).toEqual({ accept: true, ttlSeconds: 30 });
    expect(await decide("anyone@open.inbox.test")).toEqual({ accept: true, ttlSeconds: 0 });
    expect(await decide("desk@open.inbox.test")).toEqual({ accept: true, ttlSeconds: 0 });
  });

  it("answers 452 once an inbox took its hourly flood limit, temporary and uncached (S29)", async () => {
    const thread = await db
      .insert(schema.inboxThreads)
      .values({ teamId: team, inboxId: agentInbox })
      .returning({ id: schema.inboxThreads.id });
    const rows = await db
      .insert(schema.receivedEmails)
      .values(
        Array.from({ length: INBOX_FLOOD_PER_HOUR.agent }, (_, i) => ({
          teamId: team,
          domainIds: [strictDomain],
          rawSha256: String(i).padStart(64, "f"),
          messageId: `<f${i}@x>`,
          from: "a@b.example",
          receivedFor: ["bot@strict.inbox.test"],
          envelope: { mailFrom: "", clientIp: "192.0.2.1", helo: "h", tls: null },
          authentication: { spf: "none", dkim: "none", dmarc: "none", arc: "none" },
          sizeBytes: 1,
          createdAt: NOW,
        })),
      )
      .returning({ id: schema.receivedEmails.id });
    await db.insert(schema.receivedEmailInboxes).values(
      rows.map((r) => ({
        receivedEmailId: r.id,
        inboxId: agentInbox,
        teamId: team,
        threadId: thread[0]?.id as string,
        address: "bot@strict.inbox.test",
        senderTrust: "external" as const,
        verdict: "clean" as const,
        createdAt: new Date(NOW.getTime() - 60_000),
      })),
    );
    expect(await decide("bot@strict.inbox.test")).toEqual({
      accept: false,
      code: 452,
      enhanced: "4.2.2",
      message: "This mailbox is receiving too much mail, try again later",
      ttlSeconds: 0,
    });
    // An hour later the window is clear.
    expect(
      await decideRecipient(db, {
        recipient: "bot@strict.inbox.test",
        isCloud: false,
        now: new Date(NOW.getTime() + 3_600_000),
      }),
    ).toMatchObject({ accept: true });
  });

  it("routes a team's shared subdomain and a forwarding inbox's receiving address", async () => {
    const [shared] = await db
      .insert(schema.sharedInboxDomains)
      .values({ teamId: team, name: "team-a.shared.example" })
      .returning({ id: schema.sharedInboxDomains.id });
    await addInbox(team, {
      emailAddress: "signup-bot-7f3k@team-a.shared.example",
      sharedDomainId: shared?.id ?? null,
    });
    await addInbox(team, {
      emailAddress: "support@plain.inbox.test",
      domainId: strictDomain,
      sharedDomainId: shared?.id ?? null,
      receivingAddress: "fwd-1a2b3c4d@team-a.shared.example",
    });
    expect(await decide("signup-bot-7f3k@team-a.shared.example")).toEqual({
      accept: true,
      ttlSeconds: 0,
    });
    expect(await decide("fwd-1a2b3c4d@team-a.shared.example")).toEqual({
      accept: true,
      ttlSeconds: 0,
    });
    // A shared subdomain is never a catch-all.
    expect(await decide("guess@team-a.shared.example")).toMatchObject({ code: 550, ttlSeconds: 0 });
  });

  it("never routes an address to another team's inbox (S2)", async () => {
    const other = await createTeam(db, "rcpt-other");
    await addDomain(other, "other.inbox.test", { receiving: true, catchAll: false });
    // An inbox row pointing at a name another team receives cannot take its mail.
    await addInbox(team, { emailAddress: "spy@other.inbox.test", domainId: strictDomain });
    expect(await decide("spy@other.inbox.test")).toMatchObject({ code: 550, enhanced: "5.1.1" });
  });
});

describe("decideRecipient: the shared domain's postmaster@ and abuse@", () => {
  const SHARED = "agents.example";
  let system: string;

  const decide = (recipient: string, isCloud = false) =>
    decideRecipient(db, { recipient, isCloud, sharedInboxDomain: SHARED, now: NOW });

  const label = async (teamId: string | null, name: string) => {
    const [row] = await db
      .insert(schema.sharedInboxDomains)
      .values({ teamId, name: `${name}.${SHARED}` })
      .returning({ id: schema.sharedInboxDomains.id });
    return row?.id ?? null;
  };

  beforeAll(async () => {
    await label(await createTeam(db, "role-acme"), "acme");
    const suspended = await createTeam(db, "role-suspended");
    await setPlan(suspended, { suspendedAt: NOW, suspensionReason: "manual" });
    await label(suspended, "susp");
    const busy = await createTeam(db, "role-busy");
    await addInbox(busy, {
      emailAddress: `bot-1a2b@busy.${SHARED}`,
      sharedDomainId: await label(busy, "busy"),
    });
    await db.insert(schema.usageCounters).values({ teamId: busy, day: DAY, accepted: 150 });
    // What a deleted team leaves behind.
    await label(null, "gone");
    system = await createTeam(db, "role-system");
  });

  it("refuses role mail with 550 5.1.1 without a System team, and lets the MX cache nothing under the domain", async () => {
    for (const recipient of [
      `postmaster@${SHARED}`,
      `abuse@acme.${SHARED}`,
      `random@${SHARED}`,
      `nobody@ghost.${SHARED}`,
      `nobody@gone.${SHARED}`,
    ]) {
      expect(await decide(recipient)).toEqual({
        accept: false,
        code: 550,
        enhanced: "5.1.1",
        message: "No such recipient here",
        ttlSeconds: 0,
      });
    }
    expect(await decide(`x@susp.${SHARED}`)).toMatchObject({ enhanced: "5.7.1", ttlSeconds: 0 });
    expect(await decide(`bot-1a2b@busy.${SHARED}`, true)).toMatchObject({
      code: 452,
      ttlSeconds: 0,
    });
  });

  it("accepts postmaster@ and abuse@ at any name under the domain for the System team, ahead of the subdomain's team", async () => {
    await setPlan(system, { plan: "system" });
    for (const recipient of [
      `postmaster@${SHARED}`,
      "ABUSE@Agents.Example",
      `Postmaster@acme.${SHARED}`,
      `abuse@susp.${SHARED}`,
      `abuse@busy.${SHARED}`,
      `abuse@gone.${SHARED}`,
      `abuse@ghost.${SHARED}`,
      `abuse@a.b.${SHARED}`,
    ]) {
      expect(await decide(recipient, true)).toEqual({ accept: true, ttlSeconds: 0 });
    }
    for (const recipient of [`abuse+desk@${SHARED}`, `hostmaster@${SHARED}`, `x@gone.${SHARED}`]) {
      expect(await decide(recipient)).toMatchObject({ code: 550, ttlSeconds: 0 });
    }
    expect(await decide("abuse@xagents.example")).toMatchObject({ code: 550, ttlSeconds: 10 });
  });

  it("refuses role mail with 550 5.7.1 while the System team is suspended", async () => {
    await setPlan(system, { suspendedAt: NOW, suspensionReason: "manual" });
    expect(await decide(`abuse@acme.${SHARED}`)).toEqual({
      accept: false,
      code: 550,
      enhanced: "5.7.1",
      message: "Recipient account is not accepting mail",
      ttlSeconds: 0,
    });
  });
});

describe("receivedEmailScope: held mail", () => {
  it("shows agents delivered and catch-all mail only, owners everything, and held mail alone on request", async () => {
    const teamId = await createTeam(db, "scope-held");
    const domainId = await addDomain(teamId, "held.scope.test", {
      receiving: true,
      catchAll: true,
    });
    const inboxId = await addInbox(teamId, { emailAddress: "bot@held.scope.test", domainId });
    const [thread] = await db
      .insert(schema.inboxThreads)
      .values({ teamId, inboxId })
      .returning({ id: schema.inboxThreads.id });
    const row = async (
      name: string,
      values: Partial<typeof schema.receivedEmails.$inferInsert> = {},
    ) => {
      const [inserted] = await db
        .insert(schema.receivedEmails)
        .values({
          teamId,
          domainIds: [domainId],
          rawSha256: name.padEnd(64, "0"),
          messageId: `<${name}@x>`,
          from: "a@b.example",
          receivedFor: ["x@held.scope.test"],
          envelope: { mailFrom: "", clientIp: "192.0.2.1", helo: "h", tls: null },
          authentication: { spf: "none", dkim: "none", dmarc: "none", arc: "none" },
          sizeBytes: 1,
          ...values,
        })
        .returning({ id: schema.receivedEmails.id });
      return inserted?.id as string;
    };
    const member = (
      receivedEmailId: string,
      verdict: "clean" | "pending" | "quarantined",
      delivered: boolean,
    ) =>
      db.insert(schema.receivedEmailInboxes).values({
        receivedEmailId,
        inboxId,
        teamId,
        threadId: thread?.id as string,
        address: "bot@held.scope.test",
        senderTrust: "external",
        verdict,
        deliveredAt: delivered ? NOW : null,
      });
    const catchAll = await row("catchall");
    const virus = await row("virus", { virusVerdict: "fail" });
    const delivered = await row("delivered", { catchAll: false });
    await member(delivered, "clean", true);
    const pending = await row("pending", { catchAll: false });
    await member(pending, "pending", false);
    const held = await row("held", { catchAll: false });
    await member(held, "quarantined", false);
    const ids = async (scope: Parameters<typeof receivedEmailScope>[0]) =>
      (
        await db
          .select({ id: schema.receivedEmails.id })
          .from(schema.receivedEmails)
          .where(receivedEmailScope(scope))
      )
        .map((r) => r.id)
        .sort();
    expect(await ids({ teamId, held: "exclude" })).toEqual([catchAll, delivered].sort());
    expect(await ids({ teamId, held: "include" })).toEqual(
      [catchAll, virus, delivered, pending, held].sort(),
    );
    expect(await ids({ teamId, held: "only" })).toEqual([virus, pending, held].sort());
    expect(await ids({ teamId, inboxId, held: "exclude" })).toEqual([delivered]);
    expect(await ids({ teamId, inboxId, held: "only" })).toEqual([pending, held].sort());
  });
});
