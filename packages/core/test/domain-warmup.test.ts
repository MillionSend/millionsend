import { randomBytes } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AcceptEmailPayload, acceptEmail } from "../src/accept-email.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import {
  ageTier,
  graduateWarmupDomains,
  teamWarmupOverview,
  WARMUP_FULL_TIER,
  warmupCap,
} from "../src/domain-warmup.js";
import type { QuotaTeamRow } from "../src/plans.js";
import { DAY_MS } from "../src/utc-day.js";

const HOUR_MS = 3600_000;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));

let db: Db;
let close: () => Promise<void>;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  // The cloud default; the tests' environment is a self-host one.
  await db.insert(schema.instanceSettings).values({ id: 1, warmupEnabled: true });
});
afterAll(() => close());

async function newTeam(over: Partial<typeof schema.teams.$inferInsert> = {}): Promise<string> {
  seq += 1;
  const id = await createTeam(db, `warmup-${seq}`);
  if (Object.keys(over).length > 0) {
    await db.update(schema.teams).set(over).where(eq(schema.teams.id, id));
  }
  return id;
}

async function newDomain(
  teamId: string,
  name: string,
  registeredAt: Date | null,
  over: Partial<typeof schema.domains.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(schema.domains)
    .values({ teamId, name, region: "us-east-1", status: "verified", registeredAt, ...over })
    .returning({ id: schema.domains.id });
  if (!row) throw new Error("domain insert failed");
  return row.id;
}

describe("the schedule", () => {
  const registered = new Date("2026-10-09T09:18:07Z");
  const aged = (ms: number) => new Date(registered.getTime() + ms);

  it("steps at 24 hours, 7 days and 30 days of registration age", () => {
    expect(ageTier(registered, aged(0))).toBe(0);
    expect(ageTier(registered, aged(DAY_MS - 1))).toBe(0);
    expect(ageTier(registered, aged(DAY_MS))).toBe(1);
    expect(ageTier(registered, aged(7 * DAY_MS - 1))).toBe(1);
    expect(ageTier(registered, aged(7 * DAY_MS))).toBe(2);
    expect(ageTier(registered, aged(30 * DAY_MS - 1))).toBe(2);
    expect(ageTier(registered, aged(30 * DAY_MS))).toBe(WARMUP_FULL_TIER);
  });

  it("caps 100, 300 and 2,000 a day, then nothing, and says when full volume starts", async () => {
    const teamId = await newTeam();
    const domainId = await newDomain(teamId, "mail.fresh-launch.com", registered);
    const cap = (ms: number) => warmupCap(db, { teamId, domainId, at: aged(ms) });
    const fullAt = aged(30 * DAY_MS);
    expect(await cap(0)).toEqual({
      key: "fresh-launch.com",
      cap: 100,
      tier: 0,
      fullAt,
      teamId,
      pool: 100,
      poolDomains: 1,
    });
    expect(await cap(DAY_MS - 1)).toMatchObject({ cap: 100 });
    expect(await cap(DAY_MS)).toMatchObject({ cap: 300 });
    expect(await cap(7 * DAY_MS - 1)).toMatchObject({ cap: 300 });
    expect(await cap(7 * DAY_MS)).toMatchObject({ cap: 2000 });
    expect(await cap(30 * DAY_MS - 1)).toMatchObject({ cap: 2000 });
    expect(await cap(30 * DAY_MS)).toBeNull();
  });

  it("takes the caps from the console settings", async () => {
    const teamId = await newTeam();
    const domainId = await newDomain(teamId, "tuned-caps.com", registered);
    await db.update(schema.instanceSettings).set({ warmupCapFirstDay: 20 });
    try {
      expect(await warmupCap(db, { teamId, domainId, at: aged(HOUR_MS) })).toMatchObject({
        cap: 20,
      });
    } finally {
      await db.update(schema.instanceSettings).set({ warmupCapFirstDay: null });
    }
  });

  it("reads an unknown age as the 1-7 day tier for a new team and as no cap for an established one", async () => {
    const now = new Date("2026-10-09T12:00:00Z");
    const fresh = await newTeam();
    const freshDomain = await newDomain(fresh, "brand.de", null, { ageSource: "unknown" });
    expect(await warmupCap(db, { teamId: fresh, domainId: freshDomain, at: now })).toEqual({
      key: "brand.de",
      cap: 300,
      tier: 1,
      fullAt: null,
      teamId: fresh,
      pool: 300,
      poolDomains: 1,
    });

    const settled = await newTeam();
    const settledDomain = await newDomain(settled, "mail.oldbrand.de", null);
    await db.insert(schema.teamMonitor).values({
      teamId: settled,
      sentTotal: 40_000,
      firstSendAt: new Date(now.getTime() - 90 * DAY_MS),
    });
    expect(await warmupCap(db, { teamId: settled, domainId: settledDomain, at: now })).toBeNull();
  });

  it("does not apply with the switch off, to the instance's own team, or to a domain without one", async () => {
    const teamId = await newTeam();
    const domainId = await newDomain(teamId, "switch-test.com", registered);
    const at = aged(HOUR_MS);
    await db.update(schema.instanceSettings).set({ warmupEnabled: false });
    try {
      expect(await warmupCap(db, { teamId, domainId, at })).toBeNull();
    } finally {
      await db.update(schema.instanceSettings).set({ warmupEnabled: true });
    }
    const system = await newTeam({ plan: "system" });
    const systemDomain = await newDomain(system, "instance-mail.com", registered);
    expect(await warmupCap(db, { teamId: system, domainId: systemDomain, at })).toBeNull();
    expect(await warmupCap(db, { teamId, domainId: null, at })).toBeNull();
  });
});

describe("the accept path", () => {
  // The incident's clock: the domain was registered at 09:18:07Z, the team
  // signed up at 09:46Z and sent from about 10:00Z.
  const NOW = new Date("2026-10-09T10:00:00Z");
  const REGISTERED = new Date("2026-10-09T09:18:07Z");
  const enqueued: string[] = [];
  const deps = () => ({
    db,
    keyring,
    isCloud: true,
    enqueueEmailSend: async (id: string) => {
      enqueued.push(id);
    },
  });

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const FREE: QuotaTeamRow = {
    plan: "free",
    planQuota: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    overageEnabled: false,
  };
  const PRO: QuotaTeamRow = {
    plan: "pro",
    planQuota: 100_000,
    currentPeriodStart: new Date(NOW.getTime() - DAY_MS),
    currentPeriodEnd: new Date(NOW.getTime() + 29 * DAY_MS),
    overageEnabled: true,
  };
  const recipients = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => `r${i}-${tag}@example.com`);
  const send = (
    teamId: string,
    billing: QuotaTeamRow,
    domainId: string,
    over: Partial<AcceptEmailPayload> = {},
  ) =>
    acceptEmail(
      deps(),
      { teamId, billing, apiKeyId: null },
      {
        from: "billing@fresh.example",
        to: ["victim@example.com"],
        subject: "s",
        text: "t",
        domainId,
        ...over,
      },
    );
  const rows = (teamId: string) =>
    db
      .select({
        status: schema.emails.latestStatus,
        reason: schema.emails.parkReason,
        n: sql<number>`count(*)::int`,
      })
      .from(schema.emails)
      .where(eq(schema.emails.teamId, teamId))
      .groupBy(schema.emails.latestStatus, schema.emails.parkReason);
  const periodAccepted = async (teamId: string) => {
    const [row] = await db
      .select({ accepted: schema.usagePeriods.accepted })
      .from(schema.usagePeriods)
      .where(eq(schema.usagePeriods.teamId, teamId));
    return row?.accepted ?? 0;
  };

  it("sends up to the domain's cap, then parks with the plan's units handed back", async () => {
    const teamId = await newTeam({ plan: "pro", planQuota: 100_000 });
    const domainId = await newDomain(teamId, "send.cap-test.com", REGISTERED);
    for (let i = 0; i < 4; i++) {
      expect(await send(teamId, PRO, domainId, { to: recipients(25, `a${i}`) })).toMatchObject({
        ok: true,
        parked: false,
      });
    }
    const held = await send(teamId, PRO, domainId);
    expect(held).toMatchObject({ ok: true, parked: true });
    if (!held.ok) throw new Error("unreachable");
    expect(enqueued).not.toContain(held.id);
    expect(await periodAccepted(teamId)).toBe(100);
    expect(await rows(teamId)).toEqual(
      expect.arrayContaining([
        { status: "queued", reason: null, n: 4 },
        { status: "queued_quota", reason: "warmup", n: 1 },
      ]),
    );
  });

  it("counts per registrable domain: the team's old domain still sends, a second team shares the cap", async () => {
    const teamId = await newTeam({ plan: "pro", planQuota: 100_000 });
    const young = await newDomain(teamId, "news.shared-cap.com", REGISTERED);
    const old = await newDomain(teamId, "old-brand.com", new Date("2014-03-01T00:00:00Z"));
    await send(teamId, PRO, young, { to: recipients(50, "y1") });
    await send(teamId, PRO, young, { to: recipients(50, "y2") });
    expect(await send(teamId, PRO, young)).toMatchObject({ ok: true, parked: true });
    expect(await send(teamId, PRO, old, { to: recipients(50, "o") })).toMatchObject({
      ok: true,
      parked: false,
    });

    const other = await newTeam({ plan: "pro", planQuota: 100_000 });
    const sibling = await newDomain(other, "tx.shared-cap.com", REGISTERED);
    expect(await send(other, PRO, sibling)).toMatchObject({ ok: true, parked: true });
  });

  it("is not lifted by buying a plan", async () => {
    const teamId = await newTeam();
    const domainId = await newDomain(teamId, "upgrade-test.com", REGISTERED);
    for (let i = 0; i < 2; i++) {
      await send(teamId, FREE, domainId, { to: recipients(50, `f${i}`) });
    }
    // Free's own ceiling (150 with its tolerance) still has room: the warm-up holds it.
    expect(await send(teamId, FREE, domainId)).toMatchObject({ ok: true, parked: true });
    await db
      .update(schema.teams)
      .set({ plan: "pro", planQuota: 100_000 })
      .where(eq(schema.teams.id, teamId));
    expect(await send(teamId, PRO, domainId)).toMatchObject({ ok: true, parked: true });
    expect(await rows(teamId)).toEqual(
      expect.arrayContaining([{ status: "queued_quota", reason: "warmup", n: 2 }]),
    );
  });

  it("refuses with its own reason once the team's parked backlog is full", async () => {
    const teamId = await newTeam();
    const domainId = await newDomain(teamId, "backlog-test.com", REGISTERED);
    await send(teamId, FREE, domainId, { to: recipients(50, "b1") });
    await send(teamId, FREE, domainId, { to: recipients(50, "b2") });
    // Free's backlog: three days of its 100 a day.
    await db.insert(schema.emails).values(
      Array.from({ length: 299 }, () => ({
        teamId,
        domainId,
        from: "a@backlog-test.com",
        to: ["r@example.com"],
        subject: "s",
        latestStatus: "queued_quota" as const,
        parkReason: "warmup" as const,
      })),
    );
    expect(await send(teamId, FREE, domainId)).toMatchObject({ ok: true, parked: true });
    expect(await send(teamId, FREE, domainId)).toEqual({
      ok: false,
      reason: "warmup_backlog_full",
    });
  });

  it("charges a scheduled send to its delivery day's tier", async () => {
    const teamId = await newTeam({ plan: "pro", planQuota: 100_000 });
    const domainId = await newDomain(teamId, "scheduled-test.com", REGISTERED);
    const scheduledAt = new Date(NOW.getTime() + 2 * DAY_MS);
    expect(
      await send(teamId, PRO, domainId, { to: recipients(50, "s1"), scheduledAt }),
    ).toMatchObject({ ok: true, parked: false });
    expect(
      await send(teamId, PRO, domainId, { to: recipients(50, "s2"), scheduledAt }),
    ).toMatchObject({ ok: true, parked: false });
    // Day 2 is the 1-7 day tier: 300, not the first day's 100.
    expect(
      await send(teamId, PRO, domainId, { to: recipients(50, "s3"), scheduledAt }),
    ).toMatchObject({ ok: true, parked: false });
  });

  it("lets an operator's trust, on the domain or the team, send past the cap", async () => {
    const teamId = await newTeam({ plan: "pro", planQuota: 100_000 });
    const domainId = await newDomain(teamId, "trusted-domain.com", REGISTERED, {
      warmupTrustedAt: NOW,
    });
    for (let i = 0; i < 3; i++) {
      expect(await send(teamId, PRO, domainId, { to: recipients(50, `t${i}`) })).toMatchObject({
        parked: false,
      });
    }
    expect(await warmupCap(db, { teamId, domainId, at: NOW })).toBeNull();

    const trustedTeam = await newTeam({ plan: "pro", planQuota: 100_000, warmupTrustedAt: NOW });
    const teamDomain = await newDomain(trustedTeam, "trusted-team.com", REGISTERED);
    for (let i = 0; i < 3; i++) {
      expect(
        await send(trustedTeam, PRO, teamDomain, { to: recipients(50, `u${i}`) }),
      ).toMatchObject({ parked: false });
    }
  });

  const sentRecipients = async (teamId: string) => {
    const [row] = await db
      .select({ n: sql<number>`coalesce(sum(jsonb_array_length(${schema.emails.to})), 0)::int` })
      .from(schema.emails)
      .where(and(eq(schema.emails.teamId, teamId), eq(schema.emails.latestStatus, "queued")));
    return row?.n ?? 0;
  };

  describe("the team's shared limit", () => {
    it("lets two fresh domains send one day's 100 between them, not 200", async () => {
      const teamId = await newTeam({ plan: "pro", planQuota: 100_000 });
      const a = await newDomain(teamId, "pool-a.com", REGISTERED);
      const b = await newDomain(teamId, "pool-b.com", REGISTERED);
      for (const [i, domainId] of [a, b, a, b].entries()) {
        await send(teamId, PRO, domainId, { to: recipients(50, `p${i}`) });
      }
      expect(await sentRecipients(teamId)).toBe(100);
      expect(await rows(teamId)).toEqual(
        expect.arrayContaining([
          { status: "queued", reason: null, n: 2 },
          { status: "queued_quota", reason: "warmup", n: 2 },
        ]),
      );
      expect((await teamWarmupOverview(db, teamId, NOW)).pool).toEqual({ cap: 100, used: 100 });
    });

    it("lets ten fresh domains send 100 in total on their registration day", async () => {
      const teamId = await newTeam({ plan: "pro", planQuota: 100_000 });
      const domains: string[] = [];
      for (let i = 0; i < 10; i++)
        domains.push(await newDomain(teamId, `burst-${i}.com`, REGISTERED));
      for (const [i, domainId] of domains.entries()) {
        await send(teamId, PRO, domainId, { to: recipients(20, `burst${i}`) });
      }
      expect(await sentRecipients(teamId)).toBe(100);
    });

    it("shares a day-10 domain's 2,000 with a fresh one, which still stops at its own 100", async () => {
      const teamId = await newTeam({ plan: "pro", planQuota: 100_000 });
      const fresh = await newDomain(teamId, "pool-fresh.com", REGISTERED);
      const older = await newDomain(
        teamId,
        "pool-older.com",
        new Date(NOW.getTime() - 10 * DAY_MS),
      );
      expect(await warmupCap(db, { teamId, domainId: fresh, at: NOW })).toMatchObject({
        cap: 100,
        pool: 2000,
        poolDomains: 2,
      });
      await send(teamId, PRO, fresh, { to: recipients(50, "f1") });
      await send(teamId, PRO, fresh, { to: recipients(50, "f2") });
      expect(await send(teamId, PRO, fresh)).toMatchObject({ ok: true, parked: true });
      expect(await send(teamId, PRO, older, { to: recipients(1900, "o") })).toMatchObject({
        parked: false,
      });
      expect(await send(teamId, PRO, older)).toMatchObject({ ok: true, parked: true });
      expect(await sentRecipients(teamId)).toBe(2000);
    });

    it("never holds or counts an old domain", async () => {
      const teamId = await newTeam({ plan: "pro", planQuota: 100_000 });
      const old = await newDomain(teamId, "pool-old.com", new Date("2014-03-01T00:00:00Z"));
      const a = await newDomain(teamId, "pool-young-a.com", REGISTERED);
      const b = await newDomain(teamId, "pool-young-b.com", REGISTERED);
      expect(await send(teamId, PRO, old, { to: recipients(500, "o1") })).toMatchObject({
        parked: false,
      });
      expect(await send(teamId, PRO, a, { to: recipients(50, "a") })).toMatchObject({
        parked: false,
      });
      expect(await send(teamId, PRO, b, { to: recipients(50, "b") })).toMatchObject({
        parked: false,
      });
      expect(await send(teamId, PRO, b)).toMatchObject({ parked: true });
      expect(await send(teamId, PRO, old, { to: recipients(500, "o2") })).toMatchObject({
        parked: false,
      });
      expect(await warmupCap(db, { teamId, domainId: old, at: NOW })).toBeNull();
    });

    it("lets operator trust take a domain, or the team, out of it", async () => {
      const teamId = await newTeam({ plan: "pro", planQuota: 100_000 });
      const a = await newDomain(teamId, "trust-pool-a.com", REGISTERED);
      const b = await newDomain(teamId, "trust-pool-b.com", REGISTERED);
      const c = await newDomain(teamId, "trust-pool-c.com", REGISTERED);
      await send(teamId, PRO, a, { to: recipients(50, "a1") });
      await send(teamId, PRO, a, { to: recipients(50, "a2") });
      expect(await send(teamId, PRO, b)).toMatchObject({ parked: true });
      await db.update(schema.domains).set({ warmupTrustedAt: NOW }).where(eq(schema.domains.id, b));
      expect(await send(teamId, PRO, b, { to: recipients(50, "b") })).toMatchObject({
        parked: false,
      });
      expect(await warmupCap(db, { teamId, domainId: a, at: NOW })).toMatchObject({
        pool: 100,
        poolDomains: 2,
      });
      expect(await send(teamId, PRO, c)).toMatchObject({ parked: true });
      await db
        .update(schema.teams)
        .set({ warmupTrustedAt: NOW })
        .where(eq(schema.teams.id, teamId));
      expect(await send(teamId, PRO, c)).toMatchObject({ parked: false });
    });

    it("is not lifted by buying a plan", async () => {
      const teamId = await newTeam();
      const a = await newDomain(teamId, "upgrade-pool-a.com", REGISTERED);
      const b = await newDomain(teamId, "upgrade-pool-b.com", REGISTERED);
      await send(teamId, FREE, a, { to: recipients(50, "a") });
      await send(teamId, FREE, b, { to: recipients(50, "b") });
      // Free's own ceiling still has room: the shared limit holds it.
      expect(await send(teamId, FREE, a)).toMatchObject({ ok: true, parked: true });
      await db
        .update(schema.teams)
        .set({ plan: "pro", planQuota: 100_000 })
        .where(eq(schema.teams.id, teamId));
      expect(await send(teamId, PRO, b)).toMatchObject({ ok: true, parked: true });
    });

    it("takes in an unknown-age domain of a new team at its 1-7 day cap", async () => {
      const teamId = await newTeam({ plan: "pro", planQuota: 100_000 });
      const fresh = await newDomain(teamId, "pool-known.com", REGISTERED);
      const unknown = await newDomain(teamId, "pool-unknown.de", null, { ageSource: "unknown" });
      expect(await warmupCap(db, { teamId, domainId: fresh, at: NOW })).toMatchObject({
        cap: 100,
        pool: 300,
        poolDomains: 2,
      });
      await send(teamId, PRO, fresh, { to: recipients(50, "k1") });
      await send(teamId, PRO, fresh, { to: recipients(50, "k2") });
      expect(await send(teamId, PRO, unknown, { to: recipients(200, "u") })).toMatchObject({
        parked: false,
      });
      expect(await send(teamId, PRO, unknown)).toMatchObject({ ok: true, parked: true });
    });

    it("charges a send scheduled in the past to today, so no earlier day's limit reopens", async () => {
      const teamId = await newTeam({ plan: "pro", planQuota: 100_000 });
      const a = await newDomain(teamId, "backdate-a.com", REGISTERED);
      const b = await newDomain(teamId, "backdate-b.com", REGISTERED);
      await send(teamId, PRO, a, { to: recipients(50, "a1") });
      await send(teamId, PRO, a, { to: recipients(50, "a2") });
      for (const days of [1, 2, 3]) {
        const scheduledAt = new Date(NOW.getTime() - days * DAY_MS);
        expect(
          await send(teamId, PRO, b, { to: recipients(50, `b${days}`), scheduledAt }),
        ).toMatchObject({ ok: true, parked: true });
      }
      expect(await sentRecipients(teamId)).toBe(100);
    });
  });

  it("replays the incident: 1,074 sends on the registration day, 100 go and 974 wait", async () => {
    const teamId = await newTeam({ plan: "pro", planQuota: 100_000 });
    const domainId = await newDomain(teamId, "incident-replay.com", REGISTERED);
    const refused: string[] = [];
    for (let i = 0; i < 1074; i++) {
      const result = await send(teamId, PRO, domainId, { to: [`victim${i}@example.com`] });
      if (!result.ok) refused.push(result.reason);
    }
    expect(refused).toEqual([]);
    expect(await rows(teamId)).toEqual(
      expect.arrayContaining([
        { status: "queued", reason: null, n: 100 },
        { status: "queued_quota", reason: "warmup", n: 974 },
      ]),
    );
    expect(await periodAccepted(teamId)).toBe(100);
  }, 300_000);
});

describe("early graduation", () => {
  const NOW = new Date("2026-10-09T15:00:00Z");
  // Three days old: the 1-7 day tier by the calendar since NOW - 2 days.
  const REGISTERED = new Date(NOW.getTime() - 3 * DAY_MS);
  // Settled, and a day into the tier: what a step needs behind it.
  const DAY_OLD = new Date(NOW.getTime() - 25 * HOUR_MS);

  async function sent(
    teamId: string,
    domainId: string,
    n: number,
    sentAt: Date,
  ): Promise<string[]> {
    const rows = await db
      .insert(schema.emails)
      .values(
        Array.from({ length: n }, () => ({
          teamId,
          domainId,
          from: "a@graduate.example",
          to: ["r@example.com"],
          subject: "s",
          latestStatus: "delivered" as const,
          sentAt,
        })),
      )
      .returning({ id: schema.emails.id });
    return rows.map((r) => r.id);
  }

  async function verdict(
    teamId: string,
    categories: string[],
    reasons: string[],
    judgedAt = new Date(NOW.getTime() - 2 * HOUR_MS),
  ) {
    await db.insert(schema.monitorSamples).values({
      teamId,
      kind: "first_sends",
      status: "judged",
      score: 92,
      verdict: "abuse",
      categories,
      reasons,
      judgedAt,
    });
  }

  const tierOf = async (domainId: string) =>
    (
      await db
        .select({ tier: schema.domains.warmupTier })
        .from(schema.domains)
        .where(eq(schema.domains.id, domainId))
    )[0]?.tier ?? null;

  it("moves a domain up one tier after 50 clean settled sends, then needs 50 more", async () => {
    const teamId = await newTeam();
    const domainId = await newDomain(teamId, "clean-sender.com", REGISTERED);
    await sent(teamId, domainId, 49, DAY_OLD);
    // Not yet settled: a bounce may still come back.
    await sent(teamId, domainId, 5, new Date(NOW.getTime() - 10 * 60_000));
    expect(await graduateWarmupDomains(db, NOW)).not.toContain("clean-sender.com");

    await sent(teamId, domainId, 1, new Date(NOW.getTime() - 2 * HOUR_MS));
    expect(await graduateWarmupDomains(db, NOW)).toContain("clean-sender.com");
    expect(await tierOf(domainId)).toBe(2);
    expect(await warmupCap(db, { teamId, domainId, at: NOW })).toMatchObject({ cap: 2000 });

    // The next step counts only what was sent since this one, and waits a
    // day into it however clean those sends are.
    await sent(teamId, domainId, 50, new Date(NOW.getTime() + HOUR_MS));
    expect(await graduateWarmupDomains(db, new Date(NOW.getTime() + 3 * HOUR_MS))).not.toContain(
      "clean-sender.com",
    );
    const nextDay = new Date(NOW.getTime() + 26 * HOUR_MS);
    expect(await graduateWarmupDomains(db, nextDay)).toContain("clean-sender.com");
    expect(await warmupCap(db, { teamId, domainId, at: nextDay })).toBeNull();
  });

  it("does not let clean seed sends lift a fresh domain on its registration day", async () => {
    const registered = new Date("2026-10-09T08:00:00Z");
    const at = (hours: number) => new Date(registered.getTime() + hours * HOUR_MS);
    const teamId = await newTeam();
    const domainId = await newDomain(teamId, "seeded-sender.com", registered);
    // Rounds of 50 sends to the sender's own inboxes, each settled before the
    // next cron run: no bounce, no complaint, nothing for the judge to see.
    for (const hour of [1, 3, 5]) {
      await sent(teamId, domainId, 50, at(hour));
      expect(await graduateWarmupDomains(db, at(hour + 1.5))).not.toContain("seeded-sender.com");
    }
    expect(await tierOf(domainId)).toBeNull();
    expect(await warmupCap(db, { teamId, domainId, at: at(7) })).toMatchObject({ cap: 100 });
  });

  it("holds a domain back on a hard bounce rate of 2% or a complaint", async () => {
    const bouncy = await newTeam();
    const bouncyDomain = await newDomain(bouncy, "bouncy-sender.com", REGISTERED);
    const ids = await sent(bouncy, bouncyDomain, 50, DAY_OLD);
    await db.insert(schema.emailEvents).values({
      emailId: ids[0] ?? "",
      type: "bounced",
      bounceType: "Permanent",
      occurredAt: NOW,
    });
    const complainer = await newTeam();
    const complainerDomain = await newDomain(complainer, "spammy-sender.com", REGISTERED);
    const more = await sent(complainer, complainerDomain, 60, DAY_OLD);
    await db
      .insert(schema.emailEvents)
      .values({ emailId: more[0] ?? "", type: "complained", occurredAt: NOW });

    const moved = await graduateWarmupDomains(db, NOW);
    expect(moved).not.toContain("bouncy-sender.com");
    expect(moved).not.toContain("spammy-sender.com");
  });

  it("holds a domain back on a phishing-type verdict, not on other abuse", async () => {
    const phisher = await newTeam();
    const phisherDomain = await newDomain(phisher, "lure-sender.com", REGISTERED);
    await sent(phisher, phisherDomain, 50, DAY_OLD);
    await verdict(phisher, ["phishing_credentials"], ["harvests_secrets"]);
    const lure = await newTeam();
    const lureDomain = await newDomain(lure, "brand-lure.com", REGISTERED);
    await sent(lure, lureDomain, 50, DAY_OLD);
    await verdict(lure, ["other_abuse"], ["impersonation"]);
    const bulk = await newTeam();
    const bulkDomain = await newDomain(bulk, "bulk-sender.com", REGISTERED);
    await sent(bulk, bulkDomain, 50, DAY_OLD);
    await verdict(bulk, ["unsolicited_bulk"], ["unsolicited_bulk"]);
    // Judged on the registration day, before the calendar's step to this
    // tier: still the same sender's intent.
    const early = await newTeam();
    const earlyDomain = await newDomain(early, "first-day-lure.com", REGISTERED);
    await sent(early, earlyDomain, 50, DAY_OLD);
    await verdict(early, ["payment_redirect"], [], new Date(REGISTERED.getTime() + HOUR_MS));

    const moved = await graduateWarmupDomains(db, NOW);
    expect(moved).not.toContain("lure-sender.com");
    expect(moved).not.toContain("brand-lure.com");
    expect(moved).not.toContain("first-day-lure.com");
    expect(moved).toContain("bulk-sender.com");
  });

  it("leaves trusted domains alone and does nothing with the switch off", async () => {
    const teamId = await newTeam();
    const trusted = await newDomain(teamId, "trusted-grad.com", REGISTERED, {
      warmupTrustedAt: NOW,
    });
    await sent(teamId, trusted, 50, DAY_OLD);
    const plain = await newDomain(teamId, "plain-grad.com", REGISTERED);
    await sent(teamId, plain, 50, DAY_OLD);
    await db.update(schema.instanceSettings).set({ warmupEnabled: false });
    try {
      expect(await graduateWarmupDomains(db, NOW)).toEqual([]);
    } finally {
      await db.update(schema.instanceSettings).set({ warmupEnabled: true });
    }
    const moved = await graduateWarmupDomains(db, NOW);
    expect(moved).toContain("plain-grad.com");
    expect(moved).not.toContain("trusted-grad.com");
    expect(
      await db
        .select({ tier: schema.domains.warmupTier })
        .from(schema.domains)
        .where(and(eq(schema.domains.id, trusted))),
    ).toEqual([{ tier: null }]);
  });
});
