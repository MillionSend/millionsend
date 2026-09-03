import { INVITE_MAX_SENDS, INVITE_TTL_MS } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SimpleEmail } from "@millionsend/ses";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamRole } from "@/server/membership";
import { createCaller } from "@/server/routers";
import { createSettingsRouter } from "@/server/routers/settings";
import { buildInvitationEmail, type SystemMailDeps } from "@/server/system-mail";
import { type Context, createCallerFactory, router } from "@/server/trpc";

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

/** Caller with a captured mailer, the way settings-router.test.ts injects deletion deps. */
function mailCaller(
  userId: string,
  teamId: string | null,
  role: TeamRole | null,
  opts: { failing?: boolean } = {},
) {
  const sent: SimpleEmail[] = [];
  const mail: SystemMailDeps = {
    send: async (message) => {
      if (opts.failing) throw new Error("ses down");
      sent.push(message);
    },
  };
  const factory = createCallerFactory(router({ settings: createSettingsRouter(undefined, mail) }));
  const ctx: Context = {
    db,
    session: { user: { id: userId, email: `${userId}@example.com`, name: userId } },
    teamId,
    role,
  };
  return { caller: factory(ctx), sent };
}

function stubSender(): void {
  vi.stubEnv("AUTH_EMAIL_FROM", "MillionSend <no-reply@mail.example.com>");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "test-key");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret");
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

describe("settings.invitations email + resend", () => {
  it("emails the invitee at create, naming the team and carrying the accept link", async () => {
    stubSender();
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "owner1", "owner");
    const { caller, sent } = mailCaller("owner1", teamId, "owner");
    const created = await caller.settings.invitations.create({ email: "new@example.com" });
    expect(created.emailed).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("new@example.com");
    expect(sent[0]?.from).toContain("no-reply@mail.example.com");
    expect(sent[0]?.subject).toContain("acme");
    expect(sent[0]?.html).toContain(created.acceptUrl);
    expect(sent[0]?.text).toContain(created.acceptUrl);
    const [row] = await db
      .select()
      .from(schema.teamInvitations)
      .where(eq(schema.teamInvitations.id, created.id));
    expect(row?.sendCount).toBe(1);
    expect(row?.lastSentAt).toBeInstanceOf(Date);
    const listed = await caller.settings.invitations.list();
    expect(listed[0]).toMatchObject({ sendCount: 1 });
  });

  it("without a sender the link is the only credential: emailed=false, nothing sent", async () => {
    vi.stubEnv("AUTH_EMAIL_FROM", "");
    vi.stubEnv("NOTIFICATIONS_EMAIL_FROM", "");
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "owner1", "owner");
    const { caller, sent } = mailCaller("owner1", teamId, "owner");
    const created = await caller.settings.invitations.create({ email: "new@example.com" });
    expect(created.emailed).toBe(false);
    expect(sent).toHaveLength(0);
    await expect(caller.settings.invitations.resend({ id: created.id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("resend: cooldown, renewal, lifetime cap", async () => {
    stubSender();
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "owner1", "owner");
    const { caller, sent } = mailCaller("owner1", teamId, "owner");
    const created = await caller.settings.invitations.create({ email: "new@example.com" });

    // Just sent: inside the cooldown.
    await expect(caller.settings.invitations.resend({ id: created.id })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });

    const stale = new Date(Date.now() - 3 * 60 * 1000);
    const nearlyExpired = new Date(Date.now() + 60 * 1000);
    await db
      .update(schema.teamInvitations)
      .set({ lastSentAt: stale, expiresAt: nearlyExpired })
      .where(eq(schema.teamInvitations.id, created.id));
    const resent = await caller.settings.invitations.resend({ id: created.id });
    // Renewed to a full TTL from now, and emailed again.
    expect(resent.expiresAt.getTime()).toBeGreaterThan(Date.now() + INVITE_TTL_MS - 5000);
    expect(sent).toHaveLength(2);
    const [row] = await db
      .select()
      .from(schema.teamInvitations)
      .where(eq(schema.teamInvitations.id, created.id));
    expect(row?.sendCount).toBe(2);

    await db
      .update(schema.teamInvitations)
      .set({ lastSentAt: stale, sendCount: INVITE_MAX_SENDS })
      .where(eq(schema.teamInvitations.id, created.id));
    await expect(caller.settings.invitations.resend({ id: created.id })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(sent).toHaveLength(2);
  });

  it("caps invite emails per team per hour", async () => {
    stubSender();
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "owner1", "owner");
    const { caller } = mailCaller("owner1", teamId, "owner");
    for (let i = 0; i < 20; i++) {
      await caller.settings.invitations.create({ email: `p${i}@example.com` });
    }
    await expect(
      caller.settings.invitations.create({ email: "p20@example.com" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // Another team keeps its own budget.
    const other = await createTeam(db, "other");
    await addMember(other, "owner2", "owner");
    await expect(
      mailCaller("owner2", other, "owner").caller.settings.invitations.create({
        email: "q@example.com",
      }),
    ).resolves.toMatchObject({ email: "q@example.com" });
  });
});

describe("settings.invitations send accounting", () => {
  it("two concurrent resends email exactly once: the cooldown is enforced by the update itself", async () => {
    stubSender();
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "owner1", "owner");
    const { caller, sent } = mailCaller("owner1", teamId, "owner");
    const created = await caller.settings.invitations.create({ email: "new@example.com" });
    await db
      .update(schema.teamInvitations)
      .set({ lastSentAt: new Date(Date.now() - 3 * 60 * 1000) })
      .where(eq(schema.teamInvitations.id, created.id));
    const results = await Promise.all(
      [0, 1].map(() => caller.settings.invitations.resend({ id: created.id }).catch((e) => e)),
    );
    expect(results.filter((r) => r instanceof Error)).toHaveLength(1);
    expect(sent).toHaveLength(2);
    const [row] = await db
      .select()
      .from(schema.teamInvitations)
      .where(eq(schema.teamInvitations.id, created.id));
    expect(row?.sendCount).toBe(2);
  });

  it("a refused send at create leaves emailed=false and nothing charged", async () => {
    stubSender();
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "owner1", "owner");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { caller, sent } = mailCaller("owner1", teamId, "owner", { failing: true });
    const created = await caller.settings.invitations.create({ email: "new@example.com" });
    expect(created.emailed).toBe(false);
    expect(created.acceptUrl).toContain("/invite/");
    expect(sent).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
    const [row] = await db
      .select()
      .from(schema.teamInvitations)
      .where(eq(schema.teamInvitations.id, created.id));
    expect(row).toMatchObject({ sendCount: 0, lastSentAt: null });
  });

  it("a refused resend restores the counters and reports the failure", async () => {
    stubSender();
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "owner1", "owner");
    const ok = mailCaller("owner1", teamId, "owner");
    const created = await ok.caller.settings.invitations.create({ email: "new@example.com" });
    const stale = new Date(Date.now() - 3 * 60 * 1000);
    await db
      .update(schema.teamInvitations)
      .set({ lastSentAt: stale })
      .where(eq(schema.teamInvitations.id, created.id));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = mailCaller("owner1", teamId, "owner", { failing: true });
    await expect(
      failing.caller.settings.invitations.resend({ id: created.id }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db
      .select()
      .from(schema.teamInvitations)
      .where(eq(schema.teamInvitations.id, created.id));
    expect(row?.sendCount).toBe(1);
    expect(row?.lastSentAt?.getTime()).toBe(stale.getTime());
  });

  it("names with $ sequences render verbatim and every placeholder is filled", () => {
    const mail = buildInvitationEmail({
      to: "new@example.com",
      inviterName: "Bob $'",
      teamName: "Acme $$ Co",
      role: "member",
      url: "https://app.example.com/invite/tok",
      expiresInDays: 3,
      locale: "en",
    });
    expect(mail.text).toContain("Bob $'");
    expect(mail.text).toContain("Acme $$ Co");
    expect(mail.text).not.toMatch(/\{(inviter|team|role|days|email)\}/);
    expect(mail.subject).toContain("Acme $$ Co");
  });
});

describe("settings.invitations.preview", () => {
  it("on cloud the address is masked and never prefilled; self-host shows and prefills it", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "owner1", "owner");
    const { acceptUrl } = await callerFor("owner1", teamId, "owner").settings.invitations.create({
      email: "newbie@example.com",
    });
    const token = tokenFromUrl(acceptUrl);
    const anon = callerFor("anon", null, null);
    expect(await anon.settings.invitations.preview({ token })).toMatchObject({
      email: "newbie@example.com",
      prefillEmail: "newbie@example.com",
    });
    vi.stubEnv("IS_CLOUD", "true");
    expect(await anon.settings.invitations.preview({ token })).toMatchObject({
      email: "n***@example.com",
      prefillEmail: null,
    });
  });

  it("names the team, inviter and role, and tracks valid/expired/accepted", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "owner1", "owner");
    await createUser("newbie");
    const { id, acceptUrl } = await callerFor(
      "owner1",
      teamId,
      "owner",
    ).settings.invitations.create({ email: "newbie@example.com", role: "admin" });
    const token = tokenFromUrl(acceptUrl);
    const anon = callerFor("newbie", null, null);

    expect(await anon.settings.invitations.preview({ token })).toMatchObject({
      teamName: "acme",
      inviterName: "owner1",
      role: "admin",
      email: "newbie@example.com",
      state: "valid",
    });

    await db
      .update(schema.teamInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.teamInvitations.id, id));
    expect((await anon.settings.invitations.preview({ token })).state).toBe("expired");

    await db
      .update(schema.teamInvitations)
      .set({ expiresAt: new Date(Date.now() + INVITE_TTL_MS) })
      .where(eq(schema.teamInvitations.id, id));
    await anon.settings.invitations.accept({ token });
    expect((await anon.settings.invitations.preview({ token })).state).toBe("accepted");
  });

  it("rejects a bad token and a revoked invite", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "owner1", "owner");
    const caller = callerFor("owner1", teamId, "owner");
    await expect(caller.settings.invitations.preview({ token: "nope" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const { id, acceptUrl } = await caller.settings.invitations.create({ email: "r@example.com" });
    await caller.settings.invitations.revoke({ id });
    await expect(
      caller.settings.invitations.preview({ token: tokenFromUrl(acceptUrl) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
