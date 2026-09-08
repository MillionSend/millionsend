import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { countSegment, recountSegment, recountStaleSegments } from "../src/segment-counts.js";

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

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
  // A contact write after the count brings the segment back.
  const third = contacts[2];
  if (!third) throw new Error("contact insert failed");
  await db
    .update(schema.contacts)
    .set({ unsubscribed: true, updatedAt: new Date(idle.getTime() - 60_000) })
    .where(eq(schema.contacts.id, third.id));
  expect(await recountStaleSegments(db, { olderThanMs: 30 * 60_000, now: idle })).toBe(1);
  // So does a manual membership added after the count.
  const afterIdle = new Date(idle.getTime() + 31 * 60_000);
  expect(await recountStaleSegments(db, { olderThanMs: 30 * 60_000, now: afterIdle })).toBe(0);
  await db
    .insert(schema.segmentMembers)
    .values({ segmentId: segment.id, contactId: third.id, createdAt: afterIdle });
  expect(await recountStaleSegments(db, { olderThanMs: 30 * 60_000, now: afterIdle })).toBe(1);
  expect(await countSegment(db, segment)).toEqual({ count: 3, unsubscribedCount: 2 });
  // A day-old count is refreshed regardless: deletes leave no newer row.
  const dayLater = new Date(afterIdle.getTime() + 25 * 60 * 60_000);
  expect(await recountStaleSegments(db, { olderThanMs: 30 * 60_000, now: dayLater })).toBe(1);
});
