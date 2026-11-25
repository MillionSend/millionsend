import { randomBytes } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptEmail } from "../src/accept-email.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import {
  claimNewAccountAlerts,
  newAccountCap,
  revokeTeamLimitBypass,
  setTeamLimitBypass,
} from "../src/new-account-limit.js";
import type { QuotaTeamRow } from "../src/plans.js";
import { DAY_MS } from "../src/utc-day.js";

const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const NOW = new Date("2026-03-02T12:00:00Z");

let db: Db;
let close: () => Promise<void>;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db
    .insert(schema.instanceSettings)
    .values({ id: 1, newAccountFirstDay: 10, newAccountDaily: 20, newAccountDays: 3 });
});
afterAll(() => close());
beforeEach(() => {
  vi.stubEnv("IS_CLOUD", "true");
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const PRO: QuotaTeamRow = {
  plan: "pro",
  planQuota: 100_000,
  planStatus: "active",
  currentPeriodStart: new Date(NOW.getTime() - DAY_MS),
  currentPeriodEnd: new Date(NOW.getTime() + 29 * DAY_MS),
  overageEnabled: true,
};

async function newTeam(firstSendAt?: Date): Promise<string> {
  seq += 1;
  const teamId = await createTeam(db, `new-account-${seq}`);
  await db
    .update(schema.teams)
    .set({ plan: "pro", planQuota: 100_000 })
    .where(eq(schema.teams.id, teamId));
  if (firstSendAt) {
    await db.insert(schema.teamMonitor).values({ teamId, sentTotal: 1, firstSendAt });
  }
  return teamId;
}

const recipients = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `r${i}-${tag}@example.com`);
const send = (teamId: string, to: string[]) =>
  acceptEmail(
    { db, keyring, isCloud: true, enqueueEmailSend: async () => {} },
    { teamId, billing: PRO, apiKeyId: null },
    { from: "a@example.com", to, subject: "s", text: "t", domainId: null },
  );
const periodAccepted = async (teamId: string) => {
  const [row] = await db
    .select({ accepted: schema.usagePeriods.accepted })
    .from(schema.usagePeriods)
    .where(eq(schema.usagePeriods.teamId, teamId));
  return row?.accepted ?? 0;
};
const parked = async (teamId: string) => {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.emails)
    .where(and(eq(schema.emails.parkReason, "new_account"), eq(schema.emails.teamId, teamId)));
  return row?.n ?? 0;
};

describe("the new-account limit", () => {
  it("sends its first day's cap, then parks with the plan's units handed back, never refusing", async () => {
    const teamId = await newTeam();
    expect(await send(teamId, recipients(10, "a"))).toMatchObject({ ok: true, parked: false });
    const held = await send(teamId, recipients(1, "b"));
    expect(held).toMatchObject({ ok: true, parked: true, parkReason: "new_account" });
    expect(await periodAccepted(teamId)).toBe(10);
    // Far past any backlog the plan's day would allow, it still parks.
    for (let i = 0; i < 40; i++) {
      expect(await send(teamId, recipients(1, `c${i}`))).toMatchObject({ ok: true, parked: true });
    }
    expect(await parked(teamId)).toBe(41);
  });

  it("lets a first email over the whole cap through alone, then parks what follows", async () => {
    const teamId = await newTeam();
    expect(await send(teamId, recipients(15, "a"))).toMatchObject({ ok: true, parked: false });
    expect(await send(teamId, recipients(1, "b"))).toMatchObject({ parked: true });
    expect(await send(teamId, recipients(15, "c"))).toMatchObject({ parked: true });
  });

  it("counts windows of 24 hours from the first send, then lifts", async () => {
    const day1 = await newTeam(new Date(NOW.getTime() - 1.5 * DAY_MS));
    expect(await newAccountCap(db, { teamId: day1, at: NOW })).toEqual({
      teamId: day1,
      dayIndex: 1,
      cap: 20,
      resetsAt: new Date(NOW.getTime() + 0.5 * DAY_MS),
    });
    expect(await send(day1, recipients(20, "d"))).toMatchObject({ parked: false });
    expect(await send(day1, recipients(1, "e"))).toMatchObject({ parked: true });

    const done = await newTeam(new Date(NOW.getTime() - 3 * DAY_MS));
    expect(await newAccountCap(db, { teamId: done, at: NOW })).toBeNull();
  });

  it("is off on a self-hosted instance, for the system plan, and with both caps at zero", async () => {
    const teamId = await newTeam();
    vi.stubEnv("IS_CLOUD", "false");
    expect(await newAccountCap(db, { teamId, at: NOW })).toBeNull();
    vi.stubEnv("IS_CLOUD", "true");
    await db.update(schema.teams).set({ plan: "system" }).where(eq(schema.teams.id, teamId));
    expect(await newAccountCap(db, { teamId, at: NOW })).toBeNull();
    const other = await newTeam();
    await db.update(schema.instanceSettings).set({ newAccountFirstDay: 0, newAccountDaily: 0 });
    try {
      expect(await newAccountCap(db, { teamId: other, at: NOW })).toBeNull();
    } finally {
      await db.update(schema.instanceSettings).set({ newAccountFirstDay: 10, newAccountDaily: 20 });
    }
  });

  it("is lifted by an operator's bypass until it lapses or is revoked", async () => {
    const teamId = await newTeam();
    await setTeamLimitBypass(db, {
      teamId,
      by: "op",
      reason: "known sender",
      until: new Date(NOW.getTime() + DAY_MS),
      now: NOW,
    });
    expect(await newAccountCap(db, { teamId, at: NOW })).toBeNull();
    expect(
      await newAccountCap(db, { teamId, at: new Date(NOW.getTime() + DAY_MS) }),
    ).not.toBeNull();
    expect(await revokeTeamLimitBypass(db, { teamId, now: NOW })).toMatchObject({
      reason: "known sender",
    });
    expect(await revokeTeamLimitBypass(db, { teamId, now: NOW })).toBeNull();
    expect(await newAccountCap(db, { teamId, at: NOW })).not.toBeNull();
  });

  it("claims each waiting team's operator alert once", async () => {
    const teamId = await newTeam();
    await send(teamId, recipients(10, "f"));
    await send(teamId, recipients(1, "g"));
    const claimed = await claimNewAccountAlerts(db, NOW);
    expect(claimed.map((c) => c.teamId)).toContain(teamId);
    expect((await claimNewAccountAlerts(db, NOW)).map((c) => c.teamId)).not.toContain(teamId);
  });
});
