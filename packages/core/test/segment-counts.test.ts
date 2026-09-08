import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  countSegment,
  markSegmentsStale,
  recountSegment,
  recountStaleSegments,
} from "../src/segment-counts.js";

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => Promise<void>;

// Fresh database per test: the stale count is global, so one test's leftovers
// would show up in the next.
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(() => close());

it("counts members and unsubscribed members, stores them, and refreshes only stale segments", async () => {
  const teamId = await createTeam(db, "segment-counts");
  const now = new Date("2026-09-04T12:00:00Z");
  const earlier = new Date(now.getTime() - 60 * 60_000);
  const contacts = await db
    .insert(schema.contacts)
    .values([
      { teamId, email: "a@example.com", updatedAt: earlier },
      { teamId, email: "b@example.com", unsubscribed: true, updatedAt: earlier },
      { teamId, email: "c@example.com", updatedAt: earlier },
    ])
    .returning({ id: schema.contacts.id });
  const [segment] = await db
    .insert(schema.segments)
    .values({ teamId, name: "Manual", filter: null })
    .returning({
      id: schema.segments.id,
      teamId: schema.segments.teamId,
      filter: schema.segments.filter,
    });
  if (!segment) throw new Error("segment insert failed");
  await db
    .insert(schema.segmentMembers)
    .values(
      contacts
        .slice(0, 2)
        .map((c) => ({ segmentId: segment.id, contactId: c.id, createdAt: earlier })),
    );

  expect(await countSegment(db, segment)).toEqual({ count: 2, unsubscribedCount: 1 });

  expect(await recountSegment(db, segment, now)).toEqual({ count: 2, unsubscribedCount: 1 });
  const [stored] = await db
    .select({
      contactCount: schema.segments.contactCount,
      unsubscribedCount: schema.segments.unsubscribedCount,
      countedAt: schema.segments.countedAt,
    })
    .from(schema.segments)
    .where(eq(schema.segments.id, segment.id));
  expect(stored).toEqual({ contactCount: 2, unsubscribedCount: 1, countedAt: now });

  // Fresh enough: nothing to do. Stale, but no contact or member changed
  // since the count: still skipped.
  expect(await recountStaleSegments(db, { olderThanMs: 30 * 60_000, now })).toBe(0);
  const idle = new Date(now.getTime() + 31 * 60_000);
  expect(await recountStaleSegments(db, { olderThanMs: 30 * 60_000, now: idle })).toBe(0);
  // A contact write after the count (and past the grace window of the next
  // one) brings the segment back.
  const third = contacts[2];
  if (!third) throw new Error("contact insert failed");
  await db
    .update(schema.contacts)
    .set({ unsubscribed: true, updatedAt: new Date(idle.getTime() - 6 * 60_000) })
    .where(eq(schema.contacts.id, third.id));
  expect(await recountStaleSegments(db, { olderThanMs: 30 * 60_000, now: idle })).toBe(1);
  // So does a manual membership added after the count.
  const afterIdle = new Date(idle.getTime() + 31 * 60_000);
  expect(await recountStaleSegments(db, { olderThanMs: 30 * 60_000, now: afterIdle })).toBe(0);
  await db.insert(schema.segmentMembers).values({
    segmentId: segment.id,
    contactId: third.id,
    createdAt: new Date(afterIdle.getTime() - 6 * 60_000),
  });
  expect(await recountStaleSegments(db, { olderThanMs: 30 * 60_000, now: afterIdle })).toBe(1);
  expect(await countSegment(db, segment)).toEqual({ count: 3, unsubscribedCount: 2 });
  // Age alone never triggers a recount: deletes signal through markSegmentsStale.
  const dayLater = new Date(afterIdle.getTime() + 25 * 60 * 60_000);
  expect(await recountStaleSegments(db, { olderThanMs: 30 * 60_000, now: dayLater })).toBe(0);
  const storedCountedAt = async () =>
    (
      await db
        .select({ countedAt: schema.segments.countedAt })
        .from(schema.segments)
        .where(eq(schema.segments.id, segment.id))
    )[0]?.countedAt;
  await markSegmentsStale(db, { teamId });
  expect(await storedCountedAt()).toBeNull();
  expect(await recountStaleSegments(db, { olderThanMs: 30 * 60_000, now: dayLater })).toBe(1);
  expect(await storedCountedAt()).toEqual(dayLater);
  await markSegmentsStale(db, { segmentId: segment.id });
  expect(await recountStaleSegments(db, { olderThanMs: 30 * 60_000, now: dayLater })).toBe(1);
  // Another team's segments are untouched by a team-scoped mark.
  const otherTeam = await createTeam(db, "segment-counts-other");
  const [other] = await db
    .insert(schema.segments)
    .values({ teamId: otherTeam, name: "Other", filter: null, countedAt: dayLater })
    .returning({ id: schema.segments.id });
  await markSegmentsStale(db, { teamId });
  expect(
    (
      await db
        .select({ countedAt: schema.segments.countedAt })
        .from(schema.segments)
        .where(eq(schema.segments.id, other?.id ?? ""))
    )[0]?.countedAt,
  ).toEqual(dayLater);
});

it("a write stamped just before counted_at (committed after the count's snapshot) still triggers a recount", async () => {
  const teamId = await createTeam(db, "segment-counts-grace");
  const now = new Date("2026-09-04T12:00:00Z");
  const minutesBefore = (m: number, from = now) => new Date(from.getTime() - m * 60_000);
  const [contact] = await db
    .insert(schema.contacts)
    .values({ teamId, email: "x@example.com", updatedAt: minutesBefore(6) })
    .returning({ id: schema.contacts.id });
  const [segment] = await db
    .insert(schema.segments)
    .values({ teamId, name: "Manual", filter: null })
    .returning({
      id: schema.segments.id,
      teamId: schema.segments.teamId,
      filter: schema.segments.filter,
    });
  if (!segment || !contact) throw new Error("seed failed");
  await recountSegment(db, segment, now);
  const idle = new Date(now.getTime() + 31 * 60_000);
  // Six minutes before the count: outside the grace window, nothing changed.
  expect(await recountStaleSegments(db, { olderThanMs: 30 * 60_000, now: idle })).toBe(0);
  // Two minutes before the count: inside it, so the segment is recounted.
  await db
    .update(schema.contacts)
    .set({ updatedAt: minutesBefore(2) })
    .where(eq(schema.contacts.id, contact.id));
  expect(await recountStaleSegments(db, { olderThanMs: 30 * 60_000, now: idle })).toBe(1);
  // Same grace for a manual member added just before the count.
  const later = new Date(idle.getTime() + 31 * 60_000);
  expect(await recountStaleSegments(db, { olderThanMs: 30 * 60_000, now: later })).toBe(0);
  await db
    .insert(schema.segmentMembers)
    .values({ segmentId: segment.id, contactId: contact.id, createdAt: minutesBefore(2, idle) });
  expect(await recountStaleSegments(db, { olderThanMs: 30 * 60_000, now: later })).toBe(1);
});
