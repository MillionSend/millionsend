import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCaller } from "@/server/routers";
import type { Context } from "@/server/trpc";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
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

  it("returns the existing team for an already-onboarded user", async () => {
    await insertUser("u1", "u1@example.com");
    const { teamId } = await callerFor("u1").team.createTeam({ name: "Acme" });
    const again = await callerFor("u1", { teamId, role: "owner" }).team.createTeam({
      name: "Other",
    });
    expect(again.teamId).toBe(teamId);
  });

  it("rejects unauthenticated callers", async () => {
    const caller = createCaller({ db, session: null, teamId: null, role: null });
    await expect(caller.team.createTeam({ name: "Acme" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
