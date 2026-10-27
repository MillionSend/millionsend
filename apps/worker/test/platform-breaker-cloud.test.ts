import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { runPlatformBreaker } from "../src/handlers/platform-breaker.js";

let db: Db;
let close: () => Promise<void>;
let sends: { to: string; subject: string; text: string; kind: string }[] = [];
const synced: string[] = [];

const NOW = new Date("2026-09-03T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const minutesLater = (m: number) => new Date(NOW.getTime() + m * 60_000);
const run = (now: Date, isCloud = true) =>
  runPlatformBreaker(db, {
    mailer: {
      send: async (to, m) => {
        sends.push({ to, subject: m.subject, text: m.text, kind: m.kind });
      },
    },
    appBaseUrl: "https://app.example.test",
    now,
    isCloud,
    defaultRegion: "sa-east-1",
    syncTenant: async (teamId) => {
      synced.push(teamId);
    },
    ses: {
      regions: ["sa-east-1"],
      complaintRate: async () => 0.002,
      loggedAt: new Map(),
    },
  });

/** A team on `plan` sending `sent` emails from sa-east-1, `complaints` of them drawing one. */
async function sender(name: string, plan: "free" | "pro", sent: number, complaints: number) {
  const teamId = await createTeam(db, name);
  await db.update(schema.teams).set({ plan }).where(eq(schema.teams.id, teamId));
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: `${name.toLowerCase()}.example`,
      region: "sa-east-1",
      status: "verified",
    })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("seed failed");
  const rows = await db
    .insert(schema.emails)
    .values(
      Array.from({ length: sent }, (_, i) => ({
        teamId,
        domainId: domain.id,
        from: `f@${name.toLowerCase()}.example`,
        to: [`r${i}@example.com`],
        subject: "s",
        sentAt: hoursAgo(3),
      })),
    )
    .returning({ id: schema.emails.id });
  for (const email of rows.slice(0, complaints)) {
    await db.insert(schema.emailEvents).values({
      emailId: email.id,
      type: "complained",
      occurredAt: hoursAgo(1),
      createdAt: hoursAgo(1),
      snsMessageId: `sns-${email.id}`,
      data: {},
    });
  }
  return teamId;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db
    .insert(schema.user)
    .values({ id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => close());

it("on a complaint trip holds the paid team at the line, puts the Free team with a complaint up for review once, and keeps every other team sending", async () => {
  const paid = await sender("Paid", "pro", 1000, 2);
  const quiet = await sender("Quiet", "pro", 1000, 0);
  const free = await sender("Starter", "free", 100, 1);

  expect(await run(NOW)).toEqual({ tripped: ["sa-east-1"], resumed: [] });
  const [row] = await db.select().from(schema.regionBreakers);
  expect(row?.heldTeams).toEqual([paid]);
  expect(sends.map((s) => s.kind)).toEqual(["region.paused", "region.teams_held"]);
  expect(sends[0]?.subject).toBe(
    "Broadcasts paused in sa-east-1 for the teams drawing complaints: SES complaint rate at 0.20%",
  );
  expect(sends[0]?.text).toContain(
    "Only the broadcasts of the paid teams at or over 0.10% complaints over their own last 30 days are held: Paid. Free teams whose mail drew a complaint are held for review, named in a separate mail.",
  );
  expect(sends[1]).toMatchObject({
    to: "op@example.com",
    subject: "Held for review after complaints in sa-east-1: 1 Free team",
  });
  expect(sends[1]?.text).toContain("Starter");
  expect(sends[1]?.text).toContain("Open Trust & safety: https://app.example.test/console/safety");
  expect(synced).toEqual([free]);
  const standing = await db
    .select({ id: schema.teams.id, reason: schema.teams.suspensionReason })
    .from(schema.teams)
    .where(eq(schema.teams.suspensionReason, "review"));
  expect(standing).toEqual([{ id: free, reason: "review" }]);
  expect(standing.map((s) => s.id)).not.toContain(quiet);

  // Still tripped a run later: held already, nobody is told twice.
  expect(await run(minutesLater(15))).toEqual({ tripped: [], resumed: [] });
  expect(sends).toHaveLength(2);
  expect(synced).toEqual([free]);
  sends = [];
});

it("self-hosted, holds no team for review", async () => {
  await db.delete(schema.regionBreakers);
  await db.update(schema.teams).set({ suspendedAt: null, suspensionReason: null });
  await run(minutesLater(60), false);
  expect(sends.map((s) => s.kind)).toEqual(["region.paused"]);
  expect(
    await db.select().from(schema.teams).where(eq(schema.teams.suspensionReason, "review")),
  ).toEqual([]);
});
