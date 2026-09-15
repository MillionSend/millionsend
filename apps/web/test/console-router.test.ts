import { recordAudit } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setRegionAccountDeps } from "@/server/console/ses-regions";
import type { TeamRole } from "@/server/membership";
import { createCaller } from "@/server/routers";

// The console kicks the quota drain after a raise; no pg-boss in tests.
vi.mock("@/server/queue", () => ({
  getQueue: async () => ({ runCronNow: async () => {} }),
  enqueueEmailSend: async () => {},
  enqueueWebhookDeliveries: async () => {},
  enqueueRecipientErase: async () => {},
}));

let db: Db;
let close: () => Promise<void>;
let teamId: string;

const OPERATOR = "op";
const MEMBER = "bob";
const REGION = process.env.AWS_REGION || "us-east-1";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.user).values([
    { id: OPERATOR, name: "Operator", email: "op@example.com", createdAt: new Date(0) },
    { id: MEMBER, name: "Bob", email: "bob@example.com", createdAt: new Date(1) },
  ]);
  teamId = await createTeam(db, "acme");
  await db.insert(schema.teamMembers).values({ teamId, userId: MEMBER, role: "owner" });
});
afterAll(() => close());

beforeEach(() => {
  setRegionAccountDeps({
    accountClient: () => ({
      async send() {
        return {
          SendingEnabled: true,
          ProductionAccessEnabled: true,
          SendQuota: { Max24HourSend: 1000, SentLast24Hours: 10, MaxSendRate: 14 },
          EnforcementStatus: "HEALTHY",
          PricingAttributes: { CurrentPlan: "NONE" },
        };
      },
    }),
  });
});
afterEach(() => {
  setRegionAccountDeps(null);
  vi.unstubAllEnvs();
});

function callerFor(
  userId: string | null,
  team: string | null = null,
  role: TeamRole | null = null,
) {
  return createCaller({
    db,
    session: userId
      ? {
          user: { id: userId, email: `${userId}@example.com`, name: userId },
          session: { id: `s-${userId}`, createdAt: new Date() },
        }
      : null,
    teamId: team,
    role,
  });
}

const operator = () => callerFor(OPERATOR);
const member = () => callerFor(MEMBER, teamId, "owner");

async function team(id: string = teamId) {
  const [row] = await db.select().from(schema.teams).where(eq(schema.teams.id, id));
  if (!row) throw new Error("team missing");
  return row;
}

async function auditRows(action: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, action))
    .orderBy(desc(schema.auditLog.createdAt));
}

describe("operatorProcedure", () => {
  it("lets the first registered user in and nobody else", async () => {
    const summary = await operator().console.overview.summary();
    expect(summary.teams.total).toBeGreaterThanOrEqual(1);
    expect(summary.regions.serving).toBeGreaterThanOrEqual(1);
    const list = await operator().console.teams.list({});
    expect(list.items.map((t) => t.id)).toContain(teamId);

    await expect(member().console.overview.summary()).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(member().console.teams.list({})).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(null).console.teams.list({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it.each(["true", "false"])("gates the same way with IS_CLOUD=%s", async (flag) => {
    vi.stubEnv("IS_CLOUD", flag);
    const list = await operator().console.teams.list({});
    expect(list.items.map((t) => t.id)).toContain(teamId);
    await expect(member().console.teams.list({})).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("console.teams.changePlan", () => {
  it("refuses a team Stripe manages", async () => {
    const managed = await createTeam(db, "managed");
    await db
      .update(schema.teams)
      .set({ stripeSubscriptionId: "sub_123", planStatus: "active" })
      .where(eq(schema.teams.id, managed));
    await expect(
      operator().console.teams.changePlan({ id: managed, plan: "pro", planQuota: 100_000 }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await team(managed)).plan).toBe("free");

    // An ended subscription leaves the plan to the operator.
    await db
      .update(schema.teams)
      .set({ planStatus: "canceled" })
      .where(eq(schema.teams.id, managed));
    await operator().console.teams.changePlan({ id: managed, plan: "pro", planQuota: 100_000 });
    expect((await team(managed)).plan).toBe("pro");
  });

  it("writes the rung and records billing.plan_changed", async () => {
    await operator().console.teams.changePlan({ id: teamId, plan: "pro", planQuota: 100_000 });
    expect(await team()).toMatchObject({ plan: "pro", planQuota: 100_000 });
    const [row] = await auditRows("billing.plan_changed");
    expect(row).toMatchObject({
      teamId,
      actorId: `user:${OPERATOR}`,
      target: `team:${teamId}`,
      data: {
        from: { plan: "free", planQuota: null },
        to: { plan: "pro", planQuota: 100_000 },
      },
    });
  });
});

describe("console.teams.adjustLimits", () => {
  it("writes the ceiling and the pause, recording both", async () => {
    await operator().console.teams.adjustLimits({
      id: teamId,
      dailySendCeiling: 500,
      broadcastsPaused: true,
    });
    const row = await team();
    expect(row.dailySendCeiling).toBe(500);
    expect(row.broadcastsPausedByOperatorAt).toBeInstanceOf(Date);
    expect((await auditRows("team.limits_updated"))[0]).toMatchObject({
      teamId,
      actorId: `user:${OPERATOR}`,
      data: { dailySendCeiling: 500, broadcastsPaused: true },
    });
    expect((await auditRows("team.broadcasts_paused"))[0]).toMatchObject({
      teamId,
      actorId: `user:${OPERATOR}`,
      data: { reason: "manual" },
    });

    // Clearing both: no second pause row, a resume row.
    await operator().console.teams.adjustLimits({
      id: teamId,
      dailySendCeiling: null,
      broadcastsPaused: false,
    });
    expect(await team()).toMatchObject({
      dailySendCeiling: null,
      broadcastsPausedByOperatorAt: null,
    });
    expect(await auditRows("team.broadcasts_paused")).toHaveLength(1);
    expect(await auditRows("team.broadcasts_resumed")).toHaveLength(1);
  });
});

describe("pause, resume, suspend, reinstate", () => {
  it("pauseBroadcasts / resumeBroadcasts flip the column and record the actor", async () => {
    await operator().console.teams.pauseBroadcasts({ id: teamId, reason: "report", notify: false });
    expect((await team()).broadcastsPausedByOperatorAt).toBeInstanceOf(Date);
    expect((await auditRows("team.broadcasts_paused"))[0]).toMatchObject({
      teamId,
      actorId: `user:${OPERATOR}`,
      data: { reason: "report", notified: false },
    });

    await operator().console.teams.resumeBroadcasts({ id: teamId });
    expect((await team()).broadcastsPausedByOperatorAt).toBeNull();
    expect((await auditRows("team.broadcasts_resumed"))[0]).toMatchObject({
      teamId,
      actorId: `user:${OPERATOR}`,
    });
  });

  it("suspend / reinstate write the columns and the audit rows", async () => {
    await operator().console.teams.suspend({
      id: teamId,
      reason: "manual",
      note: "asked",
      notify: false,
    });
    expect(await team()).toMatchObject({ suspensionReason: "manual", suspensionNote: "asked" });
    expect((await team()).suspendedAt).toBeInstanceOf(Date);
    expect((await auditRows("team.suspended"))[0]).toMatchObject({
      teamId,
      actorId: `user:${OPERATOR}`,
      data: { reason: "manual", note: "asked", notified: false },
    });
    // The suspension shows on the trust & safety list through a manual flag.
    const [flag] = await db
      .select()
      .from(schema.teamFlags)
      .where(eq(schema.teamFlags.teamId, teamId));
    expect(flag).toMatchObject({
      reason: "manual",
      status: "open",
      note: "asked",
      openedBy: OPERATOR,
    });

    await operator().console.teams.reinstate({ id: teamId });
    expect(await team()).toMatchObject({
      suspendedAt: null,
      suspensionReason: null,
      suspensionNote: null,
    });
    expect((await auditRows("team.reinstated"))[0]).toMatchObject({
      teamId,
      actorId: `user:${OPERATOR}`,
      data: { reason: "manual" },
    });
    await db.delete(schema.teamFlags).where(eq(schema.teamFlags.teamId, teamId));
  });

  it("members cannot reach any of it", async () => {
    await expect(
      member().console.teams.suspend({ id: teamId, reason: "manual" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("console.safety flags", () => {
  it("opens, refuses a second, clears and reopens with audit rows", async () => {
    await operator().console.safety.openFlag({ teamId, note: "looks off" });
    const [flag] = await db
      .select()
      .from(schema.teamFlags)
      .where(eq(schema.teamFlags.teamId, teamId));
    expect(flag).toMatchObject({ reason: "manual", status: "open", openedBy: OPERATOR });
    expect((await auditRows("console.flag_opened"))[0]).toMatchObject({
      teamId,
      actorId: `user:${OPERATOR}`,
      target: `team_flag:${flag?.id}`,
      data: { note: "looks off" },
    });

    await expect(
      operator().console.safety.openFlag({ teamId, note: "again" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    if (!flag) throw new Error("flag missing");
    await operator().console.safety.clearFlag({ flagId: flag.id });
    const [cleared] = await db
      .select()
      .from(schema.teamFlags)
      .where(eq(schema.teamFlags.id, flag.id));
    expect(cleared).toMatchObject({ status: "cleared", clearedBy: OPERATOR });
    expect(cleared?.clearedAt).toBeInstanceOf(Date);
    expect((await auditRows("console.flag_cleared"))[0]).toMatchObject({
      teamId,
      actorId: `user:${OPERATOR}`,
      target: `team_flag:${flag.id}`,
    });

    await operator().console.safety.reopenFlag({ flagId: flag.id });
    const flags = await db
      .select()
      .from(schema.teamFlags)
      .where(eq(schema.teamFlags.teamId, teamId));
    expect(flags).toHaveLength(2);
    expect(flags.find((f) => f.status === "open")).toMatchObject({
      reason: "manual",
      note: "looks off",
      openedBy: OPERATOR,
    });
    expect((await auditRows("console.flag_reopened"))[0]).toMatchObject({
      teamId,
      actorId: `user:${OPERATOR}`,
      target: `team_flag:${flags.find((f) => f.status === "open")?.id}`,
      data: { from: flag.id },
    });
    await expect(operator().console.safety.reopenFlag({ flagId: flag.id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });
});

describe("console.regions hold / release", () => {
  it("holds the served region by hand and releases it, with audit rows", async () => {
    vi.stubEnv("AWS_REGIONS", "");
    vi.stubEnv("AWS_REGION", REGION);
    await operator().console.regions.hold({ region: REGION, reason: "incident" });
    const [held] = await db
      .select()
      .from(schema.regionBreakers)
      .where(eq(schema.regionBreakers.region, REGION));
    expect(held).toMatchObject({ paused: true, manualReason: "incident", reason: null });
    expect(held?.pausedAt).toBeInstanceOf(Date);
    expect((await auditRows("region.breaker_opened"))[0]).toMatchObject({
      teamId: null,
      actorId: `user:${OPERATOR}`,
      target: `region:${REGION}`,
      data: { reason: "incident", manual: true },
    });

    await operator().console.regions.release({ region: REGION });
    const [released] = await db
      .select()
      .from(schema.regionBreakers)
      .where(eq(schema.regionBreakers.region, REGION));
    expect(released).toMatchObject({ paused: false, manualReason: null, pausedAt: null });
    expect((await auditRows("region.breaker_closed"))[0]).toMatchObject({
      teamId: null,
      actorId: `user:${OPERATOR}`,
      target: `region:${REGION}`,
    });
  });

  it("refuses a region the instance does not serve", async () => {
    vi.stubEnv("AWS_REGIONS", "");
    vi.stubEnv("AWS_REGION", REGION);
    const unserved = REGION === "ap-south-1" ? "eu-west-3" : "ap-south-1";
    await expect(
      operator().console.regions.hold({ region: unserved, reason: "nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("console.audit.list", () => {
  it("lists operator and team rows newest first, filters by action, hides plain member actions", async () => {
    // A member's own key action never reaches the instance audit; a team.*
    // action does, whoever performed it.
    await recordAudit(db, {
      teamId,
      actor: { userId: MEMBER },
      action: "api_key.created",
      metadata: { name: "CI" },
    });
    await recordAudit(db, {
      teamId,
      actor: { userId: MEMBER },
      action: "team.created",
      metadata: { name: "acme" },
    });

    const page = await operator().console.audit.list({ limit: 100 });
    const actions = page.items.map((r) => r.action);
    expect(actions).not.toContain("api_key.created");
    expect(actions).toContain("team.created");
    for (const action of [
      "billing.plan_changed",
      "team.limits_updated",
      "team.suspended",
      "team.reinstated",
      "console.flag_opened",
      "region.breaker_opened",
    ]) {
      expect(actions).toContain(action);
    }
    const times = page.items.map((r) => r.createdAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(page.items.find((r) => r.action === "team.created")).toMatchObject({
      teamName: "acme",
      actor: { kind: "user", id: MEMBER, email: "bob@example.com" },
    });

    const filtered = await operator().console.audit.list({ action: "team.suspended" });
    expect(filtered.items.map((r) => r.action)).toEqual(["team.suspended"]);
    expect(filtered.total).toBe(1);

    await expect(member().console.audit.list({})).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
