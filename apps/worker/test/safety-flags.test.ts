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
  expect(await runSafetyFlags(db, { now: NOW })).toEqual({ teams: 2, opened: 1, cleared: 0 });

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
  expect(await runSafetyFlags(db, { now: later })).toEqual({ teams: 2, opened: 0, cleared: 1 });
  expect(await flagsOf(noisy)).toMatchObject([
    { status: "cleared", clearedBy: null, clearedAt: later, openedAt: NOW },
  ]);
  expect(
    (await db.select().from(schema.teamStandings)).find((s) => s.teamId === noisy),
  ).toMatchObject({ guardrail: "ok", complaintRate7d: 0, computedAt: later });
});
