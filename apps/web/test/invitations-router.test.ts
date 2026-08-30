import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamRole } from "@/server/membership";
import { createCaller } from "@/server/routers";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  // signInviteToken/verifyInviteToken HMAC over this secret.
  vi.stubEnv("BETTER_AUTH_SECRET", "test-invite-secret");
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

async function createUser(userId: string): Promise<void> {
  await db.insert(schema.user).values({ id: userId, name: userId, email: `${userId}@example.com` });
}

async function addMember(teamId: string, userId: string, role: TeamRole): Promise<void> {
  await createUser(userId);
  await db.insert(schema.teamMembers).values({ teamId, userId, role });
}

function callerFor(userId: string, teamId: string | null, role: TeamRole | null) {
  return createCaller({
    db,
    session: { user: { id: userId, email: `${userId}@example.com`, name: userId } },
    teamId,
    role,
  });
}

/** The signed token the accept page receives, pulled from the returned link. */
function tokenFromUrl(acceptUrl: string): string {
  const token = acceptUrl.split("/invite/")[1];
  if (!token) throw new Error(`no token in ${acceptUrl}`);
  return token;
}

describe("settings.invitations.create", () => {
  it("owner and admin can invite; a member is forbidden", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "owner1", "owner");
    await addMember(teamId, "admin1", "admin");
    await addMember(teamId, "member1", "member");

    const owned = await callerFor("owner1", teamId, "owner").settings.invitations.create({
      email: "a@example.com",
    });
    expect(owned.acceptUrl).toContain("/invite/");
    expect(owned.role).toBe("member");

    await callerFor("admin1", teamId, "admin").settings.invitations.create({
      email: "b@example.com",
      role: "admin",
    });

    await expect(
      callerFor("member1", teamId, "member").settings.invitations.create({
        email: "c@example.com",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a duplicate pending invite for the same email (case-insensitive)", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "owner1", "owner");
    const caller = callerFor("owner1", teamId, "owner");
    await caller.settings.invitations.create({ email: "dup@example.com" });
    await expect(
      caller.settings.invitations.create({ email: "DUP@example.com" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("settings.invitations.accept", () => {
  it("joins the team once and is single-use", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "owner1", "owner");
    await createUser("newbie");

    const { acceptUrl } = await callerFor("owner1", teamId, "owner").settings.invitations.create({
      email: "newbie@example.com",
      role: "admin",
    });
    const token = tokenFromUrl(acceptUrl);

    const result = await callerFor("newbie", null, null).settings.invitations.accept({ token });
    expect(result.teamId).toBe(teamId);

    const [membership] = await db
      .select()
      .from(schema.teamMembers)
      .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, "newbie")));
    expect(membership?.role).toBe("admin");

    // Single-use: the second accept finds nothing left to stamp.
    await expect(
      callerFor("newbie", null, null).settings.invitations.accept({ token }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("on cloud, only the invited address can accept; self-host keeps the link as the credential", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "owner1", "owner");
    await createUser("stranger");
    await createUser("invited");
    const { acceptUrl } = await callerFor("owner1", teamId, "owner").settings.invitations.create({
      email: "Invited@example.com",
    });
    const token = tokenFromUrl(acceptUrl);

    vi.stubEnv("IS_CLOUD", "true");
    await expect(
      callerFor("stranger", null, null).settings.invitations.accept({ token }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The refused attempt must not have consumed the invite.
    await expect(
      callerFor("invited", null, null).settings.invitations.accept({ token }),
    ).resolves.toEqual({ teamId });

    vi.stubEnv("IS_CLOUD", "");
    const second = await callerFor("owner1", teamId, "owner").settings.invitations.create({
      email: "someone-else@example.com",
    });
    await expect(
      callerFor("stranger", null, null).settings.invitations.accept({
        token: tokenFromUrl(second.acceptUrl),
      }),
    ).resolves.toEqual({ teamId });
  });

  it("rejects an invalid token", async () => {
    await createUser("someone");
    await expect(
      callerFor("someone", null, null).settings.invitations.accept({ token: "not-a-token" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects an expired invite", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "owner1", "owner");
    await createUser("late");

    const { id, acceptUrl } = await callerFor(
      "owner1",
      teamId,
      "owner",
    ).settings.invitations.create({ email: "late@example.com" });
    await db
      .update(schema.teamInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.teamInvitations.id, id));

    await expect(
      callerFor("late", null, null).settings.invitations.accept({ token: tokenFromUrl(acceptUrl) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("settings.invitations list/revoke isolation", () => {
  it("lists only the caller team's pending invites and revoke frees the email", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "owner1", "owner");
    const caller = callerFor("owner1", teamId, "owner");

    const { id } = await caller.settings.invitations.create({ email: "p@example.com" });
    const listed = await caller.settings.invitations.list();
    expect(listed.map((i) => i.email)).toEqual(["p@example.com"]);
    // The bearer link is returned once, at create; a listing never rebuilds it.
    expect(JSON.stringify(listed)).not.toContain("/invite/");

    await caller.settings.invitations.revoke({ id });
    expect(await caller.settings.invitations.list()).toEqual([]);
    // The pending-unique index is freed, so the same email can be re-invited.
    await expect(
      caller.settings.invitations.create({ email: "p@example.com" }),
    ).resolves.toMatchObject({ email: "p@example.com" });
  });

  it("cannot list or revoke another team's invites", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    await addMember(teamA, "alice", "owner");
    await addMember(teamB, "bob", "owner");

    const { id } = await callerFor("alice", teamA, "owner").settings.invitations.create({
      email: "x@example.com",
    });

    expect(await callerFor("bob", teamB, "owner").settings.invitations.list()).toEqual([]);
    await expect(
      callerFor("bob", teamB, "owner").settings.invitations.revoke({ id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
