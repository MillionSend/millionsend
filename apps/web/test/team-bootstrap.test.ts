import {
  DAY_MS,
  PLAN_TEAM_LIMIT,
  SUSPENSION_REASONS,
  TEAM_CREATE_WINDOW_DAYS,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb, REAL_NAMES, REFUSED_NAMES } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveMembership } from "@/server/membership";
import { createCaller } from "@/server/routers";
import type { Context } from "@/server/trpc";

// The request language server-side refusals are written in (NEXT_LOCALE).
const locale = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (locale.cookie ? { value: locale.cookie } : undefined),
  }),
}));
const enqueueSharedSubdomain = vi.hoisted(() =>
  vi.fn(async (_teamId: string, _since: Date, _startAfter?: Date) => {}),
);
vi.mock("@/server/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/queue")>()),
  enqueueSharedSubdomain,
}));

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  enqueueSharedSubdomain.mockClear();
  locale.cookie = undefined;
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

describe("team.createTeam and the team's shared subdomain", () => {
  const SHARED = "agents.example.com";
  const labels = (teamId: string) =>
    db
      .select({
        name: schema.sharedInboxDomains.name,
        lockedAt: schema.sharedInboxDomains.lockedAt,
      })
      .from(schema.sharedInboxDomains)
      .where(eq(schema.sharedInboxDomains.teamId, teamId));

  it("gives a new team its unlocked label", async () => {
    vi.stubEnv("SHARED_INBOX_DOMAIN", SHARED);
    await insertUser("u1", "u1@example.com");
    const { teamId } = await callerFor("u1").team.createTeam({ name: "Acme Inc" });
    expect(await labels(teamId)).toEqual([{ name: `acme-inc.${SHARED}`, lockedAt: null }]);
    expect(enqueueSharedSubdomain).not.toHaveBeenCalled();
  });

  it("creates the team while the name review can't answer, and has the worker settle it from 5 minutes on", async () => {
    vi.stubEnv("SHARED_INBOX_DOMAIN", SHARED);
    vi.stubEnv("ABUSE_JUDGE", "typesafe");
    vi.stubEnv("ABUSE_JUDGE_API_KEY", "test-key");
    vi.stubGlobal("fetch", () => Promise.reject(new Error("judge down")));
    await insertUser("u1", "u1@example.com");
    const { teamId } = await callerFor("u1").team.createTeam({ name: "Acme Inc" });
    expect(await db.select().from(schema.teams).where(eq(schema.teams.id, teamId))).toHaveLength(1);
    expect(await labels(teamId)).toEqual([]);
    expect(enqueueSharedSubdomain).toHaveBeenCalledTimes(1);
    const [queuedFor, since, startAfter] = enqueueSharedSubdomain.mock.calls[0] ?? [];
    expect(queuedFor).toBe(teamId);
    expect((startAfter?.getTime() ?? 0) - (since?.getTime() ?? 0)).toBe(5 * 60_000);
  });

  it("does nothing without a shared domain", async () => {
    await insertUser("u1", "u1@example.com");
    const { teamId } = await callerFor("u1").team.createTeam({ name: "Acme Inc" });
    expect(await labels(teamId)).toEqual([]);
    expect(enqueueSharedSubdomain).not.toHaveBeenCalled();
  });
});

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

  it("refuses a name that could read as a link or hide characters; real names in any script are fine", async () => {
    await insertUser("u1", "u1@example.com");
    for (const name of REFUSED_NAMES) {
      await expect(callerFor("u1").team.createTeam({ name }), name).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(await db.select().from(schema.teams)).toEqual([]);
    for (const name of REAL_NAMES) {
      const { teamId } = await callerFor("u1").team.createTeam({ name });
      const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
      expect(team?.name, name).toBe(name);
    }
  });

  it("creates a team named after a brand and flags it for the operator, naming the brand", async () => {
    await insertUser("u1", "u1@example.com");
    const flagOf = async (name: string) => {
      const { teamId } = await callerFor("u1").team.createTeam({ name });
      const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
      expect(team?.name, name).toBe(name);
      return db
        .select({ reason: schema.teamFlags.reason, detail: schema.teamFlags.detail })
        .from(schema.teamFlags)
        .where(eq(schema.teamFlags.teamId, teamId));
    };
    expect(await flagOf("Rnicrosoft 0ffice 365")).toEqual([
      { reason: "brand", detail: { brand: "Microsoft" } },
    ]);
    expect(await flagOf("Vivo")).toEqual([{ reason: "brand", detail: { brand: "Vivo" } }]);
    expect(await flagOf("Vivo Bem Nutrição")).toEqual([]);
    expect(await flagOf("Acme Inc")).toEqual([]);
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
    for (let i = 0; i < PLAN_TEAM_LIMIT.free; i++) {
      await callerFor("u1").team.createTeam({ name: `Team ${i}` });
    }
    await expect(callerFor("u1").team.createTeam({ name: "One more" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    vi.stubEnv("IS_CLOUD", "");
    await expect(callerFor("u1").team.createTeam({ name: "Self-host" })).resolves.toBeTruthy();
  });

  it("on cloud's Free plan, counts the teams created in the last 30 days, deleted ones included", async () => {
    vi.stubEnv("IS_CLOUD", "true");
    await insertUser("u1", "u1@example.com");
    const created = [];
    for (let i = 0; i < PLAN_TEAM_LIMIT.free; i++) {
      created.push(await callerFor("u1").team.createTeam({ name: `Team ${i}` }));
    }
    for (const team of created.slice(1)) {
      await db.delete(schema.teams).where(eq(schema.teams.id, team.teamId));
    }
    await expect(callerFor("u1").team.createTeam({ name: "Again" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("a creation older than 30 days no longer counts", async () => {
    vi.stubEnv("IS_CLOUD", "true");
    await insertUser("u1", "u1@example.com");
    const old = new Date(Date.now() - (TEAM_CREATE_WINDOW_DAYS + 1) * DAY_MS);
    // Deleted teams' rows outlive them; the audit log is append-only, so older ones are written as such.
    await db.insert(schema.auditLog).values(
      Array.from({ length: PLAN_TEAM_LIMIT.free }, (_, i) => ({
        teamId: crypto.randomUUID(),
        actorId: "user:u1",
        action: "team.created",
        target: `team:old-${i}`,
        createdAt: old,
      })),
    );
    for (let i = 0; i < PLAN_TEAM_LIMIT.free; i++) {
      await callerFor("u1").team.createTeam({ name: `Team ${i}` });
    }
    await expect(callerFor("u1").team.createTeam({ name: "One more" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("leaves a paying owner to the owned-team cap, whatever they created and deleted", async () => {
    vi.stubEnv("IS_CLOUD", "true");
    await insertUser("u1", "u1@example.com");
    const paid = await callerFor("u1").team.createTeam({ name: "Paid" });
    await db.update(schema.teams).set({ plan: "pro" }).where(eq(schema.teams.id, paid.teamId));
    for (let i = 0; i < PLAN_TEAM_LIMIT.pro; i++) {
      const { teamId } = await callerFor("u1").team.createTeam({ name: `Churn ${i}` });
      await db.delete(schema.teams).where(eq(schema.teams.id, teamId));
    }
    await expect(callerFor("u1").team.createTeam({ name: "Kept" })).resolves.toBeTruthy();
  });

  it("writes one team.created row per creation, and records the creator on cloud only", async () => {
    await insertUser("u1", "u1@example.com");
    vi.stubEnv("IS_CLOUD", "true");
    const cloudTeam = await callerFor("u1").team.createTeam({ name: "Cloud" });
    vi.stubEnv("IS_CLOUD", "");
    const selfHosted = await callerFor("u1").team.createTeam({ name: "Self-hosted" });
    const rows = await db
      .select({ teamId: schema.auditLog.teamId, actorId: schema.auditLog.actorId })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "team.created"));
    expect(rows).toEqual([
      { teamId: cloudTeam.teamId, actorId: "user:u1" },
      { teamId: selfHosted.teamId, actorId: "user:u1" },
    ]);
    const owners = await db
      .select({ id: schema.teams.id, poolOwnerId: schema.teams.poolOwnerId })
      .from(schema.teams);
    expect(owners).toEqual(
      expect.arrayContaining([
        { id: cloudTeam.teamId, poolOwnerId: "u1" },
        { id: selfHosted.teamId, poolOwnerId: null },
      ]),
    );
  });

  it("the ladder's team caps climb with the plan", () => {
    expect(PLAN_TEAM_LIMIT.starter).toBeGreaterThan(PLAN_TEAM_LIMIT.free);
    expect(PLAN_TEAM_LIMIT.starter).toBeLessThan(PLAN_TEAM_LIMIT.pro);
    expect(PLAN_TEAM_LIMIT.pro).toBeLessThan(PLAN_TEAM_LIMIT.scale);
  });

  it("owning a paid team raises the cap; being a member of one does not", async () => {
    vi.stubEnv("IS_CLOUD", "true");
    await insertUser("u1", "u1@example.com");
    await insertUser("u2", "u2@example.com");
    // u1 is a member of u2's Scale team: no effect on u1's own cap.
    const theirs = await callerFor("u2").team.createTeam({ name: "Theirs" });
    await db.update(schema.teams).set({ plan: "scale" }).where(eq(schema.teams.id, theirs.teamId));
    await db.insert(schema.teamMembers).values({ teamId: theirs.teamId, userId: "u1" });
    const first = await callerFor("u1").team.createTeam({ name: "Mine" });
    for (let i = 1; i < PLAN_TEAM_LIMIT.free; i++) {
      await callerFor("u1").team.createTeam({ name: `Team ${i}` });
    }
    await expect(callerFor("u1").team.createTeam({ name: "One more" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // One of u1's own teams goes Pro: room for more.
    await db.update(schema.teams).set({ plan: "pro" }).where(eq(schema.teams.id, first.teamId));
    for (let i = PLAN_TEAM_LIMIT.free; i < PLAN_TEAM_LIMIT.pro; i++) {
      await callerFor("u1").team.createTeam({ name: `Team ${i}` });
    }
    await expect(callerFor("u1").team.createTeam({ name: "Past pro" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    vi.stubEnv("IS_CLOUD", "");
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

  it("refuses anyone in a team suspended for phishing or held for review, owner or member; other suspensions do not count", async () => {
    await insertUser("owner", "owner@example.com");
    await insertUser("member", "member@example.com");
    await insertUser("outsider", "outsider@example.com");
    const { teamId } = await callerFor("owner").team.createTeam({ name: "Phish" });
    await db.insert(schema.teamMembers).values({ teamId, userId: "member", role: "member" });

    // Every reason the schema has, so `review` is covered once it exists.
    const silent: readonly string[] = ["phishing", "review"];
    for (const reason of SUSPENSION_REASONS) {
      await db
        .update(schema.teams)
        .set({ suspendedAt: new Date(), suspensionReason: reason })
        .where(eq(schema.teams.id, teamId));
      for (const user of ["owner", "member"]) {
        if (!silent.includes(reason)) {
          await callerFor(user).team.createTeam({ name: `Allowed ${reason}` });
          continue;
        }
        await expect(
          callerFor(user).team.createTeam({ name: "Again" }),
          `${reason} ${user}`,
        ).rejects.toMatchObject({
          code: "PRECONDITION_FAILED",
          message:
            "This isn't available for this team right now. Contact support if you need help.",
        });
      }
    }
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date(), suspensionReason: "phishing" })
      .where(eq(schema.teams.id, teamId));
    locale.cookie = "pt-BR";
    await expect(callerFor("owner").team.createTeam({ name: "Again" })).rejects.toMatchObject({
      message:
        "Isso não está disponível para esta equipe no momento. Fale com o suporte se precisar de ajuda.",
    });
    await callerFor("outsider").team.createTeam({ name: "Clean" });
    expect(await db.select().from(schema.teams).where(eq(schema.teams.name, "Again"))).toEqual([]);
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
