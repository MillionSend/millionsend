import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveMembership } from "@/server/membership";
import { createCaller } from "@/server/routers";
import { MAX_OWNED_TEAMS_CLOUD } from "@/server/routers/team-bootstrap";
import type { Context } from "@/server/trpc";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

async function insertUser(id: string, email: string): Promise<void> {
  await db.insert(schema.user).values({ id, name: id, email });
}

function callerFor(userId: string, overrides: Partial<Context> = {}) {
  return createCaller({
    db,
    session: { user: { id: userId, email: `${userId}@example.com`, name: userId } },
    teamId: null,
    role: null,
    ...overrides,
  });
}

describe("team.createTeam", () => {
  it("creates the team and an owner membership", async () => {
    await insertUser("u1", "u1@example.com");
    const { teamId } = await callerFor("u1").team.createTeam({ name: "Acme Inc" });

    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(team?.name).toBe("Acme Inc");
    expect(team?.slug).toBe("acme-inc");

    const members = await db
      .select()
      .from(schema.teamMembers)
      .where(eq(schema.teamMembers.teamId, teamId));
    expect(members).toHaveLength(1);
    expect(members[0]?.userId).toBe("u1");
    expect(members[0]?.role).toBe("owner");
  });

  it("suffixes the slug when the name collides", async () => {
    await insertUser("u1", "u1@example.com");
    await insertUser("u2", "u2@example.com");
    const first = await callerFor("u1").team.createTeam({ name: "Acme" });
    const second = await callerFor("u2").team.createTeam({ name: "Acme" });

    expect(second.teamId).not.toBe(first.teamId);
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, second.teamId));
    expect(team?.slug).toMatch(/^acme-[0-9a-f]{6}$/);
  });

  it("creates a second, distinct team for an already-onboarded user", async () => {
    await insertUser("u1", "u1@example.com");
    const { teamId } = await callerFor("u1").team.createTeam({ name: "Acme" });
    const second = await callerFor("u1", { teamId, role: "owner" }).team.createTeam({
      name: "Other",
    });
    expect(second.teamId).not.toBe(teamId);
    const memberships = await db
      .select()
      .from(schema.teamMembers)
      .where(eq(schema.teamMembers.userId, "u1"));
    expect(memberships).toHaveLength(2);
  });

  it("caps owned teams per user on cloud; memberships elsewhere do not count", async () => {
    vi.stubEnv("IS_CLOUD", "true");
    await insertUser("u1", "u1@example.com");
    await insertUser("u2", "u2@example.com");
    const theirs = await callerFor("u2").team.createTeam({ name: "Theirs" });
    await db.insert(schema.teamMembers).values({ teamId: theirs.teamId, userId: "u1" });
    for (let i = 0; i < MAX_OWNED_TEAMS_CLOUD; i++) {
      await callerFor("u1").team.createTeam({ name: `Team ${i}` });
    }
    await expect(callerFor("u1").team.createTeam({ name: "One more" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    vi.stubEnv("IS_CLOUD", "");
    await expect(callerFor("u1").team.createTeam({ name: "Self-host" })).resolves.toBeTruthy();
  });

  it("selects the new team via the cookie setter", async () => {
    await insertUser("u1", "u1@example.com");
    const cookies: string[] = [];
    const { teamId } = await callerFor("u1", {
      setActiveTeamCookie: (id) => cookies.push(id),
    }).team.createTeam({ name: "Acme" });
    expect(cookies).toEqual([teamId]);
  });

  it("rejects unauthenticated callers", async () => {
    const caller = createCaller({ db, session: null, teamId: null, role: null });
    await expect(caller.team.createTeam({ name: "Acme" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("team.switch", () => {
  it("round-trips: sets the cookie and the resolver honors it", async () => {
    await insertUser("u1", "u1@example.com");
    const a = await callerFor("u1").team.createTeam({ name: "Alpha" });
    const b = await callerFor("u1").team.createTeam({ name: "Beta" });

    const cookies: string[] = [];
    await callerFor("u1", { setActiveTeamCookie: (id) => cookies.push(id) }).team.switch({
      teamId: b.teamId,
    });
    expect(cookies).toEqual([b.teamId]);
    expect((await getActiveMembership(db, "u1", b.teamId))?.teamId).toBe(b.teamId);
    expect((await getActiveMembership(db, "u1", a.teamId))?.teamId).toBe(a.teamId);
  });

  it("forbids switching to a team the user is not a member of", async () => {
    await insertUser("u1", "u1@example.com");
    await insertUser("u2", "u2@example.com");
    await callerFor("u1").team.createTeam({ name: "Mine" });
    const theirs = await callerFor("u2").team.createTeam({ name: "Theirs" });

    const cookies: string[] = [];
    await expect(
      callerFor("u1", { setActiveTeamCookie: (id) => cookies.push(id) }).team.switch({
        teamId: theirs.teamId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(cookies).toEqual([]);
  });
});

describe("team.list", () => {
  it("lists all memberships with plan and role plus the active team", async () => {
    await insertUser("u1", "u1@example.com");
    const a = await callerFor("u1").team.createTeam({ name: "Alpha" });
    const b = await callerFor("u1").team.createTeam({ name: "Beta" });

    const result = await callerFor("u1", { teamId: a.teamId, role: "owner" }).team.list();
    expect(result.activeTeamId).toBe(a.teamId);
    expect(result.teams.map((t) => t.teamId)).toEqual([a.teamId, b.teamId]);
    expect(result.teams[0]).toMatchObject({ teamName: "Alpha", plan: "free", role: "owner" });
  });
});

describe("getActiveMembership cookie fallback", () => {
  it("ignores a cookie for a team the user is not a member of", async () => {
    await insertUser("u1", "u1@example.com");
    await insertUser("u2", "u2@example.com");
    const mine = await callerFor("u1").team.createTeam({ name: "Mine" });
    const theirs = await callerFor("u2").team.createTeam({ name: "Theirs" });

    const resolved = await getActiveMembership(db, "u1", theirs.teamId);
    expect(resolved?.teamId).toBe(mine.teamId);
  });

  it("ignores a cookie that references no team at all", async () => {
    await insertUser("u1", "u1@example.com");
    const mine = await callerFor("u1").team.createTeam({ name: "Mine" });
    const resolved = await getActiveMembership(db, "u1", "nonexistent-id");
    expect(resolved?.teamId).toBe(mine.teamId);
  });
});
