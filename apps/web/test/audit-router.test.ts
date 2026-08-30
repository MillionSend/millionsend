import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TeamRole } from "@/server/membership";
import { createCaller } from "@/server/routers";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

async function addMember(teamId: string, userId: string, role: TeamRole): Promise<void> {
  await db.insert(schema.user).values({ id: userId, name: userId, email: `${userId}@example.com` });
  await db.insert(schema.teamMembers).values({ teamId, userId, role });
}

function callerFor(userId: string, teamId: string, role: TeamRole) {
  return createCaller({
    db,
    session: {
      user: { id: userId, email: `${userId}@example.com`, name: userId },
      session: { id: `s-${userId}`, createdAt: new Date() },
    },
    teamId,
    role,
  });
}

describe("audit.list", () => {
  it("records admin mutations with the acting user and lists them team-scoped, newest first", async () => {
    const teamId = await createTeam(db, "acme");
    const other = await createTeam(db, "other");
    await addMember(teamId, "alice", "owner");
    await addMember(other, "carol", "owner");
    const alice = callerFor("alice", teamId, "owner");

    const { id: keyId } = await alice.apiKeys.create({ name: "CI" });
    await alice.apiKeys.revoke({ id: keyId });
    await callerFor("carol", other, "owner").apiKeys.create({ name: "elsewhere" });

    const page = await alice.audit.list({});
    expect(page.nextCursor).toBeNull();
    expect(page.items).toMatchObject([
      {
        action: "api_key.revoked",
        target: `api_key:${keyId}`,
        actor: { kind: "user", id: "alice", name: "alice", email: "alice@example.com" },
      },
      { action: "api_key.created", target: `api_key:${keyId}`, data: { name: "CI" } },
    ]);
    // Key material never reaches the trail.
    expect(JSON.stringify(page.items)).not.toMatch(/ms_/);
  });

  it("paginates by cursor", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "alice", "owner");
    const alice = callerFor("alice", teamId, "owner");
    for (const name of ["a", "b", "c"]) await alice.apiKeys.create({ name });

    const first = await alice.audit.list({ limit: 2 });
    expect(first.items.map((r) => r.data?.name)).toEqual(["c", "b"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await alice.audit.list({
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((r) => r.data?.name)).toEqual(["a"]);
    expect(second.nextCursor).toBeNull();
  });

  it("is forbidden for members", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "bob", "member");
    await expect(callerFor("bob", teamId, "member").audit.list({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
