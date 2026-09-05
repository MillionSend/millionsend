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
  const contacts = await db
    .insert(schema.contacts)
    .values([
      { teamId, email: "a@example.com" },
      { teamId, email: "b@example.com", unsubscribed: true },
      { teamId, email: "c@example.com" },
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
    .values(contacts.slice(0, 2).map((c) => ({ segmentId: segment.id, contactId: c.id })));

  expect(await countSegment(db, segment)).toEqual({ count: 2, unsubscribedCount: 1 });

  const now = new Date("2026-09-04T12:00:00Z");
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

  // Fresh enough: nothing to do. Half an hour later: recounted.
  expect(await recountStaleSegments(db, { olderThanMs: 30 * 60_000, now })).toBe(0);
  const later = new Date(now.getTime() + 31 * 60_000);
  expect(await recountStaleSegments(db, { olderThanMs: 30 * 60_000, now: later })).toBe(1);
});
