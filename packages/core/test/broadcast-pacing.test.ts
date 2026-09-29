import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bulkSentBySlot,
  cancelBroadcastRows,
  planRegionSend,
  quotaUsage,
  regionBulkCounts,
  regionDailyPeaks,
  rungThatFits,
  sendingBroadcasts,
} from "../src/broadcast-pacing.js";
import { type PlanCap, planBulkWaves } from "../src/ses-capacity.js";
import { utcDay } from "../src/utc-day.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let domainId: string;
let broadcastId: string;
const NOW = new Date("2026-09-16T12:14:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "pacing");
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "pacing.dev", region: "sa-east-1", status: "verified" })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("domain insert failed");
  domainId = domain.id;
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({
      teamId,
      from: "hi@pacing.dev",
      subject: "s",
      status: "sending",
      scheduledAt: ago(30),
    })
    .returning({ id: schema.broadcasts.id });
  if (!broadcast) throw new Error("broadcast insert failed");
  broadcastId = broadcast.id;
  const row = (over: Partial<typeof schema.emails.$inferInsert>) => ({
    teamId,
    domainId,
    from: "hi@pacing.dev",
    to: ["r@example.com"],
    subject: "s",
    ...over,
  });
  await db.insert(schema.emails).values([
    // Three bulk sends in the last day, two of them in one slot; one older than a day.
    row({ broadcastId, latestStatus: "sent", sentAt: ago(20) }),
    row({ broadcastId, latestStatus: "delivered", sentAt: ago(25) }),
    row({ broadcastId, latestStatus: "sent", sentAt: ago(400) }),
    row({ broadcastId, latestStatus: "sent", sentAt: ago(25 * 60) }),
    // Transactional sends count towards neither.
    row({ latestStatus: "sent", sentAt: ago(5) }),
    row({ latestStatus: "queued_quota" }),
    // The wave in flight, and the parked remainder.
    row({ broadcastId, latestStatus: "queued" }),
    row({ broadcastId, latestStatus: "queued" }),
    row({ broadcastId, latestStatus: "queued_quota" }),
    row({ broadcastId, latestStatus: "queued_quota" }),
    row({ broadcastId, latestStatus: "queued_quota" }),
  ]);
  await db.insert(schema.usageCounters).values({ teamId, day: utcDay(NOW), accepted: 5 });
});
afterAll(() => close());

it("counts bulk sends and queued bulk rows per region", async () => {
  const counts = await regionBulkCounts(db, NOW);
  expect(counts.get("sa-east-1")).toEqual({ sent24h: 3, queued: 2 });
});

it("buckets the region's bulk sends by drain slot", async () => {
  const slots = await bulkSentBySlot(db, { region: "sa-east-1", now: NOW });
  expect(slots.map((s) => s.count)).toEqual([1, 2]);
  expect(slots.map((s) => new Date(s.at).toISOString())).toEqual([
    "2026-09-16T05:30:00.000Z",
    "2026-09-16T11:45:00.000Z",
  ]);
});

it("lists the sending broadcasts of a region with their rows by state", async () => {
  expect(await sendingBroadcasts(db, { region: "sa-east-1" })).toEqual([
    {
      id: broadcastId,
      teamId,
      scheduledAt: ago(30),
      region: "sa-east-1",
      queued: 2,
      parked: 3,
      sent: 4,
    },
  ]);
  expect(await sendingBroadcasts(db, { region: "us-east-1" })).toEqual([]);
});

it("counts the contacts a walk has not reached yet as parked, until the walk ends", async () => {
  const parked = async () => (await sendingBroadcasts(db, { region: "sa-east-1" }))[0]?.parked;
  await db
    .update(schema.broadcasts)
    .set({ audienceCount: 20 })
    .where(eq(schema.broadcasts.id, broadcastId));
  // 9 rows written of 20: 3 parked plus the 11 still to come.
  expect(await parked()).toBe(14);
  await db
    .update(schema.broadcasts)
    .set({ recipientCount: 9 })
    .where(eq(schema.broadcasts.id, broadcastId));
  expect(await parked()).toBe(3);
  await db
    .update(schema.broadcasts)
    .set({ audienceCount: null, recipientCount: null })
    .where(eq(schema.broadcasts.id, broadcastId));
});

it("reads today's counter and the period's for the plan caps", async () => {
  expect(await quotaUsage(db, teamId, { kind: "day", plan: "free", limit: 100 }, NOW)).toEqual({
    day: 5,
    period: 0,
  });
});

it("finds the busiest day per class", async () => {
  expect(await regionDailyPeaks(db, { region: "sa-east-1", now: NOW })).toEqual({
    txPeak: 1,
    bulkPeak: 3,
  });
});

it("stops the rest: parked and queued rows flip, the queued reservations go back", async () => {
  expect(await cancelBroadcastRows(db, { broadcastId, teamId, now: NOW })).toBe(5);
  const rows = await db
    .select({ status: schema.emails.latestStatus })
    .from(schema.emails)
    .where(eq(schema.emails.broadcastId, broadcastId));
  expect(rows.filter((r) => r.status === "canceled")).toHaveLength(5);
  expect(rows.filter((r) => r.status === "sent" || r.status === "delivered")).toHaveLength(4);
  const [counter] = await db
    .select({ accepted: schema.usageCounters.accepted })
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, teamId));
  expect(counter?.accepted).toBe(3);
  // A second call finds nothing left.
  expect(await cancelBroadcastRows(db, { broadcastId, teamId, now: NOW })).toBe(0);
});

it("plans a region's sends from its live state and names the rung that fits", async () => {
  const plan = await planRegionSend(db, {
    region: "sa-east-1",
    account: { max24h: 100_000, sentLast24h: 6, maxSendRate: 14 },
    reservePercent: 30,
    rateCeiling: 14,
    horizonDays: 24,
    now: NOW,
    newSend: { key: "new", count: 170_000, at: NOW },
  });
  expect(plan.share).toBe(70_000);
  // Six sends in the window, three of them bulk: the rest is transactional.
  expect(plan.txPerDay).toBe(3);
  const mine = plan.estimates.find((e) => e.key === "new");
  // The three bulk sends still in the window take room; the stop above emptied the queue.
  expect(mine?.first).toBe(70_000 - 3);
  expect(mine?.days).toBe(3);
  const pro100 = {
    kind: "month" as const,
    plan: "pro" as const,
    included: 100_000,
    periodStart: new Date("2026-09-01T00:00:00Z"),
    periodEnd: new Date("2026-10-01T00:00:00Z"),
    overage: false,
    overageCentsPer1k: 30,
  };
  const used = { day: 60_000, period: 60_000 };
  const runner = (caps: PlanCap[]) =>
    planBulkWaves({
      share: 70_000,
      rate: 14,
      txPerDay: 0,
      sentBySlot: [],
      start: NOW,
      broadcasts: [{ key: "x", admit: 170_000, caps }],
    })[0];
  expect(rungThatFits(pro100, used, NOW, runner)).toMatchObject({ overage: true });
  expect(rungThatFits({ ...pro100, overage: true }, used, NOW, runner)).toBeNull();
  expect(
    rungThatFits({ kind: "day", plan: "free", limit: 100 }, { day: 0, period: 0 }, NOW, runner),
  ).toMatchObject({ rung: { key: "pro_200k" }, overage: false });
  expect(rungThatFits({ kind: "none" }, used, NOW, runner)).toBeNull();
});
