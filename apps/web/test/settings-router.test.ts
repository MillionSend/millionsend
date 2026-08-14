import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamRole } from "@/server/membership";
import { createCaller } from "@/server/routers";

const DAY_MS = 86_400_000;

// SKIP_ENV_VALIDATION leaves env reads live, so stubbing IS_CLOUD here
// switches the routers between cloud and self-host behavior per test.
function stubCloud(): void {
  vi.stubEnv("IS_CLOUD", "true");
}

function utcDay(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * DAY_MS).toISOString().slice(0, 10);
}

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

async function addMember(teamId: string, userId: string, role: TeamRole): Promise<void> {
  await db.insert(schema.user).values({ id: userId, name: userId, email: `${userId}@example.com` });
  await db.insert(schema.teamMembers).values({ teamId, userId, role });
}

function callerFor(userId: string, teamId: string, role: TeamRole) {
  return createCaller({
    db,
    session: { user: { id: userId, email: `${userId}@example.com`, name: userId } },
    teamId,
    role,
  });
}

describe("settings.team", () => {
  it("get returns name, slug, plan, and the plan's daily limit on cloud", async () => {
    stubCloud();
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "u1", "owner");
    const team = await callerFor("u1", teamId, "owner").settings.team.get();
    expect(team).toEqual({ name: "acme", slug: "acme", plan: "free", planDailyLimit: 100 });
  });

  it("get reports no daily limit on self-host, where the cap is not enforced", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "u1", "owner");
    const team = await callerFor("u1", teamId, "owner").settings.team.get();
    expect(team.planDailyLimit).toBeNull();
  });

  it("rename updates the team for owners", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "u1", "owner");
    await callerFor("u1", teamId, "owner").settings.team.rename({ name: "Acme Corp" });
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(team?.name).toBe("Acme Corp");
  });

  it("rename is forbidden for role member", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "u1", "member");
    await expect(
      callerFor("u1", teamId, "member").settings.team.rename({ name: "Hijacked" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(team?.name).toBe("acme");
  });
});

describe("settings.members", () => {
  it("lists members with user name/email, scoped to the caller's team", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    await addMember(teamA, "alice", "owner");
    await addMember(teamA, "bob", "member");
    await addMember(teamB, "carol", "owner");

    const members = await callerFor("alice", teamA, "owner").settings.members.list();
    expect(members).toEqual([
      { name: "alice", email: "alice@example.com", role: "owner" },
      { name: "bob", email: "bob@example.com", role: "member" },
    ]);
  });
});

describe("settings.usage", () => {
  async function insertCounter(teamId: string, day: string, accepted: number): Promise<void> {
    await db.insert(schema.usageCounters).values({ teamId, day, accepted, delivered: accepted });
  }

  it("returns the window's rows newest-first and today's accepted vs limit", async () => {
    stubCloud();
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "u1", "owner");
    await insertCounter(teamId, utcDay(0), 42);
    await insertCounter(teamId, utcDay(1), 7);
    await insertCounter(teamId, utcDay(16), 99); // outside the default 15-day window

    const usage = await callerFor("u1", teamId, "owner").settings.usage.recent();
    expect(usage.rows.map((r) => [r.day, r.accepted])).toEqual([
      [utcDay(0), 42],
      [utcDay(1), 7],
    ]);
    expect(usage.today).toEqual({ accepted: 42, limit: 100 });
  });

  it("widens the window when days is passed", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "u1", "owner");
    await insertCounter(teamId, utcDay(16), 99);

    const usage = await callerFor("u1", teamId, "owner").settings.usage.recent({ days: 30 });
    expect(usage.rows.map((r) => r.day)).toEqual([utcDay(16)]);
    expect(usage.today.accepted).toBe(0);
  });

  it("reports a null limit for unlimited plans", async () => {
    stubCloud();
    const teamId = await createTeam(db, "acme");
    await db.update(schema.teams).set({ plan: "scale" }).where(eq(schema.teams.id, teamId));
    await addMember(teamId, "u1", "owner");
    const usage = await callerFor("u1", teamId, "owner").settings.usage.recent();
    expect(usage.today.limit).toBeNull();
  });

  it("reports a null limit on self-host even for capped plans", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "u1", "owner");
    const usage = await callerFor("u1", teamId, "owner").settings.usage.recent();
    expect(usage.today.limit).toBeNull();
  });

  it("never returns another team's counters", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    await addMember(teamA, "alice", "owner");
    await addMember(teamB, "carol", "owner");
    await insertCounter(teamB, utcDay(0), 55);

    const usage = await callerFor("alice", teamA, "owner").settings.usage.recent();
    expect(usage.rows).toEqual([]);
    expect(usage.today.accepted).toBe(0);
  });
});
