import { randomUUID } from "node:crypto";
import type { BillingStripe } from "@millionsend/billing";
import { DAY_MS, recordAudit, upgradesHeld, utcDay } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
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
    expect(got.settings).toHaveLength(30);
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

  it("reports the warm-up on by default for the cloud only", async () => {
    const warmup = async () =>
      (await operator().console.monitor.settings.get()).settings.find(
        (s) => s.key === "warmupEnabled",
      );
    expect(await warmup()).toMatchObject({ value: false, source: "default", default: false });
    vi.stubEnv("IS_CLOUD", "true");
    expect(await warmup()).toMatchObject({
      value: true,
      source: "default",
      default: true,
      fallback: true,
    });
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

  it("refuses a count past its int4 column, storing nothing", async () => {
    const teamDailyCap = async () =>
      (await operator().console.monitor.settings.get()).settings.find(
        (s) => s.key === "teamDailyCap",
      );
    const before = await teamDailyCap();
    await expect(
      operator().console.monitor.settings.update({ teamDailyCap: 3_000_000_000 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await teamDailyCap()).toEqual(before);
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

describe("console.safety.setWarmupTrust", () => {
  it("trusts one domain or the whole team, audited on the instance's log, operator only", async () => {
    const warm = await createTeam(db, "warm-trust");
    await db.insert(schema.teamMembers).values({ teamId: warm, userId: MEMBER, role: "owner" });
    const [domain] = await db
      .insert(schema.domains)
      .values({
        teamId: warm,
        name: "mail.fresh-trust.com",
        region: REGION,
        status: "verified",
        registeredAt: new Date(),
        ageSource: "rdap",
      })
      .returning({ id: schema.domains.id });
    if (!domain) throw new Error("domain insert failed");
    await expect(
      callerFor(MEMBER, warm, "owner").console.safety.setWarmupTrust({
        teamId: warm,
        trusted: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      operator().console.safety.setWarmupTrust({ teamId, domainId: domain.id, trusted: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await operator().console.safety.setWarmupTrust({
      teamId: warm,
      domainId: domain.id,
      trusted: true,
    });
    const domainTrust = async () =>
      (
        await db
          .select({ at: schema.domains.warmupTrustedAt })
          .from(schema.domains)
          .where(eq(schema.domains.id, domain.id))
      )[0]?.at ?? null;
    expect(await domainTrust()).toBeInstanceOf(Date);
    expect((await auditRows("warmup.trust_granted"))[0]).toMatchObject({
      teamId: null,
      target: `team:${warm}`,
      actorId: `user:${OPERATOR}`,
      data: { team: "warm-trust", domain: "mail.fresh-trust.com" },
    });

    await operator().console.safety.setWarmupTrust({ teamId: warm, trusted: true });
    expect((await team(warm)).warmupTrustedAt).toBeInstanceOf(Date);
    await operator().console.safety.setWarmupTrust({ teamId: warm, trusted: false });
    expect((await team(warm)).warmupTrustedAt).toBeNull();
    expect((await auditRows("warmup.trust_revoked"))[0]).toMatchObject({
      teamId: null,
      target: `team:${warm}`,
      data: { team: "warm-trust" },
    });

    const review = await operator().console.safety.review({ teamId: warm });
    expect(review.warmup.trustedAt).toBeNull();
    expect(review.warmup.domains).toMatchObject([
      { name: "mail.fresh-trust.com", ageSource: "rdap", trustedAt: expect.any(Date) },
    ]);
    // The owner's own audit log never shows the lever.
    const own = await callerFor(MEMBER, warm, "owner").audit.list({ limit: 50 });
    expect(own.items.filter((r) => r.action.startsWith("warmup."))).toEqual([]);
  });

  it("counts, per domain and in all, the parked mail a trust would release now", async () => {
    vi.stubEnv("WARMUP_ENABLED", "true");
    const warm = await createTeam(db, "warm-waiting");
    const domain = async (name: string) => {
      const [row] = await db
        .insert(schema.domains)
        .values({
          teamId: warm,
          name,
          region: REGION,
          status: "verified",
          registeredAt: new Date(),
        })
        .returning({ id: schema.domains.id });
      if (!row) throw new Error("domain insert failed");
      return row.id;
    };
    const fresh = await domain("mail.fresh-waiting.example");
    const ramped = await domain("news.ramped-waiting.example");
    await db.insert(schema.domainWarmups).values({
      domainId: ramped,
      teamId: warm,
      volume: 1500,
      startVolume: 1500,
      dailyTarget: 10_000,
    });
    const [broadcast] = await db
      .insert(schema.broadcasts)
      .values({
        teamId: warm,
        from: "news@ramped-waiting.example",
        subject: "s",
        status: "sending",
      })
      .returning({ id: schema.broadcasts.id });
    if (!broadcast) throw new Error("broadcast insert failed");
    const parked = (domainId: string, over: Partial<typeof schema.emails.$inferInsert> = {}) => ({
      teamId: warm,
      domainId,
      from: "hi@waiting.example",
      to: ["r@example.com"],
      subject: "s",
      latestStatus: "queued_quota" as const,
      parkReason: "warmup" as const,
      ...over,
    });
    await db.insert(schema.emails).values([
      parked(fresh),
      parked(fresh),
      parked(fresh, { broadcastId: broadcast.id }),
      // Held by the plan or for an operator, or already on its way: not the warm-up's.
      parked(fresh, { parkReason: null }),
      parked(fresh, { parkReason: "screening" }),
      parked(fresh, { latestStatus: "queued", parkReason: null }),
      parked(ramped),
      // A reputation warm-up lets its broadcasts out by its own day, trusted or not.
      parked(ramped, { broadcastId: broadcast.id }),
      parked(ramped, { broadcastId: broadcast.id }),
    ]);
    const waiting = async () => {
      const { warmup } = await operator().console.safety.review({ teamId: warm });
      return { domains: warmup.domains.map((d) => [d.name, d.waiting]), team: warmup.waiting };
    };
    expect(await waiting()).toEqual({
      domains: [
        ["mail.fresh-waiting.example", 3],
        ["news.ramped-waiting.example", 1],
      ],
      team: 4,
    });
    await db
      .update(schema.domainWarmups)
      .set({ status: "off" })
      .where(eq(schema.domainWarmups.domainId, ramped));
    expect(await waiting()).toEqual({
      domains: [
        ["mail.fresh-waiting.example", 3],
        ["news.ramped-waiting.example", 3],
      ],
      team: 6,
    });
    // Once trusted, what the domain still has parked waits on the drain or the plan, not on a trust.
    await operator().console.safety.setWarmupTrust({
      teamId: warm,
      domainId: fresh,
      trusted: true,
    });
    expect(await waiting()).toEqual({
      domains: [
        ["mail.fresh-waiting.example", 0],
        ["news.ramped-waiting.example", 3],
      ],
      team: 3,
    });
    // Its parked broadcast rows would count in the region tests below.
    await db.delete(schema.teams).where(eq(schema.teams.id, warm));
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
    expect(JSON.stringify(items)).not.toMatch(/complaint|\b0\.0009\b|\b0\.09\b|review/i);

    await db.delete(schema.regionBreakers);
    await db.delete(schema.broadcasts).where(eq(schema.broadcasts.id, broadcast.id));
    await db.delete(schema.domains).where(eq(schema.domains.id, domain.id));
  });
});

describe("console.regions and SES's own complaint rate", () => {
  it("carries the rate the breaker judges, whether SES answered, and the lines", async () => {
    await db.delete(schema.regionBreakers);
    const region = async () =>
      (await operator().console.regions.list()).served.find((r) => r.region === REGION);
    // Never read: our own estimate is judged, on the same line.
    expect(await region()).toMatchObject({ sesComplaintRate: null, sesComplaintRead: false });
    expect((await operator().console.regions.list()).complaintLines).toEqual({
      sesReview: 0.001,
      sesPause: 0.005,
      breaker: 0.004,
    });

    await db
      .insert(schema.regionBreakers)
      .values({ region: REGION, sesComplaintRate: 0.0025, sesComplaintReadAt: new Date() });
    expect(await region()).toMatchObject({
      sesComplaintRate: 0.0025,
      sesComplaintRead: true,
      // A stored reading is no pause.
      breaker: null,
    });
    // Reads failing for over a day: the stale rate no longer counts.
    await db
      .update(schema.regionBreakers)
      .set({ sesComplaintReadAt: new Date(Date.now() - 25 * 3_600_000) });
    expect(await region()).toMatchObject({ sesComplaintRate: null, sesComplaintRead: false });
    await db.delete(schema.regionBreakers);
  });
});

describe("console.regions complaint estimate", () => {
  it("divides complaints by the sends a provider can report, on the table and the access request alike", async () => {
    const [domain] = await db
      .insert(schema.domains)
      .values({
        teamId,
        name: "estimate.example",
        region: REGION,
        status: "verified",
        verifiedAt: new Date(),
      })
      .returning({ id: schema.domains.id });
    if (!domain) throw new Error("domain insert failed");
    // 2 complaints over 2000 sends, 1500 of them to Gmail: 0.4% of the 500 left.
    const week = { sent: 2000, sentNoFeedback: 1500, complained: 2 };
    const c = schema.usageCounters;
    await db
      .insert(c)
      .values({ teamId, day: utcDay(), ...week })
      .onConflictDoUpdate({ target: [c.teamId, c.day], set: week });
    const region = (await operator().console.regions.list()).served.find(
      (r) => r.region === REGION,
    );
    expect(region?.week).toEqual({ sent: 2000, hardBounceRate: 0, complaintRate: 0.004 });
    expect(await operator().console.regions.accessRequestFacts({ region: REGION })).toMatchObject({
      hardBounceRate7d: 0,
      complaintRate7d: 0.004,
    });
    await db
      .update(c)
      .set({ sent: 0, sentNoFeedback: 0, complained: 0 })
      .where(eq(c.teamId, teamId));
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

describe("suspension and the system team's contacts", () => {
  it("a review hold turned phishing takes its people off the system team's list, and reinstating leaves them off", async () => {
    const system = await createTeam(db, randomUUID());
    await db.update(schema.teams).set({ plan: "system" }).where(eq(schema.teams.id, system));
    const held = await createTeam(db, randomUUID());
    const userId = randomUUID();
    const email = `${userId}@example.com`;
    await db.insert(schema.user).values({ id: userId, name: "Held", email });
    await db.insert(schema.teamMembers).values({ teamId: held, userId, role: "owner" });
    await db.insert(schema.contacts).values({ teamId: system, email });
    const unsubscribed = async () => {
      const [row] = await db
        .select({ unsubscribed: schema.contacts.unsubscribed })
        .from(schema.contacts)
        .where(and(eq(schema.contacts.teamId, system), eq(schema.contacts.email, email)));
      return row?.unsubscribed;
    };

    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date(), suspensionReason: "review" })
      .where(eq(schema.teams.id, held));
    await operator().console.teams.suspend({ id: held, reason: "phishing" });
    expect(await unsubscribed()).toBe(true);
    await operator().console.teams.reinstate({ id: held });
    expect(await unsubscribed()).toBe(true);
  });
});

describe("suspend's cancel and refund in Stripe", () => {
  afterEach(() => setConsoleTeamsDeps(null));

  /** A team Stripe bills for Pro 100K: a live subscription and its customer. */
  async function payingTeam(): Promise<string> {
    const id = await createTeam(db, randomUUID());
    await db
      .update(schema.teams)
      .set({
        plan: "pro",
        planQuota: 100_000,
        planStatus: "active",
        stripeCustomerId: `cus_${id}`,
        stripeSubscriptionId: `sub_${id}`,
      })
      .where(eq(schema.teams.id, id));
    return id;
  }

  /** Stripe holding the team's subscription and two $20 payments from the last 120 days. */
  function fakeStripe(teamId: string, fail?: Error) {
    const calls = { stripe: 0, cancels: [] as unknown[], refunds: [] as unknown[] };
    const day = 86_400;
    const now = Math.floor(Date.now() / 1000);
    const charges = [now - 3600, now - 40 * day].map((created, i) => ({
      id: `ch_${i + 1}`,
      customer: `cus_${teamId}`,
      created,
      amount: 2000,
      amount_refunded: 0,
      currency: "usd",
      status: "succeeded",
      disputed: false,
      refunded: false,
    }));
    setConsoleTeamsDeps({
      stripe: () => {
        calls.stripe += 1;
        return {
          subscriptions: {
            retrieve: async (id: string) => ({ id, status: "active" }),
            cancel: async (id: string, params: unknown) => {
              calls.cancels.push([id, params]);
              return { id, status: "canceled" };
            },
          },
          charges: {
            async *list() {
              yield* charges;
            },
          },
          refunds: {
            create: async (params: unknown, options: unknown) => {
              if (fail) throw fail;
              calls.refunds.push([params, options]);
              return { id: `re_${calls.refunds.length}` };
            },
          },
        } as unknown as BillingStripe;
      },
    });
    return calls;
  }

  const instanceRow = async (action: string, id: string) =>
    (await auditRows(action)).find((row) => row.target === `team:${id}`);

  it("is offered on a live subscription only", async () => {
    const paying = await payingTeam();
    expect(await operator().console.teams.subscription({ id: paying })).toEqual({
      plan: "pro",
      planQuota: 100_000,
    });
    await db
      .update(schema.teams)
      .set({ planStatus: "canceled" })
      .where(eq(schema.teams.id, paying));
    expect(await operator().console.teams.subscription({ id: paying })).toBeNull();
    const free = await createTeam(db, randomUUID());
    expect(await operator().console.teams.subscription({ id: free })).toBeNull();
  });

  it("cancels and refunds as fraud once the team is suspended, in the operator's audit alone", async () => {
    const id = await payingTeam();
    const stripe = fakeStripe(id);
    const { refund } = await operator().console.teams.suspend({
      id,
      reason: "phishing",
      refund: true,
    });
    expect(refund).toEqual({
      canceled: `sub_${id}`,
      refunds: [
        { charge: "ch_1", amount: 2000, currency: "usd" },
        { charge: "ch_2", amount: 2000, currency: "usd" },
      ],
      failed: null,
    });
    expect(stripe.cancels).toEqual([[`sub_${id}`, { invoice_now: false, prorate: false }]]);
    expect(stripe.refunds).toEqual([
      [{ charge: "ch_1", reason: "fraudulent" }, { idempotencyKey: "fraud-refund:ch_1" }],
      [{ charge: "ch_2", reason: "fraudulent" }, { idempotencyKey: "fraud-refund:ch_2" }],
    ]);
    const row = await team(id);
    expect(row).toMatchObject({
      suspensionReason: "phishing",
      plan: "free",
      planQuota: null,
      planStatus: "canceled",
      stripeSubscriptionId: null,
    });
    expect(row.suspendedAt).toBeInstanceOf(Date);
    expect(await instanceRow("team.fraud_refunded", id)).toMatchObject({
      teamId: null,
      actorId: `user:${OPERATOR}`,
      data: {
        team: row.name,
        subscription: `sub_${id}`,
        refunded: 2,
        amount: "$40",
        charges: "ch_1, ch_2",
        failed: null,
      },
    });
    const owner = await callerFor(MEMBER, id, "owner").audit.list({ limit: 50 });
    expect(owner.items.map((r) => r.action)).toEqual(["team.suspended"]);

    // Reinstating gives nothing back: the team stays on Free and may buy again.
    await operator().console.teams.reinstate({ id });
    expect(await team(id)).toMatchObject({
      suspendedAt: null,
      plan: "free",
      planStatus: "canceled",
      stripeSubscriptionId: null,
    });
    expect(await upgradesHeld(db, id)).toBe(false);
    expect(stripe.cancels).toHaveLength(1);
    expect(stripe.refunds).toHaveLength(2);
  });

  it("a Stripe failure keeps the suspension, comes back for the console and is audited", async () => {
    const id = await payingTeam();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeStripe(id, new Error("Stripe is down"));
    const { refund } = await operator().console.teams.suspend({
      id,
      reason: "manual",
      notify: false,
      refund: true,
    });
    warn.mockRestore();
    expect(refund).toEqual({ canceled: `sub_${id}`, refunds: [], failed: "Error: Stripe is down" });
    expect(await team(id)).toMatchObject({ suspensionReason: "manual", plan: "free" });
    expect((await team(id)).suspendedAt).toBeInstanceOf(Date);
    expect(await instanceRow("team.fraud_refund_failed", id)).toMatchObject({
      teamId: null,
      data: { subscription: `sub_${id}`, refunded: 0, failed: "Error: Stripe is down" },
    });
    expect(await instanceRow("team.fraud_refunded", id)).toBeUndefined();
  });

  it("is refused on non-payment, and left alone unticked or without a Stripe customer", async () => {
    const id = await payingTeam();
    const stripe = fakeStripe(id);
    await expect(
      operator().console.teams.suspend({ id, reason: "non_payment", refund: true }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await team(id)).suspendedAt).toBeNull();

    expect(
      (await operator().console.teams.suspend({ id, reason: "phishing", notify: false })).refund,
    ).toBeNull();
    const free = await createTeam(db, randomUUID());
    expect(
      (await operator().console.teams.suspend({ id: free, reason: "phishing", refund: true }))
        .refund,
    ).toBeNull();
    expect(stripe.stripe).toBe(0);
    expect(await team(id)).toMatchObject({ plan: "pro", planStatus: "active" });
  });
});

describe("console.overview.kpiTeams", () => {
  const c = schema.usageCounters;
  const made: string[] = [];
  const day = (daysAgo: number) => utcDay(Date.now() - daysAgo * DAY_MS);
  /** A team with a display name of its own, removed after the suite with its counters. */
  async function seed(slug: string, name: string): Promise<string> {
    const id = await createTeam(db, slug);
    await db.update(schema.teams).set({ name }).where(eq(schema.teams.id, id));
    made.push(id);
    return id;
  }
  /** Teams one test adds on top of the shared ones, gone when it ends so no other test sees them. */
  const dropAfter = (ids: string[]) =>
    onTestFinished(async () => {
      await db.delete(schema.teams).where(inArray(schema.teams.id, ids));
    });
  const counters = (
    id: string,
    daysAgo: number,
    values: { sent?: number; bounced?: number; hardBounced?: number; complained?: number },
  ) => db.insert(c).values({ teamId: id, day: day(daysAgo), ...values });
  const kpiTeams = (kind: "hardBounced" | "complained", period: Parameters<typeof kpis>[0]) =>
    operator().console.overview.kpiTeams({ kind, period });
  const kpis = (period: "24h" | "7d" | { from: string; to: string }) =>
    operator().console.overview.kpis({ period });
  let a = "";
  let b = "";
  let e = "";

  // The clock stands still: the procedure resolves its window from its own
  // now, which would start an hour or a day later than the one this suite
  // computed if a boundary passed in between. Half past noon UTC keeps every
  // seeded day and hour inside its window.
  beforeAll(async () => {
    vi.useFakeTimers({ now: new Date().setUTCHours(12, 30, 0, 0), toFake: ["Date"] });
    a = await seed("kpi-example-a", "Example A");
    await counters(a, 2, { sent: 1000, complained: 2 });
    b = await seed("kpi-example-b", "Example B");
    await counters(b, 0, { complained: 2 });
    // More complaints than sends in the window: no rate either.
    e = await seed("kpi-example-e", "Example E");
    await counters(e, 1, { sent: 1, complained: 2 });
    await counters(await seed("kpi-example-c", "Example C"), 1, { sent: 500 });
    await counters(await seed("kpi-example-d", "Example D"), 10, { sent: 100, complained: 3 });
  });
  afterAll(async () => {
    vi.useRealTimers();
    await db.delete(schema.teams).where(inArray(schema.teams.id, made));
  });

  it("adds the teams up to the card, most first, with no rate over no sends", async () => {
    const out = await kpiTeams("complained", "7d");
    expect(out.grain).toBe("day");
    expect(out.rows.map((r) => [r.id, r.count, r.sent, r.rate, r.lastAt])).toEqual([
      [a, 2, 1000, 0.002, day(2)],
      [b, 2, 0, null, day(0)],
      [e, 2, 1, null, day(1)],
    ]);
    expect(out.teams).toBe(3);
    expect(out.total).toBe(6);
    expect(out.total).toBe((await kpis("7d")).totals.complained);
  });

  it("gives no rate to a team with more than it sent, and sorts it after the rated ones", async () => {
    const out = await kpiTeams("complained", "7d");
    expect(out.rows.map((r) => [r.name, r.rate])).toEqual([
      ["Example A", 0.002],
      ["Example B", null],
      ["Example E", null],
    ]);
  });

  it("counts hard bounces, not every bounce", async () => {
    const f = await seed("kpi-example-f", "Example F");
    dropAfter([f]);
    await counters(f, 0, { sent: 200, bounced: 7, hardBounced: 2 });
    const out = await kpiTeams("hardBounced", "7d");
    expect(out.rows.map((r) => [r.id, r.count, r.rate])).toEqual([[f, 2, 0.01]]);
    expect(out.total).toBe((await kpis("7d")).totals.hardBounced);
  });

  it("reads hourly rows over a day, from the window's first hour", async () => {
    const from = new Date(Date.now() - DAY_MS);
    from.setUTCMinutes(0, 0, 0);
    const g = await seed("kpi-example-g", "Example G");
    dropAfter([g]);
    await db.insert(schema.usageCountersHourly).values([
      { teamId: g, hour: from, sent: 40, complained: 1 },
      // An hour before the window: out of it, as it is out of the chart.
      { teamId: g, hour: new Date(from.getTime() - 3_600_000), complained: 5 },
    ]);
    const out = await kpiTeams("complained", "24h");
    expect(out.grain).toBe("hour");
    expect(out.rows).toEqual([
      expect.objectContaining({
        id: g,
        count: 1,
        sent: 40,
        rate: 0.025,
        lastAt: from.toISOString(),
      }),
    ]);
    expect(out.buckets).toEqual([
      { t: from.toISOString(), top: [{ name: "Example G", count: 1 }], moreTeams: 0, moreCount: 0 },
    ]);
    const chart = await kpis("24h");
    expect(out.total).toBe(chart.totals.complained);
    expect(chart.points.map((p) => p.t)).toContain(from.toISOString());
  });

  it("names each point's five teams with the most, ties by name, and what the rest add up to", async () => {
    const points: string[] = [];
    for (const [slug, n] of [
      ["point-1", 4],
      ["point-3", 3],
      ["point-2", 3],
      ["point-4", 2],
      ["point-5", 1],
      ["point-6", 1],
      ["point-7", 1],
    ] as const) {
      const id = await seed(`kpi-${slug}`, slug);
      points.push(id);
      await counters(id, 3, { sent: 100, complained: n });
    }
    dropAfter(points);
    const out = await kpiTeams("complained", "7d");
    expect(out.buckets.find((x) => x.t === day(3))).toEqual({
      t: day(3),
      top: [
        { name: "point-1", count: 4 },
        { name: "point-2", count: 3 },
        { name: "point-3", count: 3 },
        { name: "point-4", count: 2 },
        { name: "point-5", count: 1 },
      ],
      moreTeams: 2,
      moreCount: 2,
    });
    // Keyed as the chart's points, and only the points with a complaint.
    const days = (await kpis("7d")).points.map((p) => p.t);
    expect(out.buckets.map((x) => x.t)).toEqual([day(3), day(2), day(1), day(0)]);
    expect(days).toEqual(expect.arrayContaining(out.buckets.map((x) => x.t)));
    expect(out.buckets.find((x) => x.t === day(0))?.top).toEqual([{ name: "Example B", count: 2 }]);
  });

  it("carries what the status cell reads: holds, suspensions, pauses and the standing", async () => {
    const held = await seed("kpi-held", "Held");
    const paused = await seed("kpi-paused", "Paused");
    const warned = await seed("kpi-warned", "Warned");
    dropAfter([held, paused, warned]);
    const at = new Date("2026-01-02T03:04:05Z");
    await db
      .update(schema.teams)
      .set({ suspendedAt: at, suspensionReason: "review" })
      .where(eq(schema.teams.id, held));
    await db
      .update(schema.teams)
      .set({ broadcastsPausedByOperatorAt: at })
      .where(eq(schema.teams.id, paused));
    await db.insert(schema.teamStandings).values({
      teamId: warned,
      guardrail: "warning",
      guardrailMetric: "complaint",
      complaintRate7d: 0.002,
      hardBounceRate7d: 0.01,
    });
    for (const id of [held, paused, warned]) await counters(id, 0, { sent: 10, complained: 1 });
    const rows = (await kpiTeams("complained", "7d")).rows;
    expect(rows.find((r) => r.id === held)).toMatchObject({
      suspendedAt: at,
      suspensionReason: "review",
      guardrail: null,
    });
    expect(rows.find((r) => r.id === paused)).toMatchObject({
      suspendedAt: null,
      broadcastsPausedByOperatorAt: at,
    });
    expect(rows.find((r) => r.id === warned)).toMatchObject({
      guardrail: "warning",
      guardrailMetric: "complaint",
      complaintRate7d: 0.002,
      hardBounceRate7d: 0.01,
      plan: "free",
      planQuota: null,
    });
  });

  it("is the operator's alone", async () => {
    await expect(
      member().console.overview.kpiTeams({ kind: "complained", period: "7d" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists the first 100 teams and counts every one of them", async () => {
    const bulk = await db
      .insert(schema.teams)
      .values(Array.from({ length: 101 }, (_, i) => ({ name: `bulk ${i}`, slug: `kpi-bulk-${i}` })))
      .returning({ id: schema.teams.id });
    dropAfter(bulk.map((row) => row.id));
    await db
      .insert(c)
      .values(bulk.map((row) => ({ teamId: row.id, day: day(5), sent: 50, hardBounced: 1 })));
    const period = { from: day(6), to: day(4) };
    const out = await kpiTeams("hardBounced", period);
    expect(out.rows).toHaveLength(100);
    expect(out.teams).toBe(101);
    expect(out.total).toBe(101);
    expect(out.total).toBe((await kpis(period)).totals.hardBounced);
  });
});

describe("console.safety.list and a 7-day window with nothing to rate", () => {
  it("says whether the standing's window held a send that could draw a complaint", async () => {
    const c = schema.usageCounters;
    const day = (daysAgo: number) => utcDay(Date.now() - daysAgo * DAY_MS);
    const seed = async (
      slug: string,
      sent7d: number,
      counters: { daysAgo: number; sent: number; sentNoFeedback: number } | null,
    ) => {
      const id = await createTeam(db, slug);
      await db.insert(schema.teamStandings).values({ teamId: id, guardrail: "ok", sent7d });
      await db.insert(schema.teamFlags).values({ teamId: id, reason: "manual" });
      if (counters) {
        const { daysAgo, ...values } = counters;
        await db.insert(c).values({ teamId: id, day: day(daysAgo), ...values });
      }
      return id;
    };
    const gmailOnly = await seed("rates-gmail-only", 300, {
      daysAgo: 0,
      sent: 300,
      sentNoFeedback: 300,
    });
    const reporting = await seed("rates-reporting", 100, {
      daysAgo: 1,
      sent: 100,
      sentNoFeedback: 40,
    });
    const quiet = await seed("rates-quiet", 0, null);
    const lastWeek = await seed("rates-last-week", 0, { daysAgo: 8, sent: 50, sentNoFeedback: 0 });
    const rows = (await operator().console.safety.list({ limit: 100 })).items;
    const row = (id: string) => rows.find((r) => r.teamId === id);
    expect(row(gmailOnly)).toMatchObject({ sent7d: 300, complaintSends7d: false });
    expect(row(reporting)).toMatchObject({ sent7d: 100, complaintSends7d: true });
    expect(row(quiet)).toMatchObject({ sent7d: 0, complaintSends7d: false });
    expect(row(lastWeek)).toMatchObject({ sent7d: 0, complaintSends7d: false });
    // What the status cell reads rides along.
    expect(row(reporting)).toMatchObject({ suspensionReason: null, guardrailMetric: null });
    await db
      .delete(schema.teams)
      .where(inArray(schema.teams.id, [gmailOnly, reporting, quiet, lastWeek]));
  });
});
