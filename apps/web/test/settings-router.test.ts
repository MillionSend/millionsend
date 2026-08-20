import { DAY_MS, utcDay } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamRole } from "@/server/membership";
import { createCaller } from "@/server/routers";

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
      { name: "alice", email: "alice@example.com", role: "owner" },
      { name: "bob", email: "bob@example.com", role: "member" },
    ]);
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
  // Full update payload / default get result — tests override what they exercise.
  const emptyCfg = {
    brandName: null,
    message: null,
    successMessage: null,
    redirectUrl: null,
    backgroundColor: null,
    textColor: null,
    accentColor: null,
    hideBranding: false,
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
    expect(await caller.settings.unsubscribe.get()).toEqual(full);
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
    expect(await caller.settings.unsubscribe.get()).toEqual(emptyCfg);
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
    expect(await callerFor("carol", teamB, "owner").settings.unsubscribe.get()).toEqual(emptyCfg);
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
