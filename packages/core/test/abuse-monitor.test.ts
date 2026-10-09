import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JudgeVerdict } from "../src/abuse-judge/types.js";
import {
  applyJudgedSample,
  clearMonitorOverride,
  deriveSamplingKey,
  drawBroadcastCopy,
  foldRisk,
  MONITOR_PRIOR_NEW,
  MONITOR_PRIOR_SETTLED,
  MONITOR_PRIOR_WEIGHT,
  MONITOR_RISK_HALF_LIFE_MS,
  type MonitorTeamState,
  markLostSamples,
  monitorDayCounts,
  monitorHealth,
  monitorRate,
  monitorTier,
  noteAcceptedSend,
  planBroadcastSamples,
  pruneMonitorSamples,
  resumeMonitorPause,
  riskAt,
  sampleAcceptedEmail,
  samplingFraction,
  setMonitorOverride,
  teamMonitorOverview,
} from "../src/abuse-monitor.js";
import { MONITOR_SETTING_DEFAULTS, type MonitorSettings } from "../src/monitor-settings.js";
import { DAY_MS } from "../src/utc-day.js";

const KEY = Buffer.alloc(32, 7);
const NOW = new Date("2026-09-15T12:00:00Z");
const S: MonitorSettings = MONITOR_SETTING_DEFAULTS;
const HOUR = 3600_000;

const state = (over: Partial<MonitorTeamState> = {}): MonitorTeamState => ({
  sentTotal: 20_000,
  firstSendAt: new Date(NOW.getTime() - 60 * DAY_MS),
  plan: "free",
  flaggedRecently: false,
  overrideRate: null,
  overrideUntil: null,
  risk: null,
  ...over,
});

describe("the draw", () => {
  it("is keyed, deterministic and uniform enough to pin", () => {
    expect(samplingFraction(KEY, "t1:e1")).toBeCloseTo(0.35108, 5);
    expect(samplingFraction(KEY, "t1:e4")).toBeCloseTo(0.23885, 5);
    expect(samplingFraction(KEY, "t1:e1")).toBe(samplingFraction(KEY, "t1:e1"));
    expect(samplingFraction(Buffer.alloc(32, 8), "t1:e1")).not.toBe(samplingFraction(KEY, "t1:e1"));
    const picked = ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"].filter(
      (e) => samplingFraction(KEY, `t1:${e}`) < 0.25,
    );
    expect(picked).toEqual(["e4"]);
    expect(drawBroadcastCopy(KEY, "b1", "e3", 2, 4)).toBe(true);
    expect(drawBroadcastCopy(KEY, "b1", "e2", 2, 4)).toBe(false);
    expect(drawBroadcastCopy(KEY, "b1", "e2", 3, 0)).toBe(true);
  });

  it("derives its key from the master key and refuses a short one", () => {
    const a = deriveSamplingKey(Buffer.alloc(32, 1));
    expect(a).toHaveLength(32);
    expect(a.equals(deriveSamplingKey(Buffer.alloc(32, 1)))).toBe(true);
    expect(a.equals(deriveSamplingKey(Buffer.alloc(32, 2)))).toBe(false);
    expect(() => deriveSamplingKey(Buffer.alloc(8))).toThrow("too short");
  });
});

describe("tiers and rates", () => {
  it("walks new, probation, established, trusted and exempt", () => {
    expect(monitorTier(state({ sentTotal: 10, firstSendAt: null }), S, NOW)).toBe("new");
    expect(
      monitorTier(
        state({ sentTotal: 5_000, firstSendAt: new Date(NOW.getTime() - 3 * DAY_MS) }),
        S,
        NOW,
      ),
    ).toBe("new");
    expect(
      monitorTier(
        state({ sentTotal: 5_000, firstSendAt: new Date(NOW.getTime() - 8 * DAY_MS) }),
        S,
        NOW,
      ),
    ).toBe("probation");
    expect(
      monitorTier(
        state({ sentTotal: 20_000, firstSendAt: new Date(NOW.getTime() - 3 * DAY_MS) }),
        S,
        NOW,
      ),
    ).toBe("probation");
    expect(
      monitorTier(
        state({ sentTotal: 20_000, firstSendAt: new Date(NOW.getTime() - 4 * DAY_MS) }),
        S,
        NOW,
      ),
    ).toBe("probation");
    expect(monitorTier(state(), S, NOW)).toBe("established");
    const old = state({ sentTotal: 60_000, firstSendAt: new Date(NOW.getTime() - 200 * DAY_MS) });
    expect(monitorTier(old, S, NOW)).toBe("trusted");
    expect(monitorTier({ ...old, flaggedRecently: true }, S, NOW)).toBe("established");
    expect(monitorTier({ ...old, sentTotal: 49_999 }, S, NOW)).toBe("established");
    expect(monitorTier(state({ plan: "system" }), S, NOW)).toBe("exempt");
    // The first-sends window keeps a slow team new regardless of its age.
    expect(
      monitorTier(
        state({ sentTotal: 900, firstSendAt: new Date(NOW.getTime() - 200 * DAY_MS) }),
        S,
        NOW,
      ),
    ).toBe("new");
  });

  it("forces the first sends and hours through, then follows the tier", () => {
    const first = monitorRate(
      state({ sentTotal: 999, firstSendAt: new Date(NOW.getTime() - 10 * DAY_MS) }),
      S,
      NOW,
      { anomalies: 0 },
    );
    expect(first).toMatchObject({ rate: 1, kind: "first_sends", tier: "new" });
    const hours = monitorRate(
      state({ sentTotal: 5_000, firstSendAt: new Date(NOW.getTime() - 71 * HOUR) }),
      S,
      NOW,
      { anomalies: 0 },
    );
    expect(hours).toMatchObject({ rate: 1, kind: "first_sends" });
    const ramp = monitorRate(
      state({ sentTotal: 5_000, firstSendAt: new Date(NOW.getTime() - 73 * HOUR) }),
      S,
      NOW,
      { anomalies: 0 },
    );
    expect(ramp).toMatchObject({ rate: 0.25, kind: "ramp", tier: "new" });
    expect(
      monitorRate(state({ firstSendAt: new Date(NOW.getTime() - 10 * DAY_MS) }), S, NOW, {
        anomalies: 0,
      }),
    ).toMatchObject({ rate: 0.05, kind: "tier", tier: "probation" });
    expect(monitorRate(state(), S, NOW, { anomalies: 0 })).toMatchObject({
      rate: 0.02,
      kind: "tier",
      tier: "established",
      elevated: [],
    });
    expect(
      monitorRate(
        state({ sentTotal: 60_000, firstSendAt: new Date(NOW.getTime() - 200 * DAY_MS) }),
        S,
        NOW,
        { anomalies: 0 },
      ),
    ).toMatchObject({ rate: 0.005, tier: "trusted" });
    expect(monitorRate(state({ plan: "system" }), S, NOW, { anomalies: 2 })).toMatchObject({
      rate: 0,
      tier: "exempt",
    });
  });

  it("multiplies for one anomaly, forces two, quadruples a flagged team, never past one", () => {
    expect(monitorRate(state(), S, NOW, { anomalies: 1 })).toMatchObject({
      rate: 0.4,
      kind: "anomaly",
      elevated: ["anomaly"],
    });
    expect(monitorRate(state(), S, NOW, { anomalies: 2 })).toMatchObject({
      rate: 1,
      kind: "anomaly",
    });
    expect(monitorRate(state({ risk: 0.6 }), S, NOW, { anomalies: 0 })).toMatchObject({
      rate: 0.08,
      kind: "tier",
      elevated: ["flagged"],
    });
    expect(monitorRate(state({ risk: 0.6 }), S, NOW, { anomalies: 1 })).toMatchObject({
      rate: 1,
      elevated: ["anomaly", "flagged"],
    });
    expect(monitorRate(state({ risk: 0.49 }), S, NOW, { anomalies: 0 }).rate).toBe(0.02);
  });

  it("lets an override replace the tier rate until it lapses, not the first window", () => {
    const active = state({ overrideRate: 1, overrideUntil: new Date(NOW.getTime() + DAY_MS) });
    expect(monitorRate(active, S, NOW, { anomalies: 0 })).toMatchObject({
      rate: 1,
      kind: "override",
      elevated: ["override"],
    });
    const lapsed = state({ overrideRate: 1, overrideUntil: new Date(NOW.getTime() - 1) });
    expect(monitorRate(lapsed, S, NOW, { anomalies: 0 })).toMatchObject({
      rate: 0.02,
      kind: "tier",
    });
    const first = state({
      sentTotal: 5,
      overrideRate: 0.1,
      overrideUntil: new Date(NOW.getTime() + DAY_MS),
    });
    expect(monitorRate(first, S, NOW, { anomalies: 0 })).toMatchObject({
      rate: 1,
      kind: "first_sends",
    });
  });
});

describe("foldRisk", () => {
  const fresh = {
    riskNum: 0,
    riskDen: 0,
    riskUpdatedAt: null,
    firstSendAt: new Date(NOW.getTime() - 2 * DAY_MS),
  };

  it("starts from the prior and halves old evidence every half-life", () => {
    const one = foldRisk(fresh, 100, NOW);
    expect(one.risk).toBeCloseTo(
      (1 + MONITOR_PRIOR_NEW * MONITOR_PRIOR_WEIGHT) / (1 + MONITOR_PRIOR_WEIGHT),
      10,
    );
    const later = new Date(NOW.getTime() + MONITOR_RISK_HALF_LIFE_MS);
    const two = foldRisk({ ...one, riskUpdatedAt: NOW, firstSendAt: fresh.firstSendAt }, 0, later);
    expect(two.riskNum).toBeCloseTo(0.5, 10);
    expect(two.riskDen).toBeCloseTo(1.5, 10);
    expect(two.risk).toBeCloseTo((0.5 + MONITOR_PRIOR_NEW * 3) / (1.5 + 3), 10);
  });

  it("reads the risk as of now, decayed toward the prior, and null before a verdict", () => {
    expect(riskAt(fresh, NOW)).toBeNull();
    const one = {
      ...foldRisk(fresh, 100, NOW),
      riskUpdatedAt: NOW,
      firstSendAt: fresh.firstSendAt,
    };
    expect(riskAt(one, NOW)).toBeCloseTo(one.risk, 10);
    const later = new Date(NOW.getTime() + 8 * MONITOR_RISK_HALF_LIFE_MS);
    // Eight weeks on the team is past day 30: the risk sits just above the settled prior.
    expect(riskAt(one, later)).toBeLessThan(0.2);
    expect(riskAt(one, later)).toBeGreaterThan(MONITOR_PRIOR_SETTLED);
  });

  it("uses the settled prior past day 30", () => {
    const settled = foldRisk(
      { ...fresh, firstSendAt: new Date(NOW.getTime() - 40 * DAY_MS) },
      50,
      NOW,
    );
    expect(settled.risk).toBeCloseTo((0.5 + MONITOR_PRIOR_SETTLED * 3) / 4, 10);
  });
});

describe("sampling against the database", () => {
  let db: Db;
  let close: () => Promise<void>;
  let teamId: string;
  const queued: string[] = [];
  let settings: MonitorSettings = S;
  const deps = {
    samplingKey: KEY,
    settings: async () => settings,
    enqueueJudge: async (id: string) => void queued.push(id),
  };

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    teamId = await createTeam(db, "t1");
  });
  afterAll(() => close());

  async function email(id: string): Promise<string> {
    const [row] = await db
      .insert(schema.emails)
      .values({ id, teamId, from: "a@acme.dev", to: ["r@example.com"], subject: "s" })
      .returning({ id: schema.emails.id });
    return row?.id ?? "";
  }
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  it("counts every accepted send, judges the first ones fully, and skips broadcast rows", async () => {
    const first = await sampleAcceptedEmail(db, deps, {
      teamId,
      emailId: await email(uuid(1)),
      broadcast: false,
      anomalies: 0,
      now: NOW,
    });
    expect(first.decision).toMatchObject({ kind: "first_sends", rate: 1, tier: "new" });
    expect(first.sampleId).not.toBeNull();
    expect(queued).toEqual([first.sampleId]);
    const bulk = await sampleAcceptedEmail(db, deps, {
      teamId,
      emailId: await email(uuid(2)),
      broadcast: true,
      anomalies: 0,
      now: NOW,
    });
    expect(bulk).toEqual({ sampleId: null, decision: null });
    const [row] = await db
      .select()
      .from(schema.teamMonitor)
      .where(eq(schema.teamMonitor.teamId, teamId));
    expect(row).toMatchObject({ sentTotal: 2, firstSendAt: NOW, lastSampleAt: NOW });
    const [sample] = await db
      .select()
      .from(schema.monitorSamples)
      .where(eq(schema.monitorSamples.id, first.sampleId ?? ""));
    expect(sample).toMatchObject({
      teamId,
      emailId: uuid(1),
      kind: "first_sends",
      status: "pending",
    });
  });

  it("draws with the pinned key once past the first window", async () => {
    await db
      .update(schema.teamMonitor)
      .set({ sentTotal: 5_000, firstSendAt: new Date(NOW.getTime() - 10 * DAY_MS) })
      .where(eq(schema.teamMonitor.teamId, teamId));
    const before = queued.length;
    const results: string[] = [];
    for (const e of ["e1", "e2", "e3", "e4"]) {
      const id =
        `${uuid(100)}`.slice(0, -2) +
        (e === "e1" ? "e1" : e === "e2" ? "e2" : e === "e3" ? "e3" : "e4");
      await email(id);
      const r = await sampleAcceptedEmail(
        db,
        { ...deps, samplingKey: KEY, settings: async () => ({ ...S, probationRate: 0.25 }) },
        { teamId, emailId: id, broadcast: false, anomalies: 0, now: NOW },
      );
      // The draw hashes "teamId:emailId"; the picks depend on the real ids, so assert consistency with the fraction.
      const fraction = samplingFraction(KEY, `${teamId}:${id}`);
      expect(r.sampleId !== null).toBe(fraction < 0.25);
      expect(r.decision).toMatchObject({ tier: "probation", kind: "tier", rate: 0.25 });
      if (r.sampleId) results.push(r.sampleId);
    }
    expect(queued.length - before).toBe(results.length);
  });

  it("stops at the team cap, and at the instance cap except for first sends and anomalies", async () => {
    const [count] = await db
      .select({ n: schema.monitorSamples.id })
      .from(schema.monitorSamples)
      .where(eq(schema.monitorSamples.teamId, teamId));
    expect(count).toBeDefined();
    settings = { ...S, teamDailyCap: 1 };
    const capped = await sampleAcceptedEmail(db, deps, {
      teamId,
      emailId: await email(uuid(10)),
      broadcast: false,
      anomalies: 2,
      now: NOW,
    });
    expect(capped.decision?.rate).toBe(1);
    expect(capped.sampleId).toBeNull();
    settings = { ...S, teamDailyCap: 600, instanceDailyCap: 1 };
    const tier = await sampleAcceptedEmail(
      db,
      { ...deps, settings: async () => ({ ...settings, probationRate: 1 }) },
      { teamId, emailId: await email(uuid(11)), broadcast: false, anomalies: 0, now: NOW },
    );
    expect(tier.decision?.kind).toBe("tier");
    expect(tier.sampleId).toBeNull();
    const anomaly = await sampleAcceptedEmail(db, deps, {
      teamId,
      emailId: await email(uuid(12)),
      broadcast: false,
      anomalies: 2,
      now: NOW,
    });
    expect(anomaly.decision?.kind).toBe("anomaly");
    expect(anomaly.sampleId).not.toBeNull();
    settings = S;
  });

  it("backfills an old team's history from the usage counters on its first monitor row", async () => {
    const old = await createTeam(db, "old");
    await db.insert(schema.usageCounters).values([
      // An accepted-only day is not a send day.
      { teamId: old, day: "2025-12-01", accepted: 5, sent: 0 },
      { teamId: old, day: "2026-01-10", sent: 30_000 },
      { teamId: old, day: "2026-09-15", sent: 25_000 },
    ]);
    const row = await noteAcceptedSend(db, old, NOW);
    expect(row).toMatchObject({ sentTotal: 55_000, firstSendAt: new Date("2026-01-10T00:00:00Z") });
    expect((await noteAcceptedSend(db, old, NOW)).sentTotal).toBe(55_001);
    // A brand-new team whose first batch is in flight keeps its real first instant.
    const fresh = await createTeam(db, "fresh-batch");
    await db.insert(schema.usageCounters).values({ teamId: fresh, day: "2026-09-15", sent: 3 });
    expect(await noteAcceptedSend(db, fresh, NOW)).toMatchObject({
      sentTotal: 3,
      firstSendAt: NOW,
    });
  });

  it("plans a broadcast: the skeleton sample plus the tier's copies, none for a system team", async () => {
    const [broadcast] = await db
      .insert(schema.broadcasts)
      .values({ teamId, from: "a@acme.dev", subject: "news", html: "<p>hi</p>", status: "sending" })
      .returning({ id: schema.broadcasts.id });
    const plan = await planBroadcastSamples(db, deps, {
      teamId,
      broadcastId: broadcast?.id ?? "",
      now: NOW,
    });
    expect(plan.copies).toBe(10);
    const [sample] = await db
      .select()
      .from(schema.monitorSamples)
      .where(eq(schema.monitorSamples.id, plan.skeletonSampleId ?? ""));
    expect(sample).toMatchObject({
      kind: "broadcast_skeleton",
      broadcastId: broadcast?.id,
      emailId: null,
    });
    await db
      .update(schema.teamMonitor)
      .set({ sentTotal: 20_000, firstSendAt: new Date(NOW.getTime() - 60 * DAY_MS) })
      .where(eq(schema.teamMonitor.teamId, teamId));
    expect(
      (await planBroadcastSamples(db, deps, { teamId, broadcastId: broadcast?.id ?? "", now: NOW }))
        .copies,
    ).toBe(3);
  });
});

describe("verdicts and thresholds", () => {
  let db: Db;
  let close: () => Promise<void>;
  let teamId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    teamId = await createTeam(db, "judged");
    await db
      .insert(schema.teamMonitor)
      .values({ teamId, sentTotal: 10, firstSendAt: new Date(NOW.getTime() - HOUR) });
  });
  afterAll(() => close());

  const monitor = async () =>
    (await db.select().from(schema.teamMonitor).where(eq(schema.teamMonitor.teamId, teamId)))[0];
  const team = async () =>
    (await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)))[0];
  const audits = () =>
    db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.teamId, teamId))
      .orderBy(desc(schema.auditLog.createdAt));
  async function judged(score: number, at: Date) {
    await db.insert(schema.monitorSamples).values({
      teamId,
      kind: "first_sends",
      status: "judged",
      score,
      judgedAt: at,
      createdAt: at,
    });
  }

  it("folds the score into the risk and alerts once per day past the alert line", async () => {
    await judged(60, NOW);
    const low = await applyJudgedSample(db, S, { teamId, score: 60, now: NOW });
    expect(low).toMatchObject({ tier: "new", alert: false, paused: false });
    expect(low.risk).toBeCloseTo((0.6 + 0.35 * 3) / 4, 10);
    expect(await monitor()).toMatchObject({ risk: low.risk, riskUpdatedAt: NOW, alertedAt: null });
    for (let i = 0; i < 6; i += 1) await judged(95, NOW);
    let out = { risk: 0, alert: false, paused: false };
    for (let i = 0; i < 6; i += 1)
      out = {
        ...out,
        ...(await applyJudgedSample(
          db,
          { ...S, autoPause: false },
          { teamId, score: 95, now: NOW },
        )),
      };
    expect(out.risk).toBeGreaterThan(S.alertRisk);
    const alerts = (
      await db.select().from(schema.teamMonitor).where(eq(schema.teamMonitor.teamId, teamId))
    )[0]?.alertedAt;
    expect(alerts).toEqual(NOW);
    const again = await applyJudgedSample(
      db,
      { ...S, autoPause: false },
      { teamId, score: 85, now: new Date(NOW.getTime() + HOUR) },
    );
    expect(again.alert).toBe(false);
    const tomorrow = await applyJudgedSample(
      db,
      { ...S, autoPause: false },
      { teamId, score: 85, now: new Date(NOW.getTime() + DAY_MS) },
    );
    expect(tomorrow.alert).toBe(true);
    expect((await monitor())?.broadcastsPausedAt).toBeNull();
  });

  it("pauses broadcasts only for a new team under the policy with a strong verdict inside a day", async () => {
    // A dozen certain verdicts push the risk past the pause line; the policy is off while they land.
    const t0 = new Date(NOW.getTime() + 2 * DAY_MS);
    for (let i = 0; i < 12; i += 1) {
      await judged(100, t0);
      await applyJudgedSample(db, { ...S, autoPause: false }, { teamId, score: 100, now: t0 });
    }
    // A day later those verdicts are outside the window and the new one is weak: no pause.
    const t1 = new Date(t0.getTime() + DAY_MS + HOUR);
    const weak = await applyJudgedSample(db, S, { teamId, score: 85, now: t1 });
    expect(weak.risk).toBeGreaterThan(S.pauseRisk);
    expect(weak).toMatchObject({ tier: "new", paused: false });
    await judged(95, t1);
    const strong = await applyJudgedSample(db, S, { teamId, score: 95, now: t1 });
    expect(strong.paused).toBe(true);
    expect(await monitor()).toMatchObject({ broadcastsPausedAt: t1 });
    expect((await team())?.broadcastsPausedByOperatorAt).toEqual(t1);
    expect((await audits())[0]).toMatchObject({
      action: "monitor.broadcasts_paused",
      actorId: "system",
      target: `team:${teamId}`,
    });
    // Already paused: no second pause, no second audit.
    expect((await applyJudgedSample(db, S, { teamId, score: 99, now: t1 })).paused).toBe(false);
    expect((await audits()).filter((a) => a.action === "monitor.broadcasts_paused")).toHaveLength(
      1,
    );
  });

  it("resumes from the review page and clears the operator hold with it", async () => {
    const t = new Date(NOW.getTime() + 3 * DAY_MS + 2 * HOUR);
    expect(await resumeMonitorPause(db, { teamId, actor: { userId: "op" } })).toBe(true);
    expect((await monitor())?.broadcastsPausedAt).toBeNull();
    expect((await monitor())?.broadcastsResumedAt).not.toBeNull();
    expect((await team())?.broadcastsPausedByOperatorAt).toBeNull();
    expect((await audits())[0]).toMatchObject({
      action: "monitor.broadcasts_resumed",
      actorId: "user:op",
    });
    expect(await resumeMonitorPause(db, { teamId, actor: { userId: "op" } })).toBe(false);
    // The reviewed verdicts stay behind the resume: a weak verdict cannot pause the team again.
    await db
      .update(schema.teamMonitor)
      .set({ broadcastsResumedAt: t })
      .where(eq(schema.teamMonitor.teamId, teamId));
    const weak = await applyJudgedSample(db, S, {
      teamId,
      score: 60,
      now: new Date(t.getTime() + 1),
    });
    expect(weak.risk).toBeGreaterThan(S.pauseRisk);
    expect(weak.paused).toBe(false);
    // A team the operator holds by hand is theirs: the policy stamps nothing and audits nothing.
    await db
      .update(schema.teams)
      .set({ broadcastsPausedByOperatorAt: t })
      .where(eq(schema.teams.id, teamId));
    await judged(99, new Date(t.getTime() + 2));
    const held = await applyJudgedSample(db, S, {
      teamId,
      score: 99,
      now: new Date(t.getTime() + 2),
    });
    expect(held.paused).toBe(false);
    expect((await monitor())?.broadcastsPausedAt).toBeNull();
    expect((await audits()).filter((a) => a.action === "monitor.broadcasts_paused")).toHaveLength(
      1,
    );
    await db
      .update(schema.teams)
      .set({ broadcastsPausedByOperatorAt: null })
      .where(eq(schema.teams.id, teamId));
  });

  it("never pauses an established team or with the policy off", async () => {
    const t = new Date(NOW.getTime() + 4 * DAY_MS);
    await db
      .update(schema.teamMonitor)
      .set({ sentTotal: 20_000, firstSendAt: new Date(t.getTime() - 60 * DAY_MS) })
      .where(eq(schema.teamMonitor.teamId, teamId));
    await judged(99, t);
    const settled = await applyJudgedSample(db, S, { teamId, score: 99, now: t });
    expect(settled.tier).toBe("established");
    expect(settled.paused).toBe(false);
    await db
      .update(schema.teamMonitor)
      .set({ sentTotal: 10, firstSendAt: new Date(t.getTime() - HOUR) })
      .where(eq(schema.teamMonitor.teamId, teamId));
    expect(
      (await applyJudgedSample(db, { ...S, autoPause: false }, { teamId, score: 99, now: t }))
        .paused,
    ).toBe(false);
    expect((await monitor())?.broadcastsPausedAt).toBeNull();
  });

  it("sets and clears an override with audits", async () => {
    const until = new Date(NOW.getTime() + 7 * DAY_MS);
    await setMonitorOverride(db, { teamId, rate: 1, until, actor: { userId: "op" } });
    expect(await monitor()).toMatchObject({ overrideRate: 1, overrideUntil: until });
    expect((await audits())[0]).toMatchObject({
      action: "monitor.override_set",
      data: { rate: 1, until: until.toISOString() },
    });
    const overview = await teamMonitorOverview(db, teamId, S, NOW);
    expect(overview.override).toEqual({ rate: 1, until });
    expect(overview.decision.kind).toBe("first_sends");
    await clearMonitorOverride(db, { teamId, actor: { userId: "op" } });
    expect(await monitor()).toMatchObject({ overrideRate: null, overrideUntil: null });
    expect((await audits())[0]?.action).toBe("monitor.override_cleared");
  });

  it("summarises the team and the day, marks lost samples, and prunes old ones", async () => {
    const overview = await teamMonitorOverview(db, teamId, S, new Date(NOW.getTime() + 3 * DAY_MS));
    expect(overview.samples7d).toBeGreaterThan(5);
    expect(overview.flagged7d).toBeGreaterThan(5);
    expect(overview.unjudged7d).toBe(0);
    await db.insert(schema.monitorSamples).values([
      { teamId, kind: "tier", status: "unjudged", errorClass: "timeout", createdAt: NOW },
      { teamId, kind: "tier", status: "pending", createdAt: new Date(NOW.getTime() - 4 * HOUR) },
      {
        teamId,
        kind: "tier",
        status: "judged",
        score: 10,
        createdAt: new Date(NOW.getTime() - 100 * DAY_MS),
      },
    ]);
    expect(await monitorHealth(db, NOW)).toMatchObject({ unjudged: 1 });
    expect(await markLostSamples(db, NOW)).toBe(1);
    const day = await monitorDayCounts(db, S, NOW);
    expect(day.unjudged).toBe(2);
    expect(day.flagged).toBeGreaterThan(0);
    expect(await pruneMonitorSamples(db, NOW)).toBe(1);
  });
});

describe("the review hold", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  const PHISHING = {
    verdict: "abuse" as const,
    categories: ["brand_impersonation"],
    reasons: ["impersonation", "off_domain_lure"],
  };
  async function newTeam(
    slug: string,
    over: { plan?: "system"; sentTotal?: number; firstSendAt?: Date } = {},
  ) {
    const teamId = await createTeam(db, slug);
    const firstSendAt =
      over.firstSendAt ?? new Date(NOW.getTime() - (over.sentTotal ? 60 * DAY_MS : 3 * 60_000));
    await db
      .update(schema.teams)
      .set({ createdAt: new Date(firstSendAt.getTime() - HOUR), plan: over.plan ?? "free" })
      .where(eq(schema.teams.id, teamId));
    await db
      .insert(schema.teamMonitor)
      .values({ teamId, sentTotal: over.sentTotal ?? 1, firstSendAt });
    return teamId;
  }
  const team = async (teamId: string) =>
    (await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)))[0];
  const flags = (teamId: string) =>
    db.select().from(schema.teamFlags).where(eq(schema.teamFlags.teamId, teamId));
  const audits = (teamId: string) =>
    db.select().from(schema.auditLog).where(eq(schema.auditLog.teamId, teamId));

  it("suspends a new team for review on one confident phishing verdict, once, and leaves a released team to the operator", async () => {
    const teamId = await newTeam("held");
    const out = await applyJudgedSample(db, S, {
      teamId,
      score: 96,
      verdict: PHISHING,
      now: NOW,
    });
    expect(out).toMatchObject({ tier: "new", held: true, paused: false });
    expect(await team(teamId)).toMatchObject({
      suspendedAt: NOW,
      suspensionReason: "review",
      suspensionNote: null,
    });
    expect(await flags(teamId)).toMatchObject([
      { reason: "monitor", status: "open", openedBy: null, openedAt: NOW },
    ]);
    expect(await audits(teamId)).toMatchObject([
      { action: "team.held_for_review", actorId: "system", target: `team:${teamId}` },
    ]);
    const again = await applyJudgedSample(db, S, {
      teamId,
      score: 99,
      verdict: PHISHING,
      now: new Date(NOW.getTime() + HOUR),
    });
    expect(again.held).toBe(false);
    expect((await team(teamId))?.suspendedAt).toEqual(NOW);
    expect(await audits(teamId)).toHaveLength(1);
    // Released: the drained mail is judged again, and the same verdicts only alert.
    await db
      .update(schema.teams)
      .set({ suspendedAt: null, suspensionReason: null })
      .where(eq(schema.teams.id, teamId));
    const released = await applyJudgedSample(db, S, {
      teamId,
      score: 99,
      verdict: PHISHING,
      now: new Date(NOW.getTime() + 2 * HOUR),
    });
    expect(released.held).toBe(false);
    expect((await team(teamId))?.suspendedAt).toBeNull();
  });

  it("stays alert-only under the score, on other abuse, past the new tier, for system teams and with the policy off", async () => {
    const teamId = await newTeam("alert-only");
    const held = async (
      score: number,
      verdict: typeof PHISHING,
      s: MonitorSettings = S,
      id = teamId,
    ) => (await applyJudgedSample(db, s, { teamId: id, score, verdict, now: NOW })).held;
    expect(await held(89, PHISHING)).toBe(false);
    expect(
      await held(99, { verdict: "abuse", categories: ["scam"], reasons: ["unsolicited_bulk"] }),
    ).toBe(false);
    expect(await held(99, PHISHING, { ...S, autoHold: false })).toBe(false);
    expect(await held(99, PHISHING, S, await newTeam("settled", { sentTotal: 20_000 }))).toBe(
      false,
    );
    expect(await held(99, PHISHING, S, await newTeam("system", { plan: "system" }))).toBe(false);
    expect(
      await applyJudgedSample(db, S, { teamId, score: 99, now: NOW }).then((o) => o.held),
    ).toBe(false);
    expect((await team(teamId))?.suspendedAt).toBeNull();
    // The line is a setting; a lure reason alone is enough.
    expect(
      await held(
        85,
        { verdict: "abuse", categories: ["other_abuse"], reasons: ["harvests_secrets"] },
        { ...S, holdScore: 80 },
      ),
    ).toBe(true);
  });

  it("neither alerts nor pauses while the team is held, so a release leaves no pause behind", async () => {
    const teamId = await newTeam("held-backlog");
    expect(
      await applyJudgedSample(db, S, { teamId, score: 96, verdict: PHISHING, now: NOW }),
    ).toMatchObject({ held: true, alert: false, paused: false });
    // The samples taken before the hold are judged after it and carry the
    // risk past the alert and pause lines.
    for (let i = 1; i <= 20; i++) {
      expect(
        await applyJudgedSample(db, S, {
          teamId,
          score: 99,
          verdict: PHISHING,
          now: new Date(NOW.getTime() + i * 60_000),
        }),
      ).toMatchObject({ held: false, alert: false, paused: false });
    }
    expect(await team(teamId)).toMatchObject({
      suspensionReason: "review",
      broadcastsPausedByOperatorAt: null,
    });
    await db
      .update(schema.teams)
      .set({ suspendedAt: null, suspensionReason: null })
      .where(eq(schema.teams.id, teamId));
    const released = await applyJudgedSample(db, S, {
      teamId,
      score: 99,
      verdict: PHISHING,
      now: new Date(NOW.getTime() + HOUR),
    });
    expect(released).toMatchObject({ held: false, alert: true });
    expect(released.risk).toBeGreaterThan(S.pauseRisk);
  });

  it("leaves an operator's suspension as it is", async () => {
    const teamId = await newTeam("operator-suspended");
    await db
      .update(schema.teams)
      .set({ suspendedAt: NOW, suspensionReason: "non_payment", suspensionNote: "invoice" })
      .where(eq(schema.teams.id, teamId));
    const out = await applyJudgedSample(db, S, {
      teamId,
      score: 99,
      verdict: PHISHING,
      now: new Date(NOW.getTime() + HOUR),
    });
    expect(out.held).toBe(false);
    expect(await team(teamId)).toMatchObject({
      suspendedAt: NOW,
      suspensionReason: "non_payment",
      suspensionNote: "invoice",
    });
    expect(await flags(teamId)).toEqual([]);
  });

  /** As the judge does it: the verdict is stored, then folded in the same breath. */
  async function judge(
    teamId: string,
    score: number,
    verdict: Pick<JudgeVerdict, "verdict" | "categories" | "reasons">,
    at: Date,
    s: MonitorSettings = S,
  ) {
    await db.insert(schema.monitorSamples).values({
      teamId,
      kind: "first_sends",
      status: "judged",
      score,
      ...verdict,
      createdAt: at,
      judgedAt: at,
    });
    return (await applyJudgedSample(db, s, { teamId, score, verdict, now: at })).held;
  }
  const minute = (n: number) => new Date(NOW.getTime() + n * 60_000);

  it("holds a new team on its fifth phishing verdict from 80, not its fourth", async () => {
    const teamId = await newTeam("repeat");
    expect(await judge(teamId, 85, PHISHING, minute(1))).toBe(false);
    // Under the score, other abuse and a clean call with a lure finding do not count.
    expect(await judge(teamId, 79, PHISHING, minute(2))).toBe(false);
    expect(
      await judge(
        teamId,
        95,
        { verdict: "abuse", categories: ["scam"], reasons: ["unsolicited_bulk"] },
        minute(3),
      ),
    ).toBe(false);
    expect(
      await judge(
        teamId,
        88,
        { verdict: "clean", categories: [], reasons: ["off_domain_lure"] },
        minute(4),
      ),
    ).toBe(false);
    expect(await judge(teamId, 88, PHISHING, minute(5))).toBe(false);
    expect(
      await judge(
        teamId,
        80,
        { verdict: "abuse", categories: ["other_abuse"], reasons: ["harvests_secrets"] },
        minute(6),
      ),
    ).toBe(false);
    expect(await judge(teamId, 84, PHISHING, minute(7))).toBe(false);
    expect(await judge(teamId, 82, PHISHING, minute(8))).toBe(true);
    expect(await team(teamId)).toMatchObject({
      suspendedAt: minute(8),
      suspensionReason: "review",
    });
    expect(await flags(teamId)).toMatchObject([{ reason: "monitor", status: "open" }]);
    expect(await audits(teamId)).toMatchObject([{ action: "team.held_for_review" }]);
  });

  it("counts only the verdicts of the team's first seven days from its creation", async () => {
    const week = async (slug: string, fifthAfter: number) => {
      const teamId = await newTeam(slug);
      const created = (await team(teamId))?.createdAt.getTime() ?? 0;
      for (let i = 1; i <= 4; i++) {
        await judge(teamId, 85, PHISHING, new Date(created + DAY_MS + i * 60_000));
      }
      return judge(teamId, 85, PHISHING, new Date(created + fifthAfter));
    };
    expect(await week("repeat-in-week", 7 * DAY_MS - 60_000)).toBe(true);
    expect(await week("repeat-past-week", 7 * DAY_MS + 60_000)).toBe(false);
  });

  it("shares the hold's scope and switch, never holds a released team again, and reads both settings", async () => {
    const five = async (teamId: string, s: MonitorSettings = S) => {
      let held = false;
      for (let i = 1; i <= 5; i++) held = (await judge(teamId, 85, PHISHING, minute(i), s)) || held;
      return held;
    };
    const probation = await newTeam("repeat-probation", {
      sentTotal: 20_000,
      firstSendAt: new Date(NOW.getTime() - 4 * DAY_MS),
    });
    expect(await five(probation)).toBe(false);
    expect(await five(await newTeam("repeat-system", { plan: "system" }))).toBe(false);
    expect(await five(await newTeam("repeat-off"), { ...S, autoHold: false })).toBe(false);
    expect(await five(await newTeam("repeat-zero"), { ...S, holdRepeatCount: 0 })).toBe(false);
    // A release ends it: no verdict, before or after it, counts toward a second hold.
    const released = await newTeam("repeat-released");
    expect(await judge(released, 96, PHISHING, NOW)).toBe(true);
    await db
      .update(schema.teams)
      .set({ suspendedAt: null, suspensionReason: null })
      .where(eq(schema.teams.id, released));
    expect(await five(released)).toBe(false);
    const two = await newTeam("repeat-two");
    const s = { ...S, holdRepeatCount: 2, holdRepeatScore: 70 };
    expect(await judge(two, 75, PHISHING, minute(1), s)).toBe(false);
    expect(await judge(two, 75, PHISHING, minute(2), s)).toBe(true);
  });
});
