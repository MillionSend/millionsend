import { applyJudgedSample, MONITOR_SETTING_DEFAULTS } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamRole } from "@/server/membership";
import { createCaller } from "@/server/routers";

// The monitor's Resume kicks the quota drain; no pg-boss in tests.
vi.mock("@/server/queue", () => ({
  getQueue: async () => ({ runCronNow: async () => {} }),
  enqueueEmailSend: async () => {},
  enqueueWebhookDeliveries: async () => {},
  enqueueRecipientErase: async () => {},
}));

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

  it("never shows the team the operator's note on a phishing suspension or a review hold", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "alice", "owner");
    // The row the console's Suspend writes, under each kind of reason.
    for (const reason of ["phishing", "review", "manual"]) {
      await db.insert(schema.auditLog).values({
        teamId,
        actorId: "user:op",
        action: "team.suspended",
        target: `team:${teamId}`,
        data: { name: "acme", reason, note: `kit seen (${reason})`, notified: false },
      });
    }
    const { items } = await callerFor("alice", teamId, "owner").audit.list({});
    expect(Object.fromEntries(items.map((row) => [row.data?.reason, row.data]))).toEqual({
      phishing: { name: "acme", reason: "phishing", note: null, notified: false },
      review: { name: "acme", reason: "review", note: null, notified: false },
      manual: { name: "acme", reason: "manual", note: "kit seen (manual)", notified: false },
    });
  });

  it("never lists trust & safety flags and shows the operator only as MillionSend; the console keeps both", async () => {
    // The instance operator is the first registered user, and no member of the team.
    await db
      .insert(schema.user)
      .values({ id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) });
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "alice", "owner");
    const operator = createCaller({
      db,
      session: {
        user: { id: "op", email: "op@example.com", name: "Operator" },
        session: { id: "s-op", createdAt: new Date() },
      },
      teamId: null,
      role: null,
    });

    await operator.console.safety.openFlag({ teamId, note: "kit seen" });
    const [flag] = await db.select().from(schema.teamFlags);
    if (!flag) throw new Error("flag missing");
    await operator.console.safety.clearFlag({ flagId: flag.id });
    await operator.console.safety.reopenFlag({ flagId: flag.id });
    await operator.console.teams.suspend({ id: teamId, reason: "manual", notify: false });
    await callerFor("alice", teamId, "owner").apiKeys.create({ name: "CI" });

    const { items } = await callerFor("alice", teamId, "owner").audit.list({});
    expect(items.map((row) => [row.action, row.actor])).toEqual([
      ["api_key.created", { kind: "user", id: "alice", name: "alice", email: "alice@example.com" }],
      ["team.suspended", { kind: "operator" }],
    ]);
    expect(JSON.stringify(items)).not.toMatch(/Operator|op@example\.com|kit seen/);

    const instance = await operator.console.audit.list({});
    const flagRows = instance.items.filter((row) => row.action.startsWith("console.flag_"));
    expect(flagRows.map((row) => row.action)).toEqual([
      "console.flag_reopened",
      "console.flag_cleared",
      "console.flag_opened",
    ]);
    for (const row of [
      ...flagRows,
      ...instance.items.filter((r) => r.action === "team.suspended"),
    ]) {
      expect(row.actor).toEqual({
        kind: "user",
        id: "op",
        name: "Operator",
        email: "op@example.com",
      });
    }
  });

  it("never shows the team the content monitor's actions or a pause it was not told about, and keeps its access disclosure", async () => {
    await db
      .insert(schema.user)
      .values({ id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) });
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "alice", "owner");
    const operator = createCaller({
      db,
      session: {
        user: { id: "op", email: "op@example.com", name: "Operator" },
        session: { id: "s-op", createdAt: new Date() },
      },
      teamId: null,
      role: null,
    });

    // A run of certain verdicts on a new team: the monitor pauses its broadcasts.
    const quiet = { ...MONITOR_SETTING_DEFAULTS, autoPause: false };
    for (let i = 0; i < 12; i += 1) await applyJudgedSample(db, quiet, { teamId, score: 100 });
    const paused = await applyJudgedSample(db, MONITOR_SETTING_DEFAULTS, { teamId, score: 95 });
    expect(paused.paused).toBe(true);
    await operator.console.monitor.resumeBroadcasts({ teamId });
    await operator.console.monitor.setOverride({ teamId });
    await operator.console.monitor.clearOverride({ teamId });
    // Paused by hand without emailing the owner.
    await operator.console.teams.pauseBroadcasts({
      id: teamId,
      reason: "report",
      note: "lure kit seen",
      notify: false,
    });
    // The seven-day disclosure of a content access, as the worker writes it.
    await db.insert(schema.auditLog).values({
      teamId,
      actorId: "system",
      action: "content.accessed",
      target: `content_access_grant:${crypto.randomUUID()}`,
      data: { reason: "phishing_or_malware", emails: 1, fields: "subject, rendered text" },
      createdAt: new Date(Date.now() - 8 * 86_400_000),
    });

    const { items } = await callerFor("alice", teamId, "owner").audit.list({});
    expect(items.map(({ action, actor, data }) => ({ action, actor, data }))).toEqual([
      {
        action: "team.broadcasts_paused",
        actor: { kind: "operator" },
        data: { name: "acme", reason: null, note: null, notified: false },
      },
      {
        action: "content.accessed",
        actor: { kind: "system" },
        data: { reason: "phishing_or_malware", emails: 1, fields: "subject, rendered text" },
      },
    ]);
    expect(JSON.stringify(items)).not.toMatch(/monitor|lure kit|report|risk|score/);

    // The review page keeps all of it.
    const { audit } = await operator.console.safety.review({ teamId });
    expect(audit.filter((row) => row.action.startsWith("monitor.")).map((r) => r.action)).toEqual([
      "monitor.override_cleared",
      "monitor.override_set",
      "monitor.broadcasts_resumed",
      "monitor.broadcasts_paused",
    ]);
    expect(audit.find((row) => row.action === "team.broadcasts_paused")?.data).toEqual({
      name: "acme",
      reason: "report",
      note: "lure kit seen",
      notified: false,
    });
  });

  it("is forbidden for members", async () => {
    const teamId = await createTeam(db, "acme");
    await addMember(teamId, "bob", "member");
    await expect(callerFor("bob", teamId, "member").audit.list({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
