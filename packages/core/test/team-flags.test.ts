import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeTeamStandings,
  flagTrigger,
  pruneTeamStandings,
  saveTeamStandings,
  syncTeamFlags,
  type TeamStandingRow,
} from "../src/team-flags.js";
import { utcDay } from "../src/utc-day.js";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const standing = (over: Partial<TeamStandingRow> & { teamId: string }): TeamStandingRow => ({
  scoreTenths: 80,
  guardrail: "ok",
  guardrailMetric: null,
  complaintRate7d: 0,
  hardBounceRate7d: 0,
  sent7d: 1_000,
  sent30d: 4_000,
  ...over,
});

const flagsOf = (teamId: string) =>
  db.select().from(schema.teamFlags).where(eq(schema.teamFlags.teamId, teamId));

describe("flagTrigger", () => {
  const id = "t";
  it("a guardrail warning flags as guardrail", () => {
    expect(
      flagTrigger(standing({ teamId: id, guardrail: "warning", complaintRate7d: 0.0006 })),
    ).toEqual({
      reason: "guardrail",
      detail: { guardrail: "warning", metric: "complaint", rate: 0.0006 },
    });
  });
  it("complaints at SES's review line flag as complaints/complaint", () => {
    expect(flagTrigger(standing({ teamId: id, complaintRate7d: 0.001, sent7d: 100 }))).toEqual({
      reason: "complaints",
      detail: { metric: "complaint", rate: 0.001 },
    });
  });
  it("hard bounces at 5% flag as complaints/hard_bounce", () => {
    expect(flagTrigger(standing({ teamId: id, hardBounceRate7d: 0.05 }))).toEqual({
      reason: "complaints",
      detail: { metric: "hard_bounce", rate: 0.05 },
    });
  });
  it("stays quiet below the volume floor, whatever the rate", () => {
    expect(flagTrigger(standing({ teamId: id, complaintRate7d: 0.5, sent7d: 99 }))).toBeNull();
  });
  it("a score under 5 flags; 5 does not", () => {
    expect(flagTrigger(standing({ teamId: id, scoreTenths: 49 }))).toEqual({
      reason: "score",
      detail: { metric: "score", scoreTenths: 49 },
    });
    expect(flagTrigger(standing({ teamId: id, scoreTenths: 50 }))).toBeNull();
    expect(flagTrigger(standing({ teamId: id, scoreTenths: null }))).toBeNull();
  });
});

describe("syncTeamFlags", () => {
  it("opens, keeps opened_at, follows the trigger, and clears when it is gone", async () => {
    const teamId = await createTeam(db, "auto");
    const t1 = new Date("2026-09-01T00:00:00Z");
    const t2 = new Date("2026-09-02T00:00:00Z");
    const t3 = new Date("2026-09-03T00:00:00Z");

    expect(await syncTeamFlags(db, [standing({ teamId, complaintRate7d: 0.002 })], t1)).toEqual({
      opened: 1,
      cleared: 0,
    });
    const [opened] = await flagsOf(teamId);
    expect(opened).toMatchObject({
      reason: "complaints",
      status: "open",
      openedBy: null,
      openedAt: t1,
      detail: { metric: "complaint", rate: 0.002 },
    });

    expect(await syncTeamFlags(db, [standing({ teamId, complaintRate7d: 0.003 })], t2)).toEqual({
      opened: 0,
      cleared: 0,
    });
    expect((await flagsOf(teamId))[0]).toMatchObject({ id: opened?.id, openedAt: t1 });

    // The trigger moves up to the guardrail: same row, new reason and detail.
    expect(
      await syncTeamFlags(
        db,
        [standing({ teamId, guardrail: "paused", complaintRate7d: 0.003 })],
        t2,
      ),
    ).toEqual({ opened: 0, cleared: 0 });
    expect(await flagsOf(teamId)).toHaveLength(1);
    expect((await flagsOf(teamId))[0]).toMatchObject({
      id: opened?.id,
      reason: "guardrail",
      openedAt: t1,
      detail: { guardrail: "paused", metric: "complaint", rate: 0.003 },
    });

    expect(await syncTeamFlags(db, [standing({ teamId })], t3)).toEqual({
      opened: 0,
      cleared: 1,
    });
    expect((await flagsOf(teamId))[0]).toMatchObject({
      status: "cleared",
      clearedAt: t3,
      clearedBy: null,
    });
  });

  it("leaves a manual flag alone", async () => {
    const teamId = await createTeam(db, "manual");
    await db
      .insert(schema.teamFlags)
      .values({ teamId, reason: "manual", note: "by hand", openedBy: "op" });
    // No trigger in the standings, and a trigger of a different reason: neither touches it.
    expect(await syncTeamFlags(db, [standing({ teamId })])).toEqual({ opened: 0, cleared: 0 });
    expect(await syncTeamFlags(db, [standing({ teamId, scoreTenths: 10 })])).toEqual({
      opened: 0,
      cleared: 0,
    });
    expect(await flagsOf(teamId)).toMatchObject([
      { reason: "manual", status: "open", openedBy: "op" },
    ]);
  });

  it("does not reopen what an operator cleared for the same reason while the trigger holds", async () => {
    const teamId = await createTeam(db, "cleared");
    await db.insert(schema.teamFlags).values({
      teamId,
      reason: "complaints",
      status: "cleared",
      clearedBy: "op",
      clearedAt: new Date("2026-09-01T00:00:00Z"),
      openedAt: new Date("2026-08-30T00:00:00Z"),
    });
    const noisy = standing({ teamId, complaintRate7d: 0.002 });
    // The previous run fired the same trigger: the operator's clear stands.
    expect(await syncTeamFlags(db, [noisy], new Date(), [noisy])).toEqual({
      opened: 0,
      cleared: 0,
    });
    expect(await flagsOf(teamId)).toHaveLength(1);

    // A different reason is a new finding.
    expect(
      await syncTeamFlags(db, [standing({ teamId, scoreTenths: 20 })], new Date(), [noisy]),
    ).toEqual({
      opened: 1,
      cleared: 0,
    });
    expect((await flagsOf(teamId)).filter((f) => f.status === "open")).toMatchObject([
      { reason: "score" },
    ]);
  });

  it("reopens a cleared reason once its trigger lapsed and came back", async () => {
    const teamId = await createTeam(db, "lapsed");
    await db.insert(schema.teamFlags).values({
      teamId,
      reason: "complaints",
      status: "cleared",
      clearedBy: "op",
      clearedAt: new Date("2026-09-01T00:00:00Z"),
      openedAt: new Date("2026-08-30T00:00:00Z"),
    });
    const noisy = standing({ teamId, complaintRate7d: 0.002 });
    // The previous run was clean, so this is a fresh finding, not the one cleared.
    expect(await syncTeamFlags(db, [noisy], new Date(), [standing({ teamId })])).toMatchObject({
      opened: 1,
    });
    expect((await flagsOf(teamId)).filter((f) => f.status === "open")).toHaveLength(1);
  });

  it("reads the previous standings from the table when none are handed in", async () => {
    const teamId = await createTeam(db, "from-table");
    await db.insert(schema.teamFlags).values({
      teamId,
      reason: "complaints",
      status: "cleared",
      clearedBy: "op",
      clearedAt: new Date("2026-09-01T00:00:00Z"),
      openedAt: new Date("2026-08-30T00:00:00Z"),
    });
    const noisy = standing({ teamId, complaintRate7d: 0.002 });
    await saveTeamStandings(db, [noisy]);
    expect(await syncTeamFlags(db, [noisy])).toMatchObject({ opened: 0 });
    expect((await flagsOf(teamId)).filter((f) => f.status === "open")).toEqual([]);
  });
});

describe("guardrail metric", () => {
  it("a guardrail tripped by hard bounces reads as such even when the 7-day rate is under the line", () => {
    expect(
      flagTrigger(
        standing({
          teamId: "t",
          guardrail: "paused",
          guardrailMetric: "hard_bounce",
          hardBounceRate7d: 0.02,
          complaintRate7d: 0.004,
        }),
      ),
    ).toEqual({
      reason: "guardrail",
      detail: { guardrail: "paused", metric: "hard_bounce", rate: 0.02 },
    });
  });
});

describe("standings", () => {
  it("saveTeamStandings upserts", async () => {
    const teamId = await createTeam(db, "upsert");
    const t1 = new Date("2026-09-01T00:00:00Z");
    const t2 = new Date("2026-09-02T00:00:00Z");
    await saveTeamStandings(db, [standing({ teamId, sent7d: 10 })], t1);
    await saveTeamStandings(db, [standing({ teamId, sent7d: 20, guardrail: "warning" })], t2);
    const rows = await db
      .select()
      .from(schema.teamStandings)
      .where(eq(schema.teamStandings.teamId, teamId));
    expect(rows).toEqual([
      {
        teamId,
        scoreTenths: 80,
        guardrail: "warning",
        guardrailMetric: null,
        complaintRate7d: 0,
        hardBounceRate7d: 0,
        sent7d: 20,
        sent30d: 4_000,
        computedAt: t2,
      },
    ]);
    await saveTeamStandings(db, [], t2);
  });

  it("pruneTeamStandings drops what a run did not refresh", async () => {
    const kept = await createTeam(db, "kept");
    const gone = await createTeam(db, "gone");
    const earlier = new Date("2026-09-10T00:00:00Z");
    const later = new Date("2026-09-10T00:15:00Z");
    await saveTeamStandings(db, [standing({ teamId: kept }), standing({ teamId: gone })], earlier);
    await saveTeamStandings(db, [standing({ teamId: kept })], later);
    expect(await pruneTeamStandings(db, later)).toBeGreaterThanOrEqual(1);
    const left = await db
      .select({ teamId: schema.teamStandings.teamId })
      .from(schema.teamStandings)
      .where(inArray(schema.teamStandings.teamId, [kept, gone]));
    expect(left).toEqual([{ teamId: kept }]);
  });

  it("computeTeamStandings reads the counters of every team that sent", async () => {
    const teamId = await createTeam(db, "compute");
    const now = new Date("2026-09-15T12:00:00Z");
    await db
      .insert(schema.usageCounters)
      .values({ teamId, day: utcDay(now), sent: 200, complained: 1 });
    const rows = await computeTeamStandings(db, now);
    expect(rows.filter((r) => r.teamId === teamId)).toMatchObject([
      {
        teamId,
        guardrail: "ok",
        complaintRate7d: 0.005,
        hardBounceRate7d: 0,
        sent7d: 200,
        sent30d: 200,
      },
    ]);
  });
});
