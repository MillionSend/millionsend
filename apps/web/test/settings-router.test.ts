import { DAY_MS, utcDay } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { SES_REGIONS } from "@millionsend/ses";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamRole } from "@/server/membership";
import { createCaller } from "@/server/routers";
import { createSettingsRouter, type TeamDeletionDeps } from "@/server/routers/settings";
import { type Context, createCallerFactory, router } from "@/server/trpc";

// SKIP_ENV_VALIDATION leaves env reads live, so stubbing IS_CLOUD here
// switches the routers between cloud and self-host behavior per test.
function stubCloud(): void {
  vi.stubEnv("IS_CLOUD", "true");
}

function dayAgo(offsetDays: number): string {
  return utcDay(Date.now() - offsetDays * DAY_MS);
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
    expect(team).toEqual({
      name: "acme",
      slug: "acme",
      plan: "free",
      planDailyLimit: 100,
      logoUrl: null,
      logoUploadsEnabled: false,
    });
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
      { userId: "alice", name: "alice", email: "alice@example.com", role: "owner", self: true },
      { userId: "bob", name: "bob", email: "bob@example.com", role: "member", self: false },
    ]);
  });

  async function memberRoles(teamId: string): Promise<Record<string, string>> {
    const rows = await db
      .select({ userId: schema.teamMembers.userId, role: schema.teamMembers.role })
      .from(schema.teamMembers)
      .where(eq(schema.teamMembers.teamId, teamId));
    return Object.fromEntries(rows.map((r) => [r.userId, r.role]));
  }

  it("remove drops the membership and the user's grants bound to this team only", async () => {
    const teamId = await createTeam(db, "acme");
    const other = await createTeam(db, "other");
    await addMember(teamId, "alice", "owner");
    await addMember(teamId, "bob", "member");
    await db.insert(schema.teamMembers).values({ teamId: other, userId: "bob", role: "member" });
    await db.insert(schema.oauthClient).values({ id: "c", clientId: "client", redirectUris: [] });
    await db.insert(schema.oauthConsent).values([
      { id: "here", clientId: "client", userId: "bob", referenceId: teamId, scopes: [] },
      { id: "there", clientId: "client", userId: "bob", referenceId: other, scopes: [] },
    ]);
    await db.insert(schema.oauthRefreshToken).values({
      id: "rt",
      token: "rt",
      clientId: "client",
      userId: "bob",
      referenceId: teamId,
      scopes: [],
    });

    await callerFor("alice", teamId, "owner").settings.members.remove({ userId: "bob" });
    expect(await memberRoles(teamId)).toEqual({ alice: "owner" });
    expect(await memberRoles(other)).toEqual({ bob: "member" });
    expect((await db.select().from(schema.oauthConsent)).map((c) => c.id)).toEqual(["there"]);
    expect(await db.select().from(schema.oauthRefreshToken)).toEqual([]);
  });

  it("remove: members cannot, admins cannot remove owners, nobody removes the last owner", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "alice", "owner");
    await addMember(teamId, "adam", "admin");
    await addMember(teamId, "bob", "member");
    await expect(
      callerFor("bob", teamId, "member").settings.members.remove({ userId: "adam" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor("adam", teamId, "admin").settings.members.remove({ userId: "alice" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor("alice", teamId, "owner").settings.members.remove({ userId: "alice" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // A second owner may be removed by the first, but never the other way to zero.
    await addMember(teamId, "olga", "owner");
    await callerFor("alice", teamId, "owner").settings.members.remove({ userId: "olga" });
    await callerFor("alice", teamId, "owner").settings.members.updateRole({
      userId: "adam",
      role: "owner",
    });
    await callerFor("adam", teamId, "owner").settings.members.remove({ userId: "alice" });
    await expect(callerFor("adam", teamId, "owner").settings.members.leave()).rejects.toMatchObject(
      { code: "PRECONDITION_FAILED" },
    );
    expect(await memberRoles(teamId)).toEqual({ adam: "owner", bob: "member" });
  });

  it("updateRole: admins manage non-owner roles; only owners grant or demote owner", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "alice", "owner");
    await addMember(teamId, "adam", "admin");
    await addMember(teamId, "bob", "member");
    await callerFor("adam", teamId, "admin").settings.members.updateRole({
      userId: "bob",
      role: "admin",
    });
    await expect(
      callerFor("adam", teamId, "admin").settings.members.updateRole({
        userId: "bob",
        role: "owner",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor("alice", teamId, "owner").settings.members.updateRole({
        userId: "alice",
        role: "member",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      callerFor("alice", teamId, "owner").settings.members.updateRole({
        userId: "ghost",
        role: "member",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await memberRoles(teamId)).toEqual({ alice: "owner", adam: "admin", bob: "admin" });
  });

  it("leave removes the caller's own membership", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "alice", "owner");
    await addMember(teamId, "bob", "member");
    await callerFor("bob", teamId, "member").settings.members.leave();
    expect(await memberRoles(teamId)).toEqual({ alice: "owner" });
  });
});

describe("settings.team.delete", () => {
  function deletionCaller(userId: string, teamId: string, role: TeamRole, deps: TeamDeletionDeps) {
    const factory = createCallerFactory(router({ settings: createSettingsRouter(deps) }));
    const ctx: Context = {
      db,
      session: { user: { id: userId, email: `${userId}@example.com`, name: userId } },
      teamId,
      role,
    };
    return factory(ctx);
  }

  it("owner deletes the team, its rows, grants, and external identities; others cannot", async () => {
    stubCloud();
    const teamId = await createTeam(db, "acme");
    const other = await createTeam(db, "other");
    await addMember(teamId, "alice", "owner");
    await addMember(teamId, "adam", "admin");
    await db
      .update(schema.teams)
      .set({ logoUrl: "https://cdn/logo.png" })
      .where(eq(schema.teams.id, teamId));
    const [domain] = await db
      .insert(schema.domains)
      .values({
        teamId,
        name: "acme.test",
        region: "us-east-1",
        sesTenantAssociatedAt: new Date(),
      })
      .returning({ id: schema.domains.id });
    if (!domain) throw new Error("domain insert failed");
    // RESTRICT links that would block a bare cascade.
    await db.insert(schema.apiKeys).values({
      teamId,
      name: "k",
      tokenPrefix: "ms_",
      last4: "abcd",
      keyHash: "h",
      permission: "full_access",
      domainId: domain.id,
    });
    const [segment] = await db
      .insert(schema.segments)
      .values({ teamId, name: "s", filter: { match: "all", conditions: [] } })
      .returning({ id: schema.segments.id });
    await db.insert(schema.broadcasts).values({
      teamId,
      from: "a@acme.test",
      subject: "s",
      segmentId: segment?.id,
    });
    await db.insert(schema.oauthClient).values({ id: "c", clientId: "client", redirectUris: [] });
    await db.insert(schema.oauthConsent).values([
      { id: "here", clientId: "client", userId: "adam", referenceId: teamId, scopes: [] },
      { id: "there", clientId: "client", userId: "adam", referenceId: other, scopes: [] },
    ]);

    const calls: string[] = [];
    const deps: TeamDeletionDeps = {
      cancelSubscription: async (_db, id) => {
        calls.push(`stripe:${id}`);
      },
      deleteSesIdentity: async ({ name, region, tenant }) => {
        calls.push(`ses:${region}:${name}${tenant ? `:tenant=${tenant}` : ""}`);
        throw new Error("already gone");
      },
      deleteSesTenant: async ({ tenantName, region }) => {
        calls.push(`tenant:${region}:${tenantName}`);
      },
      deleteLogo: async (url) => {
        calls.push(`logo:${url}`);
      },
    };

    await expect(
      deletionCaller("adam", teamId, "admin", deps).settings.team.delete(),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await deletionCaller("alice", teamId, "owner", deps).settings.team.delete();

    expect(calls).toEqual([
      `stripe:${teamId}`,
      `ses:us-east-1:acme.test:tenant=${teamId}`,
      "logo:https://cdn/logo.png",
      // Tenants outlive the domains that created them: every region is tried.
      ...SES_REGIONS.map((region) => `tenant:${region}:${teamId}`),
    ]);
    expect(await db.select().from(schema.teams)).toHaveLength(1);
    expect(await db.select().from(schema.teamMembers)).toEqual([]);
    expect(await db.select().from(schema.domains)).toEqual([]);
    expect(await db.select().from(schema.apiKeys)).toEqual([]);
    expect(await db.select().from(schema.broadcasts)).toEqual([]);
    expect((await db.select().from(schema.oauthConsent)).map((c) => c.id)).toEqual(["there"]);
  });
});

describe("settings.smtp", () => {
  it("exposes connection facts but never a real secret — the password is the placeholder", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "u1", "owner");
    const smtp = await callerFor("u1", teamId, "owner").settings.smtp.get();
    expect(smtp.user).toBe("millionsend");
    expect(smtp.port).toBe(2587);
    expect(smtp.host.length).toBeGreaterThan(0);
    expect(smtp.passwordPlaceholder).toBe("YOUR_API_KEY");
    // No field may carry an ms_ API key.
    expect(JSON.stringify(smtp)).not.toMatch(/ms_/);
  });

  it("derives TLS flags from env — both paths required, and never ships the paths", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "u1", "owner");
    const caller = callerFor("u1", teamId, "owner");

    vi.stubEnv("SMTP_TLS_CERT_PATH", "");
    vi.stubEnv("SMTP_TLS_KEY_PATH", "");
    vi.stubEnv("SMTP_ALLOW_INSECURE_AUTH", "");
    const bare = await caller.settings.smtp.get();
    expect(bare.tlsConfigured).toBe(false);
    expect(bare.allowInsecureAuth).toBe(false);

    // Cert without key is not TLS-configured.
    vi.stubEnv("SMTP_TLS_CERT_PATH", "/etc/ssl/relay.crt");
    expect((await caller.settings.smtp.get()).tlsConfigured).toBe(false);

    vi.stubEnv("SMTP_TLS_KEY_PATH", "/etc/ssl/relay.key");
    const withTls = await caller.settings.smtp.get();
    expect(withTls.tlsConfigured).toBe(true);
    expect(JSON.stringify(withTls)).not.toContain("/etc/ssl");

    vi.stubEnv("SMTP_ALLOW_INSECURE_AUTH", "true");
    expect((await caller.settings.smtp.get()).allowInsecureAuth).toBe(true);
  });
});

describe("settings.unsubscribe", () => {
  // Default get result for a fresh team — tests override what they exercise.
  // teamName rides along so the page can fall back to it as the brand name;
  // hideBranding (the "show your logo" opt-in) defaults on.
  const emptyCfg = {
    teamName: "acme",
    brandName: null,
    message: null,
    successMessage: null,
    redirectUrl: null,
    backgroundColor: null,
    textColor: null,
    accentColor: null,
    hideBranding: true,
  };

  it("get returns the team's customization, defaults by default", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "u1", "owner");
    const cfg = await callerFor("u1", teamId, "owner").settings.unsubscribe.get();
    expect(cfg).toEqual(emptyCfg);
  });

  it("update stores the full customization for owners and admins, clearing on empty", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "u1", "admin");
    const caller = callerFor("u1", teamId, "admin");
    const full = {
      brandName: "Acme",
      message: "Sorry to see you go.",
      successMessage: "All set.",
      redirectUrl: "https://acme.com/bye",
      backgroundColor: "#000000",
      textColor: "#FFFFFF",
      accentColor: "#46a3f9",
      hideBranding: true,
    };
    await caller.settings.unsubscribe.update(full);
    expect(await caller.settings.unsubscribe.get()).toEqual({ teamName: "acme", ...full });
    // Empty strings clear back to null.
    await caller.settings.unsubscribe.update({
      brandName: "",
      message: "",
      successMessage: "",
      redirectUrl: "",
      backgroundColor: "",
      textColor: "",
      accentColor: "",
      hideBranding: false,
    });
    // hideBranding false was an explicit choice, not a cleared field.
    expect(await caller.settings.unsubscribe.get()).toEqual({ ...emptyCfg, hideBranding: false });
  });

  it("update is forbidden for role member", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "u1", "member");
    await expect(
      callerFor("u1", teamId, "member").settings.unsubscribe.update({
        ...emptyCfg,
        brandName: "Hijack",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("update rejects a non-http(s) redirect URL", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "u1", "owner");
    const caller = callerFor("u1", teamId, "owner");
    for (const redirectUrl of ["javascript:alert(1)", "ftp://x.com", "not a url"]) {
      await expect(
        caller.settings.unsubscribe.update({ ...emptyCfg, redirectUrl }),
      ).rejects.toThrow();
    }
    // The rejected writes never landed.
    expect((await caller.settings.unsubscribe.get()).redirectUrl).toBeNull();
  });

  it("update rejects anything that is not a strict 6-digit hex color", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "u1", "owner");
    const caller = callerFor("u1", teamId, "owner");
    // Colors land in inline styles on the public page — nothing loose may pass.
    const bad = ["red", "#fff", "#12345g", "46a3f9", "#1234567", "rgb(0,0,0)", "url(x)"];
    for (const color of bad) {
      await expect(
        caller.settings.unsubscribe.update({ ...emptyCfg, backgroundColor: color }),
      ).rejects.toThrow();
      await expect(
        caller.settings.unsubscribe.update({ ...emptyCfg, textColor: color }),
      ).rejects.toThrow();
      await expect(
        caller.settings.unsubscribe.update({ ...emptyCfg, accentColor: color }),
      ).rejects.toThrow();
    }
    expect(await caller.settings.unsubscribe.get()).toEqual(emptyCfg);
  });

  it("update is scoped to the caller's team", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    await addMember(teamA, "alice", "owner");
    await addMember(teamB, "carol", "owner");
    await callerFor("alice", teamA, "owner").settings.unsubscribe.update({
      ...emptyCfg,
      brandName: "A",
    });
    expect(await callerFor("carol", teamB, "owner").settings.unsubscribe.get()).toEqual({
      ...emptyCfg,
      teamName: "team-b",
    });
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
    await insertCounter(teamId, dayAgo(0), 42);
    await insertCounter(teamId, dayAgo(1), 7);
    await insertCounter(teamId, dayAgo(16), 99); // outside the default 15-day window

    const usage = await callerFor("u1", teamId, "owner").settings.usage.recent();
    expect(usage.rows.map((r) => [r.day, r.accepted])).toEqual([
      [dayAgo(0), 42],
      [dayAgo(1), 7],
    ]);
    expect(usage.today).toEqual({ accepted: 42, limit: 100 });
  });

  it("widens the window when days is passed", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "u1", "owner");
    await insertCounter(teamId, dayAgo(16), 99);

    const usage = await callerFor("u1", teamId, "owner").settings.usage.recent({ days: 30 });
    expect(usage.rows.map((r) => r.day)).toEqual([dayAgo(16)]);
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
    await insertCounter(teamB, dayAgo(0), 55);

    const usage = await callerFor("alice", teamA, "owner").settings.usage.recent();
    expect(usage.rows).toEqual([]);
    expect(usage.today.accepted).toBe(0);
  });
});
