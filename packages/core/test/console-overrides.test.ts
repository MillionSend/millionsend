import { randomBytes } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptEmail } from "../src/accept-email.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { type QuotaTeamRow, teamQuota } from "../src/plans.js";
import { readPeriodUsage, reservePeriodQuota, reserveQuota } from "../src/quota.js";
import { committedDailyVolume } from "../src/team-plan.js";
import { fetchTeamStanding, isTeamSuspended } from "../src/team-standing.js";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const FREE: QuotaTeamRow = {
  plan: "free",
  planQuota: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  overageEnabled: false,
};
const PRO: QuotaTeamRow = { ...FREE, plan: "pro", planQuota: 100_000, overageEnabled: true };

describe("teamQuota with an operator ceiling", () => {
  it("a daily plan takes the lower of the plan limit and the ceiling", () => {
    expect(teamQuota({ ...FREE, dailySendCeiling: 40 }, true)).toEqual({
      kind: "day",
      plan: "free",
      limit: 40,
      dailyCeiling: 40,
    });
    expect(teamQuota({ ...FREE, dailySendCeiling: 500 }, true)).toEqual({
      kind: "day",
      plan: "free",
      limit: 100,
      dailyCeiling: 500,
    });
  });

  it("a monthly plan keeps its period and gains a daily ceiling", () => {
    const quota = teamQuota({ ...PRO, dailySendCeiling: 1_000 }, true);
    expect(quota).toMatchObject({
      kind: "month",
      plan: "pro",
      included: 100_000,
      overage: true,
      dailyCeiling: 1_000,
    });
    expect(teamQuota(PRO, true)).not.toHaveProperty("dailyCeiling");
  });

  it("self-host is capped by the ceiling alone, and by nothing without one", () => {
    expect(teamQuota({ ...FREE, dailySendCeiling: 250 }, false)).toEqual({
      kind: "day",
      plan: "free",
      limit: 250,
      dailyCeiling: 250,
    });
    expect(teamQuota(FREE, false)).toEqual({ kind: "none" });
    expect(teamQuota({ ...FREE, dailySendCeiling: null }, false)).toEqual({ kind: "none" });
  });
});

describe("the ceiling is a hard line", () => {
  it("a daily plan's tolerance never stretches the operator's number", async () => {
    const teamId = await createTeam(db, "hard-day");
    const quota = teamQuota({ ...FREE, dailySendCeiling: 40 }, true);
    const day = "2026-09-11";
    expect(await reserveQuota(db, { teamId, count: 40, quota, day })).toMatchObject({
      reserved: true,
      accepted: 40,
    });
    expect(await reserveQuota(db, { teamId, count: 1, quota, day })).toMatchObject({
      reserved: false,
      accepted: 40,
      ceiling: 40,
    });
  });

  it("a monthly plan's day stops exactly at the ceiling", async () => {
    const teamId = await createTeam(db, "hard-month");
    const quota = teamQuota({ ...PRO, dailySendCeiling: 10 }, true);
    const day = "2026-09-11";
    expect(await reserveQuota(db, { teamId, count: 10, quota, day })).toMatchObject({
      reserved: true,
    });
    expect(await reserveQuota(db, { teamId, count: 1, quota, day })).toMatchObject({
      reserved: false,
      cap: "day",
      ceiling: 10,
    });
  });

  it("committedDailyVolume counts a ceilinged monthly plan at its ceiling", async () => {
    const before = await committedDailyVolume(db);
    const teamId = await createTeam(db, "committed");
    await db
      .update(schema.teams)
      .set({ plan: "pro", planQuota: 100_000, dailySendCeiling: 1_000 })
      .where(eq(schema.teams.id, teamId));
    expect((await committedDailyVolume(db)) - before).toBe(1_000);
  });
});

describe("reservePeriodQuota with a daily ceiling", () => {
  it("refuses at the day, not the period, and leaves the period counter unchanged", async () => {
    const teamId = await createTeam(db, "period-ceiling");
    const periodStart = new Date("2026-09-01T00:00:00Z");
    const day = "2026-09-10";
    const first = await reservePeriodQuota(db, {
      teamId,
      count: 1,
      included: 1_000,
      periodStart,
      overage: false,
      dailyCeiling: 1,
      day,
    });
    expect(first).toEqual({ reserved: true, accepted: 1, ceiling: 1_000 });

    const over = await reservePeriodQuota(db, {
      teamId,
      count: 1,
      included: 1_000,
      periodStart,
      overage: false,
      dailyCeiling: 1,
      day,
    });
    expect(over).toMatchObject({ reserved: false, cap: "day", accepted: 1, ceiling: 1 });
    expect(await readPeriodUsage(db, teamId, periodStart)).toMatchObject({ accepted: 1 });
  });
});

describe("acceptEmail on a monthly plan with a daily ceiling", () => {
  it("parks the send the day refuses instead of refusing it as monthly_quota_exceeded", async () => {
    const teamId = await createTeam(db, "accept-ceiling");
    const [domain] = await db
      .insert(schema.domains)
      .values({ teamId, name: "ceiling.dev", region: "us-east-1", status: "verified" })
      .returning({ id: schema.domains.id });
    if (!domain) throw new Error("domain insert failed");
    const deps = {
      db,
      keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
      isCloud: true,
      enqueueEmailSend: async () => {},
    };
    const auth = { teamId, billing: { ...PRO, dailySendCeiling: 1 }, apiKeyId: null };
    const payload = {
      from: "a@ceiling.dev",
      to: ["r@example.com"],
      subject: "s",
      text: "t",
      domainId: domain.id,
    };

    expect(await acceptEmail(deps, auth, payload)).toMatchObject({ ok: true, parked: false });
    const second = await acceptEmail(deps, auth, payload);
    expect(second).toMatchObject({ ok: true, parked: true });
    if (!second.ok) throw new Error("unreachable");
    const [row] = await db
      .select({ latestStatus: schema.emails.latestStatus })
      .from(schema.emails)
      .where(eq(schema.emails.id, second.id));
    expect(row?.latestStatus).toBe("queued_quota");
    // The period was charged once: the parked send is charged when the drain re-reserves it.
    expect(
      await readPeriodUsage(
        db,
        teamId,
        second.quota.kind === "month" ? second.quota.periodStart : new Date(0),
      ),
    ).toMatchObject({
      accepted: 1,
    });
  });
});

describe("team standing", () => {
  it("isTeamSuspended and fetchTeamStanding read the operator columns", async () => {
    const teamId = await createTeam(db, "standing");
    expect(await isTeamSuspended(db, teamId)).toBe(false);
    expect(await fetchTeamStanding(db, teamId)).toEqual({
      suspended: null,
      broadcastsPausedByOperatorAt: null,
      dailySendCeiling: null,
    });

    const at = new Date("2026-09-14T10:00:00Z");
    await db
      .update(schema.teams)
      .set({
        suspendedAt: at,
        suspensionReason: "reputation",
        suspensionNote: "spiky",
        broadcastsPausedByOperatorAt: at,
        dailySendCeiling: 300,
      })
      .where(eq(schema.teams.id, teamId));
    expect(await isTeamSuspended(db, teamId)).toBe(true);
    expect(await fetchTeamStanding(db, teamId)).toEqual({
      suspended: { at, reason: "reputation", note: "spiky" },
      broadcastsPausedByOperatorAt: at,
      dailySendCeiling: 300,
    });
    expect(await fetchTeamStanding(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
