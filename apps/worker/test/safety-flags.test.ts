import { utcDay } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runSafetyFlags } from "../src/handlers/safety-flags.js";

let db: Db;
let close: () => Promise<void>;
let noisy: string;
let clean: string;

const NOW = new Date("2026-09-15T12:00:00Z");
const DAY = utcDay(NOW);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  noisy = await createTeam(db, "noisy");
  clean = await createTeam(db, "clean");
  await db.insert(schema.usageCounters).values([
    { teamId: noisy, day: DAY, sent: 200, complained: 4 },
    { teamId: clean, day: DAY, sent: 200 },
  ]);
  await db.insert(schema.contacts).values([
    { teamId: clean, email: "stay@example.com" },
    { teamId: clean, email: "left@example.com", unsubscribed: true },
  ]);
});
afterAll(() => close());

const flagsOf = (teamId: string) =>
  db.select().from(schema.teamFlags).where(eq(schema.teamFlags.teamId, teamId));

it("flags the noisy team only, stands both, and records the unsubscribed count", async () => {
  expect(await runSafetyFlags(db, { now: NOW })).toEqual({
    teams: 2,
    opened: 1,
    cleared: 0,
    graduated: 0,
  });

  expect(await flagsOf(noisy)).toMatchObject([
    { status: "open", openedBy: null, openedAt: NOW, reason: "guardrail" },
  ]);
  expect(await flagsOf(clean)).toEqual([]);

  const standings = await db.select().from(schema.teamStandings);
  expect(standings.map((s) => s.teamId).sort()).toEqual([noisy, clean].sort());
  expect(standings.find((s) => s.teamId === noisy)).toMatchObject({
    guardrail: "paused",
    complaintRate7d: 0.02,
    sent7d: 200,
    sent30d: 200,
    computedAt: NOW,
  });
  expect(standings.find((s) => s.teamId === clean)).toMatchObject({
    guardrail: "ok",
    complaintRate7d: 0,
  });

  const probes = await db
    .select()
    .from(schema.instanceProbes)
    .where(
      and(
        eq(schema.instanceProbes.probe, "contacts_unsubscribed"),
        eq(schema.instanceProbes.takenAt, NOW),
      ),
    );
  expect(probes).toMatchObject([{ value: 1, ok: true }]);
});

it("clears the flag once the counters are fixed", async () => {
  const later = new Date(NOW.getTime() + 15 * 60_000);
  await db
    .update(schema.usageCounters)
    .set({ complained: 0 })
    .where(and(eq(schema.usageCounters.teamId, noisy), eq(schema.usageCounters.day, DAY)));
  expect(await runSafetyFlags(db, { now: later })).toEqual({
    teams: 2,
    opened: 0,
    cleared: 1,
    graduated: 0,
  });
  expect(await flagsOf(noisy)).toMatchObject([
    { status: "cleared", clearedBy: null, clearedAt: later, openedAt: NOW },
  ]);
  expect(
    (await db.select().from(schema.teamStandings)).find((s) => s.teamId === noisy),
  ).toMatchObject({ guardrail: "ok", complaintRate7d: 0, computedAt: later });
});

it("opens the monitor flag off the team's risk and carries it on the standing", async () => {
  const risky = await createTeam(db, "risky");
  const later = new Date(NOW.getTime() + 30 * 60_000);
  await db.insert(schema.usageCounters).values({ teamId: risky, day: DAY, sent: 50 });
  // Twelve certain verdicts an hour ago: about 0.83 now, decaying toward the settled prior.
  await db.insert(schema.teamMonitor).values({
    teamId: risky,
    sentTotal: 50,
    firstSendAt: new Date(NOW.getTime() - 40 * 86_400_000),
    risk: 0.83,
    riskNum: 12,
    riskDen: 12,
    riskUpdatedAt: NOW,
  });
  await db.insert(schema.monitorSamples).values([
    { teamId: risky, kind: "first_sends", status: "judged", score: 80, createdAt: NOW },
    { teamId: risky, kind: "first_sends", status: "judged", score: 90, createdAt: NOW },
    { teamId: risky, kind: "first_sends", status: "unjudged", createdAt: NOW },
  ]);
  expect(await runSafetyFlags(db, { now: later })).toMatchObject({ opened: 1 });
  expect(await flagsOf(risky)).toMatchObject([
    { status: "open", reason: "monitor", detail: { risk: 0.83, samples: 2 } },
  ]);
  expect(
    (await db.select().from(schema.teamStandings)).find((s) => s.teamId === risky)?.monitorRisk,
  ).toBeCloseTo(0.83, 2);
  // A higher configured line leaves the same team alone next run.
  const evenLater = new Date(later.getTime() + 15 * 60_000);
  expect(await runSafetyFlags(db, { now: evenLater, monitorFlagRisk: 0.9 })).toMatchObject({
    cleared: 1,
  });
  // With no new verdict the risk decays on its own: weeks later the standing reads near the prior.
  const weeksOn = new Date(NOW.getTime() + 60 * 86_400_000);
  await db.insert(schema.usageCounters).values({ teamId: risky, day: utcDay(weeksOn), sent: 10 });
  expect(await runSafetyFlags(db, { now: weeksOn })).toMatchObject({ opened: 0 });
  const standing = (await db.select().from(schema.teamStandings)).find((s) => s.teamId === risky);
  expect(standing?.monitorRisk).toBeLessThan(0.2);
});

it("opens nothing from a stored risk while the judge is off", async () => {
  const stale = await createTeam(db, "stale");
  const t = new Date(NOW.getTime() + 61 * 86_400_000);
  await db.insert(schema.usageCounters).values({ teamId: stale, day: utcDay(t), sent: 50 });
  await db.insert(schema.teamMonitor).values({
    teamId: stale,
    sentTotal: 50,
    risk: 0.95,
    riskNum: 20,
    riskDen: 20,
    riskUpdatedAt: t,
  });
  expect(
    await runSafetyFlags(db, { now: t, monitorFlagRisk: Number.POSITIVE_INFINITY }),
  ).toMatchObject({ opened: 0 });
  expect(await flagsOf(stale)).toEqual([]);
});

it("moves a warming domain up a step once its sends are clean", async () => {
  await db.insert(schema.instanceSettings).values({ id: 1, warmupEnabled: true });
  const warming = await createTeam(db, "warming");
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId: warming,
      name: "news.warming-up.com",
      region: "us-east-1",
      status: "verified",
      registeredAt: new Date(NOW.getTime() - 3 * 24 * 3600_000),
    })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("domain insert failed");
  await db.insert(schema.emails).values(
    Array.from({ length: 50 }, () => ({
      teamId: warming,
      domainId: domain.id,
      from: "news@news.warming-up.com",
      to: ["r@example.com"],
      subject: "s",
      latestStatus: "delivered" as const,
      sentAt: new Date(NOW.getTime() - 25 * 3600_000),
    })),
  );
  expect(await runSafetyFlags(db, { now: NOW })).toMatchObject({ graduated: 1 });
  const [row] = await db
    .select({ tier: schema.domains.warmupTier })
    .from(schema.domains)
    .where(eq(schema.domains.id, domain.id));
  expect(row?.tier).toBe(2);
});
