import { recordAudit, upgradesHeld } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setRegionAccountDeps } from "@/server/console/ses-regions";
import type { TeamRole } from "@/server/membership";
import { createCaller } from "@/server/routers";
import { setConsoleTeamsDeps } from "@/server/routers/console/teams";

const h = vi.hoisted(() => ({ sent: [] as { to: string; subject: string }[] }));
vi.mock("@/server/system-mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/system-mail")>();
  return {
    ...actual,
    sendAccountMail: (m: { to: string; subject: string }) => void h.sent.push(m),
  };
});

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

// After console.audit.list, which counts the suspensions before it.
describe("the flag a suspension opens", () => {
  const flagsOf = (id: string) =>
    db
      .select()
      .from(schema.teamFlags)
      .where(eq(schema.teamFlags.teamId, id))
      .orderBy(schema.teamFlags.openedAt);

  it("is cleared by the reinstatement, so a team that paid up can upgrade again", async () => {
    const paid = await createTeam(db, "paid-up");
    await operator().console.teams.suspend({ id: paid, reason: "non_payment", notify: false });
    const [opened] = await flagsOf(paid);
    if (!opened) throw new Error("flag missing");
    expect(opened).toMatchObject({
      reason: "manual",
      status: "open",
      openedBy: OPERATOR,
      detail: { suspension: true },
    });

    await operator().console.teams.reinstate({ id: paid });
    expect(await flagsOf(paid)).toMatchObject([
      { id: opened.id, status: "cleared", clearedBy: OPERATOR },
    ]);
    expect((await auditRows("console.flag_cleared"))[0]).toMatchObject({
      teamId: paid,
      actorId: `user:${OPERATOR}`,
      target: `team_flag:${opened.id}`,
      data: { reason: "manual" },
    });
    expect(await upgradesHeld(db, paid)).toBe(false);
  });

  it("leaves any other open flag open, a reopened one included", async () => {
    // An operator's flag from before the suspension: the suspension opens none.
    const watched = await createTeam(db, "watched");
    await operator().console.safety.openFlag({ teamId: watched, note: "keep an eye" });
    await operator().console.teams.suspend({ id: watched, reason: "manual", notify: false });
    await operator().console.teams.reinstate({ id: watched });
    expect(await flagsOf(watched)).toMatchObject([{ status: "open", note: "keep an eye" }]);
    expect(await upgradesHeld(db, watched)).toBe(true);

    // Reopened, the suspension's flag is the operator's own: the next
    // reinstatement leaves it open.
    const reopened = await createTeam(db, "reopened");
    await operator().console.teams.suspend({ id: reopened, reason: "manual", notify: false });
    await operator().console.teams.reinstate({ id: reopened });
    const [cleared] = await flagsOf(reopened);
    if (!cleared) throw new Error("flag missing");
    await operator().console.safety.reopenFlag({ flagId: cleared.id });
    await operator().console.teams.suspend({ id: reopened, reason: "manual", notify: false });
    await operator().console.teams.reinstate({ id: reopened });
    const open = (await flagsOf(reopened)).filter((f) => f.status === "open");
    expect(open).toMatchObject([{ reason: "manual", openedBy: OPERATOR }]);
    expect(open[0]?.detail).toEqual({});
    expect(await upgradesHeld(db, reopened)).toBe(true);
  });

  it("reopening records the operator, so a reopened score flag holds upgrades; the cron's does not", async () => {
    const scored = await createTeam(db, "scored");
    const [flag] = await db
      .insert(schema.teamFlags)
      .values({ teamId: scored, reason: "score", detail: { metric: "score", scoreTenths: 40 } })
      .returning({ id: schema.teamFlags.id });
    if (!flag) throw new Error("flag missing");
    expect(await upgradesHeld(db, scored)).toBe(false);

    await operator().console.safety.clearFlag({ flagId: flag.id });
    await operator().console.safety.reopenFlag({ flagId: flag.id });
    expect((await flagsOf(scored)).find((f) => f.status === "open")).toMatchObject({
      reason: "score",
      openedBy: OPERATOR,
      detail: { metric: "score", scoreTenths: 40 },
    });
    expect(await upgradesHeld(db, scored)).toBe(true);
  });
});

describe("console.monitor", () => {
  it("reads every setting with its source, and the judge as off by default", async () => {
    const got = await operator().console.monitor.settings.get();
    expect(got.judge).toEqual({ on: false });
    expect(got.settings).toHaveLength(22);
    expect(got.settings.find((s) => s.key === "firstSends")).toEqual({
      key: "firstSends",
      value: 1000,
      source: "default",
      default: 1000,
      fallback: 1000,
      kind: "count",
    });
    const status = await operator().console.monitor.status();
    expect(status).toMatchObject({
      judge: { on: false },
      today: { sampled: 0, judged: 0, unjudged: 0, flagged: 0 },
      openFlags: 0,
      flagRisk: 0.5,
      alertRisk: 0.7,
    });
    expect(got.settings.find((s) => s.key === "rampRate")).toMatchObject({ fallback: 0.25 });
  });

  it("stores overrides, records only the changed keys, clears with null, and honours env between", async () => {
    const first = await operator().console.monitor.settings.update({
      firstSends: 500,
      autoPause: false,
    });
    expect(first.changed.sort()).toEqual(["autoPause", "firstSends"]);
    const [audit] = await auditRows("instance.monitor_settings_updated");
    expect(audit).toMatchObject({
      actorId: `user:${OPERATOR}`,
      teamId: null,
      data: { firstSends: 500, autoPause: false },
    });
    vi.stubEnv("MONITOR_RAMP_RATE", "0.4");
    const got = await operator().console.monitor.settings.get();
    expect(got.settings.find((s) => s.key === "rampRate")).toMatchObject({ fallback: 0.4 });
    expect(got.settings.find((s) => s.key === "firstSends")).toMatchObject({
      value: 500,
      source: "db",
    });
    expect(got.settings.find((s) => s.key === "autoPause")).toMatchObject({
      value: false,
      source: "db",
    });
    expect(got.settings.find((s) => s.key === "rampRate")).toMatchObject({
      value: 0.4,
      source: "env",
    });
    await operator().console.monitor.settings.update({ firstSends: null });
    expect(
      (await operator().console.monitor.settings.get()).settings.find(
        (s) => s.key === "firstSends",
      ),
    ).toMatchObject({ value: 1000, source: "default" });
    expect(await operator().console.monitor.settings.update({})).toEqual({ changed: [] });
  });

  it("refuses values outside their kind and thresholds out of order", async () => {
    await expect(
      operator().console.monitor.settings.update({ rampRate: 1.5 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "invalid_rampRate" });
    await expect(
      operator().console.monitor.settings.update({ teamDailyCap: -1 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      operator().console.monitor.settings.update({ flagRisk: 0.75 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "thresholds_order" });
    await expect(
      operator().console.monitor.settings.update({ alertRisk: 0.9, pauseRisk: 0.8 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "thresholds_order" });
    expect(
      (await operator().console.monitor.settings.get()).settings.find((s) => s.key === "flagRisk"),
    ).toMatchObject({ value: 0.5 });
  });

  it("shows the judge and today's tallies once the env names a provider", async () => {
    vi.stubEnv("ABUSE_JUDGE", "typesafe");
    vi.stubEnv("ABUSE_JUDGE_API_KEY", "k");
    vi.stubEnv("ABUSE_JUDGE_MODEL", "jev-latest");
    await db.insert(schema.monitorSamples).values([
      { teamId, kind: "first_sends", status: "judged", score: 80 },
      { teamId, kind: "first_sends", status: "judged", score: 10 },
      { teamId, kind: "first_sends", status: "unjudged", errorClass: "timeout" },
    ]);
    const status = await operator().console.monitor.status();
    expect(status.judge).toEqual({
      on: true,
      provider: "typesafe",
      model: "jev-latest",
      region: null,
      baseUrl: "https://api.typesafe.ai",
    });
    expect(status.today).toEqual({ sampled: 3, judged: 2, unjudged: 1, flagged: 1 });
  });

  it("sets and clears the sampling override, and lifts the monitor's pause with the hold", async () => {
    const { until } = await operator().console.monitor.setOverride({ teamId });
    expect(until.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    const [row] = await db
      .select()
      .from(schema.teamMonitor)
      .where(eq(schema.teamMonitor.teamId, teamId));
    expect(row).toMatchObject({ overrideRate: 1, overrideUntil: until });
    expect((await auditRows("monitor.override_set"))[0]).toMatchObject({
      actorId: `user:${OPERATOR}`,
      teamId,
    });
    await operator().console.monitor.clearOverride({ teamId });
    expect((await auditRows("monitor.override_cleared"))[0]).toMatchObject({ teamId });

    const pausedAt = new Date();
    await db
      .update(schema.teamMonitor)
      .set({ broadcastsPausedAt: pausedAt })
      .where(eq(schema.teamMonitor.teamId, teamId));
    await db
      .update(schema.teams)
      .set({ broadcastsPausedByOperatorAt: pausedAt })
      .where(eq(schema.teams.id, teamId));
    expect(await operator().console.monitor.resumeBroadcasts({ teamId })).toEqual({
      resumed: true,
    });
    expect((await team()).broadcastsPausedByOperatorAt).toBeNull();
    expect((await auditRows("monitor.broadcasts_resumed"))[0]).toMatchObject({ teamId });
    expect(await operator().console.monitor.resumeBroadcasts({ teamId })).toEqual({
      resumed: false,
    });

    // Un-pausing through the limits dialog lifts it as well, and stamps the resume.
    await db
      .update(schema.teamMonitor)
      .set({ broadcastsPausedAt: pausedAt, broadcastsResumedAt: null })
      .where(eq(schema.teamMonitor.teamId, teamId));
    await db
      .update(schema.teams)
      .set({ broadcastsPausedByOperatorAt: pausedAt })
      .where(eq(schema.teams.id, teamId));
    await operator().console.teams.adjustLimits({
      id: teamId,
      dailySendCeiling: null,
      broadcastsPaused: false,
    });
    const afterLimits = (
      await db.select().from(schema.teamMonitor).where(eq(schema.teamMonitor.teamId, teamId))
    )[0];
    expect(afterLimits?.broadcastsPausedAt).toBeNull();
    expect(afterLimits?.broadcastsResumedAt).not.toBeNull();
    // The operator's own resume lifts the monitor's pause too.
    await db
      .update(schema.teamMonitor)
      .set({ broadcastsPausedAt: pausedAt })
      .where(eq(schema.teamMonitor.teamId, teamId));
    await db
      .update(schema.teams)
      .set({ broadcastsPausedByOperatorAt: pausedAt })
      .where(eq(schema.teams.id, teamId));
    await operator().console.teams.resumeBroadcasts({ id: teamId });
    expect(
      (await db.select().from(schema.teamMonitor).where(eq(schema.teamMonitor.teamId, teamId)))[0]
        ?.broadcastsPausedAt,
    ).toBeNull();
  });

  it("carries the risk on the safety list and the monitor block on the review", async () => {
    const flagged = await createTeam(db, "flagged-team");
    await db.insert(schema.monitorSamples).values([
      { teamId: flagged, kind: "first_sends", status: "judged", score: 80 },
      { teamId: flagged, kind: "first_sends", status: "judged", score: 10 },
      { teamId: flagged, kind: "first_sends", status: "unjudged", errorClass: "timeout" },
    ]);
    await db
      .insert(schema.teamFlags)
      .values({ teamId: flagged, reason: "monitor", detail: { risk: 0.62, samples: 3 } });
    await db
      .insert(schema.teamStandings)
      .values({ teamId: flagged, guardrail: "ok", monitorRisk: 0.62 });
    const list = await operator().console.safety.list({ sort: "risk", dir: "desc" });
    expect(list.thresholds).toEqual({ flagRisk: 0.5, alertRisk: 0.7 });
    expect(list.items[0]).toMatchObject({
      teamId: flagged,
      reason: "monitor",
      monitorRisk: 0.62,
      detail: { risk: 0.62, samples: 3 },
    });
    const review = await operator().console.safety.review({ teamId: flagged });
    expect(review.monitor).toMatchObject({
      tier: "new",
      risk: null,
      samples7d: 3,
      judged7d: 2,
      flagged7d: 1,
      unjudged7d: 1,
      override: null,
      broadcastsPausedAt: null,
      judge: { on: false },
      flagScore: 70,
    });
    expect(review.monitor.samples).toHaveLength(3);
    expect(review.monitor.samples[0]).not.toHaveProperty("subject");
  });

  it("is operator-only", async () => {
    await expect(member().console.monitor.status()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(member().console.monitor.settings.update({ firstSends: 1 })).rejects.toMatchObject(
      {
        code: "NOT_FOUND",
      },
    );
    await expect(member().console.monitor.setOverride({ teamId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("console.regions reserve", () => {
  it("lists each region's share and sets the reserve, clamped and audited", async () => {
    vi.stubEnv("SES_TRANSACTIONAL_RESERVE", "");
    let list = await operator().console.regions.list();
    expect(list.reserve).toMatchObject({ percent: 30, source: "default", min: 5, max: 90 });
    expect(list.served.find((r) => r.region === REGION)).toMatchObject({
      share: 700,
      usableReserve: 280,
    });
    expect(list.reserve.hint).toMatchObject({ txPeak7d: 0, usableReserveNow: 280, suggested: 30 });

    expect(await operator().console.regions.setReserve({ percent: 40 })).toEqual({ percent: 40 });
    list = await operator().console.regions.list();
    expect(list.reserve).toMatchObject({ percent: 40, source: "db" });
    expect(list.served.find((r) => r.region === REGION)).toMatchObject({
      share: 600,
      usableReserve: 380,
    });

    expect(await operator().console.regions.setReserve({ percent: 2 })).toEqual({ percent: 5 });
    expect(await operator().console.regions.setReserve({ percent: 95 })).toEqual({ percent: 90 });
    const rows = await auditRows("instance.reserve_updated");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.data).toMatchObject({ from: 5, to: 90 });
    expect(rows[0]?.teamId).toBeNull();

    await expect(member().console.regions.setReserve({ percent: 30 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("console.regions pacing numbers", () => {
  it("reads the window split, the backlog and the finish of a send still going out", async () => {
    const [domain] = await db
      .insert(schema.domains)
      .values({ teamId, name: "paced.example", region: REGION, status: "verified" })
      .returning({ id: schema.domains.id });
    if (!domain) throw new Error("domain insert failed");
    const [broadcast] = await db
      .insert(schema.broadcasts)
      .values({
        teamId,
        from: "hi@paced.example",
        subject: "s",
        status: "sending",
        scheduledAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: schema.broadcasts.id });
    if (!broadcast) throw new Error("broadcast insert failed");
    const row = (over: Partial<typeof schema.emails.$inferInsert>) => ({
      teamId,
      domainId: domain.id,
      broadcastId: broadcast.id,
      from: "hi@paced.example",
      to: ["r@example.com"],
      subject: "s",
      ...over,
    });
    await db
      .insert(schema.emails)
      .values([
        row({ latestStatus: "sent", sentAt: new Date(Date.now() - 5 * 60_000) }),
        row({ latestStatus: "queued_quota" }),
        row({ latestStatus: "queued_quota" }),
      ]);
    const list = await operator().console.regions.list();
    const region = list.served.find((r) => r.region === REGION);
    expect(region).toMatchObject({
      bulkSent24h: 1,
      // The stubbed account reports 10 sent: everything past our one bulk send is transactional.
      txSent24h: 9,
      bulkParked: 2,
      waitingBroadcasts: 1,
      txParkedAt: null,
    });
    // The one bulk send in the window takes room off the share, whatever the reserve is.
    expect(region?.room).toBe((region?.share ?? 0) - 1);
    expect(region?.lastFinishesAt).toBeInstanceOf(Date);
    expect(region?.lastFinishesAt?.getTime()).toBeGreaterThan(Date.now());
    // Off the cloud nothing is sold against the quota.
    expect(list.committedPerDay).toBeNull();
    // Twelve transactional sends SES has not counted yet: our own rows are the floor.
    await db
      .insert(schema.emails)
      .values(
        Array.from({ length: 12 }, () =>
          row({ broadcastId: null, latestStatus: "sent", sentAt: new Date(Date.now() - 60_000) }),
        ),
      );
    const lagging = await operator().console.regions.list();
    expect(lagging.served.find((r) => r.region === REGION)?.txSent24h).toBe(12);
    await db.delete(schema.emails).where(eq(schema.emails.domainId, domain.id));
    await db.delete(schema.broadcasts).where(eq(schema.broadcasts.id, broadcast.id));
    await db.delete(schema.domains).where(eq(schema.domains.id, domain.id));
  });
});

describe("console.regions during a region hold", () => {
  it("keeps the metric and rate for the operator while the team sees only a delay", async () => {
    vi.stubEnv("AWS_REGIONS", "");
    vi.stubEnv("AWS_REGION", REGION);
    const [domain] = await db
      .insert(schema.domains)
      .values({ teamId, name: "held.example", region: REGION, status: "verified" })
      .returning({ id: schema.domains.id });
    const [broadcast] = await db
      .insert(schema.broadcasts)
      .values({
        teamId,
        from: "hi@held.example",
        subject: "s",
        status: "scheduled",
        scheduledAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: schema.broadcasts.id });
    if (!domain || !broadcast) throw new Error("seed failed");
    const reason = {
      metric: "complaint" as const,
      rate: 0.0009,
      limit: 0.001,
      windowHours: 24,
      sent: 5000,
      events: 5,
    };
    await db.delete(schema.regionBreakers);
    await db
      .insert(schema.regionBreakers)
      .values({ region: REGION, paused: true, reason, pausedAt: new Date() });

    const list = await operator().console.regions.list();
    expect(list.served.find((r) => r.region === REGION)?.breaker).toMatchObject({
      paused: true,
      manualReason: null,
      reason,
    });

    const { items } = await member().broadcasts.list({});
    expect(items.find((b) => b.id === broadcast.id)?.held).toBe(true);
    expect(JSON.stringify(items)).not.toMatch(/complaint|0\.0009|0\.09|review/i);

    await db.delete(schema.regionBreakers);
    await db.delete(schema.broadcasts).where(eq(schema.broadcasts.id, broadcast.id));
    await db.delete(schema.domains).where(eq(schema.domains.id, domain.id));
  });
});

describe("suspend / reinstate and the team's SES tenant", () => {
  let tenantTeam: string;
  const arn = (region: string) => `arn:aws:ses:${region}:123456789012:tenant/${tenantTeam}/tn-1`;

  beforeAll(async () => {
    tenantTeam = await createTeam(db, "tenant-team");
    await db.insert(schema.domains).values([
      { teamId: tenantTeam, name: "acme.dev", region: "us-east-1" },
      { teamId: tenantTeam, name: "acme.com.br", region: "sa-east-1" },
    ]);
  });
  afterEach(() => setConsoleTeamsDeps(null));

  /** One fake SESv2 client per region; a region named in `fail` throws that error on every call. */
  function fakeTenants(fail: Record<string, string> = {}) {
    const calls: { region: string; name: string; input: Record<string, unknown> }[] = [];
    const retried: string[] = [];
    setConsoleTeamsDeps({
      tenantClient: (region) => ({
        async send(command) {
          const name = command.constructor.name;
          calls.push({
            region,
            name,
            input: (command as unknown as { input: Record<string, unknown> }).input,
          });
          const error = fail[region];
          if (error) throw Object.assign(new Error(error), { name: error });
          return name === "GetTenantCommand" ? { Tenant: { TenantArn: arn(region) } } : {};
        },
      }),
      retryTenantStatus: async (id) => void retried.push(id),
    });
    const updates = () =>
      calls
        .filter((c) => c.name === "UpdateReputationEntityCustomerManagedStatusCommand")
        .map((c) => c.input);
    return { calls, retried, updates };
  }

  const status = (region: string, SendingStatus: string) => ({
    ReputationEntityType: "RESOURCE",
    ReputationEntityReference: arn(region),
    SendingStatus,
  });

  it("suspend disables the tenant in every region the team has a domain in; reinstate enables it", async () => {
    vi.stubEnv("SES_TENANTS", "true");
    const ses = fakeTenants();

    const suspended = await operator().console.teams.suspend({
      id: tenantTeam,
      reason: "phishing",
    });
    expect(ses.updates()).toEqual([
      status("sa-east-1", "DISABLED"),
      status("us-east-1", "DISABLED"),
    ]);
    expect(ses.calls.filter((c) => c.name === "GetTenantCommand").map((c) => c.input)).toEqual([
      { TenantName: tenantTeam },
      { TenantName: tenantTeam },
    ]);
    expect(suspended.tenant).toEqual({
      status: "DISABLED",
      updated: ["sa-east-1", "us-east-1"],
      failed: [],
    });
    expect((await auditRows("team.ses_tenant_updated"))[0]).toMatchObject({
      teamId: null,
      target: `team:${tenantTeam}`,
      actorId: `user:${OPERATOR}`,
      data: { team: "tenant-team", status: "DISABLED", regions: "sa-east-1, us-east-1" },
    });

    ses.calls.length = 0;
    const reinstated = await operator().console.teams.reinstate({ id: tenantTeam });
    expect(ses.updates()).toEqual([status("sa-east-1", "ENABLED"), status("us-east-1", "ENABLED")]);
    expect(reinstated.tenant?.status).toBe("ENABLED");
    expect(ses.retried).toEqual([]);
  });

  it("a failing AWS call still suspends the team, is audited and handed to the worker's retry", async () => {
    vi.stubEnv("SES_TENANTS", "true");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ses = fakeTenants({ "us-east-1": "AccessDeniedException" });

    const { tenant } = await operator().console.teams.suspend({
      id: tenantTeam,
      reason: "phishing",
    });
    expect((await team(tenantTeam)).suspendedAt).toBeInstanceOf(Date);
    expect(ses.updates()).toEqual([status("sa-east-1", "DISABLED")]);
    expect(tenant).toEqual({
      status: "DISABLED",
      updated: ["sa-east-1"],
      failed: [{ region: "us-east-1", error: "AccessDeniedException" }],
    });
    expect(ses.retried).toEqual([tenantTeam]);
    expect((await auditRows("team.ses_tenant_update_failed"))[0]).toMatchObject({
      teamId: null,
      target: `team:${tenantTeam}`,
      actorId: `user:${OPERATOR}`,
      data: {
        team: "tenant-team",
        status: "DISABLED",
        regions: "sa-east-1",
        failed: "us-east-1 (AccessDeniedException)",
        retrying: true,
      },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    await operator().console.teams.reinstate({ id: tenantTeam });
    warn.mockRestore();
  });

  it("tenant rows are the operator's: never in the owner's audit log, always in the console's", async () => {
    vi.stubEnv("SES_TENANTS", "true");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const actions = ["team.ses_tenant_updated", "team.ses_tenant_update_failed"];
    fakeTenants({ "us-east-1": "AccessDeniedException" });
    await operator().console.teams.suspend({ id: tenantTeam, reason: "phishing" });
    fakeTenants();
    await operator().console.teams.reinstate({ id: tenantTeam });
    warn.mockRestore();

    const owner = await callerFor(MEMBER, tenantTeam, "owner").audit.list({ limit: 50 });
    expect(owner.items.map((r) => r.action)).toContain("team.suspended");
    expect(owner.items.filter((r) => actions.includes(r.action))).toEqual([]);

    const review = await operator().console.safety.review({ teamId: tenantTeam });
    const reviewed = review.audit.filter((r) => actions.includes(r.action));
    expect(reviewed.slice(0, 2).map((r) => [r.action, r.target])).toEqual([
      ["team.ses_tenant_updated", `team:${tenantTeam}`],
      ["team.ses_tenant_update_failed", `team:${tenantTeam}`],
    ]);

    const instance = await operator().console.audit.list({
      action: "team.ses_tenant_update_failed",
    });
    expect(instance.items[0]).toMatchObject({
      teamId: null,
      target: `team:${tenantTeam}`,
      data: { team: "tenant-team", retrying: true },
    });
  });

  it("is a no-op without SES tenants", async () => {
    vi.stubEnv("SES_TENANTS", "false");
    const ses = fakeTenants();
    const rows = async () =>
      (await auditRows("team.ses_tenant_updated")).length +
      (await auditRows("team.ses_tenant_update_failed")).length;
    const before = await rows();

    const suspended = await operator().console.teams.suspend({ id: tenantTeam, reason: "manual" });
    const reinstated = await operator().console.teams.reinstate({ id: tenantTeam });
    expect(suspended.tenant).toBeNull();
    expect(reinstated.tenant).toBeNull();
    expect(ses.calls).toEqual([]);
    expect(ses.retried).toEqual([]);
    expect(await rows()).toBe(before);
  });
});

// Last: the audit log is append-only, and the audit tests above count suspensions.
describe("review holds", () => {
  it("a review hold converts to phishing or is released without a word to the owner", async () => {
    vi.stubEnv("AUTH_EMAIL_FROM", "MillionSend <no-reply@millionsend.test>");
    const heldTeam = await createTeam(db, "held");
    await db.insert(schema.teamMembers).values({ teamId: heldTeam, userId: MEMBER, role: "owner" });
    const heldAt = new Date("2026-10-09T12:03:00Z");
    const hold = () =>
      db
        .update(schema.teams)
        .set({ suspendedAt: heldAt, suspensionReason: "review" })
        .where(eq(schema.teams.id, heldTeam));
    h.sent = [];

    await hold();
    await operator().console.teams.suspend({ id: heldTeam, reason: "phishing" });
    expect(await team(heldTeam)).toMatchObject({
      suspendedAt: heldAt,
      suspensionReason: "phishing",
    });
    expect((await auditRows("team.suspended"))[0]).toMatchObject({
      teamId: heldTeam,
      data: { reason: "phishing", notified: false },
    });

    await hold();
    await operator().console.teams.reinstate({ id: heldTeam });
    expect(await team(heldTeam)).toMatchObject({ suspendedAt: null, suspensionReason: null });
    expect(h.sent).toEqual([]);

    // The same release of an ordinary suspension does tell the owner.
    await operator().console.teams.suspend({ id: heldTeam, reason: "manual", notify: false });
    await operator().console.teams.reinstate({ id: heldTeam });
    expect(h.sent.map((m) => m.to)).toEqual(["bob@example.com"]);
  });

  it("releasing a hold clears the monitor flag it kept open, as the operator, out of the team's log", async () => {
    const heldTeam = await createTeam(db, "released");
    await db.insert(schema.teamMembers).values({ teamId: heldTeam, userId: MEMBER, role: "owner" });
    const openFlags = (id: string) =>
      db
        .select()
        .from(schema.teamFlags)
        .where(and(eq(schema.teamFlags.teamId, id), eq(schema.teamFlags.status, "open")));
    // What the hold leaves behind: a review suspension and the monitor's own flag.
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date(), suspensionReason: "review" })
      .where(eq(schema.teams.id, heldTeam));
    const [flag] = await db
      .insert(schema.teamFlags)
      .values({ teamId: heldTeam, reason: "monitor", detail: { risk: 0.62, samples: 3 } })
      .returning();
    if (!flag) throw new Error("flag missing");

    await operator().console.teams.reinstate({ id: heldTeam });
    const [cleared] = await db
      .select()
      .from(schema.teamFlags)
      .where(eq(schema.teamFlags.id, flag.id));
    expect(cleared).toMatchObject({ status: "cleared", clearedBy: OPERATOR });
    expect(await openFlags(heldTeam)).toEqual([]);
    expect((await auditRows("console.flag_cleared"))[0]).toMatchObject({
      teamId: null,
      actorId: `user:${OPERATOR}`,
      target: `team:${heldTeam}`,
      data: { team: "released", flagId: flag.id, reason: "monitor" },
    });
    const owner = await callerFor(MEMBER, heldTeam, "owner").audit.list({ limit: 50 });
    expect(owner.items.map((r) => r.action)).not.toContain("console.flag_cleared");
    const review = await operator().console.safety.review({ teamId: heldTeam });
    expect(review.audit.map((r) => r.action)).toContain("console.flag_cleared");

    // Any other reinstatement leaves an open monitor flag to the safety cron.
    const other = await createTeam(db, "suspended");
    await db
      .insert(schema.teamFlags)
      .values({ teamId: other, reason: "monitor", detail: { risk: 0.62, samples: 3 } });
    await operator().console.teams.suspend({ id: other, reason: "manual", notify: false });
    await operator().console.teams.reinstate({ id: other });
    expect(await openFlags(other)).toMatchObject([{ reason: "monitor", openedBy: null }]);
  });

  it("releasing a hold lifts the monitor's broadcast pause from before it, as Resume does", async () => {
    const pausedAt = new Date("2026-10-09T11:40:00Z");
    const pauseBroadcasts = async (id: string, byMonitor: boolean) => {
      await db
        .update(schema.teams)
        .set({ broadcastsPausedByOperatorAt: pausedAt })
        .where(eq(schema.teams.id, id));
      if (byMonitor) {
        await db.insert(schema.teamMonitor).values({ teamId: id, broadcastsPausedAt: pausedAt });
      }
    };
    const hold = (id: string) =>
      db
        .update(schema.teams)
        .set({ suspendedAt: new Date(), suspensionReason: "review" })
        .where(eq(schema.teams.id, id));
    const monitorRow = async (id: string) =>
      (await db.select().from(schema.teamMonitor).where(eq(schema.teamMonitor.teamId, id)))[0];

    // A verdict past the pause line paused broadcasts; a later one held the team.
    const heldTeam = await createTeam(db, "paused-then-held");
    await db.insert(schema.teamMembers).values({ teamId: heldTeam, userId: MEMBER, role: "owner" });
    await pauseBroadcasts(heldTeam, true);
    await hold(heldTeam);
    const owner = () => callerFor(MEMBER, heldTeam, "owner");
    expect(await owner().team.standing()).toMatchObject({ pendingReview: true });

    await operator().console.teams.reinstate({ id: heldTeam });
    expect(await owner().team.standing()).toMatchObject({
      suspended: null,
      broadcastsPausedByOperatorAt: null,
      pendingReview: false,
    });
    const monitor = await monitorRow(heldTeam);
    expect(monitor?.broadcastsPausedAt).toBeNull();
    expect(monitor?.broadcastsResumedAt).not.toBeNull();
    expect((await auditRows("monitor.broadcasts_resumed"))[0]).toMatchObject({
      teamId: heldTeam,
      actorId: `user:${OPERATOR}`,
    });

    // An operator's own pause is not the monitor's to lift.
    const operatorPaused = await createTeam(db, "operator-paused-then-held");
    await pauseBroadcasts(operatorPaused, false);
    await hold(operatorPaused);
    await operator().console.teams.reinstate({ id: operatorPaused });
    expect((await team(operatorPaused)).broadcastsPausedByOperatorAt).toEqual(pausedAt);

    // Any other reinstatement leaves the monitor's pause to Resume.
    const suspended = await createTeam(db, "paused-then-suspended");
    await pauseBroadcasts(suspended, true);
    await operator().console.teams.suspend({ id: suspended, reason: "manual", notify: false });
    await operator().console.teams.reinstate({ id: suspended });
    expect((await team(suspended)).broadcastsPausedByOperatorAt).toEqual(pausedAt);
    expect((await monitorRow(suspended))?.broadcastsPausedAt).toEqual(pausedAt);
  });

  it("refuses a review hold from the console's suspend: only the monitor holds", async () => {
    const id = await createTeam(db, "never-held");
    await expect(
      // @ts-expect-error — the input enum leaves the review reason out
      operator().console.teams.suspend({ id, reason: "review", notify: false }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await team(id)).toMatchObject({ suspendedAt: null, suspensionReason: null });
    expect(await auditRows("team.suspended")).not.toContainEqual(
      expect.objectContaining({ teamId: id }),
    );
  });
});
