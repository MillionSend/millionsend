import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, eq, exists, gt, isNull, lt, or, sql } from "drizzle-orm";
import { segmentContactsWhere } from "./segment-filter.js";

export interface SegmentCounts {
  count: number;
  unsubscribedCount: number;
}

type SavedSegment = Pick<typeof schema.segments.$inferSelect, "id" | "teamId" | "filter">;

/**
 * Live counts for one saved segment: filter matches plus manual members.
 * Every call scans the team's contacts, so callers that show many segments
 * read the stored numbers (recountSegment) instead.
 */
export async function countSegment(db: Db, segment: SavedSegment): Promise<SegmentCounts> {
  const c = schema.contacts;
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      unsubscribedCount: sql<number>`count(*) filter (where ${c.unsubscribed})::int`,
    })
    .from(c)
    .where(and(eq(c.teamId, segment.teamId), segmentContactsWhere(c, segment)));
  return row ?? { count: 0, unsubscribedCount: 0 };
}

/** Counts a segment and stores the result with its timestamp for the list to read. */
export async function recountSegment(
  db: Db,
  segment: SavedSegment,
  now = new Date(),
): Promise<SegmentCounts> {
  const counts = await countSegment(db, segment);
  const s = schema.segments;
  // Written only while the row still carries the filter that was counted:
  // a concurrent filter change recounts on its own, and a stale count must
  // not overwrite it (jsonb equality is semantic, so key order is irrelevant).
  await db
    .update(s)
    .set({
      contactCount: counts.count,
      unsubscribedCount: counts.unsubscribedCount,
      countedAt: now,
    })
    .where(
      and(
        eq(s.id, segment.id),
        segment.filter === null ? isNull(s.filter) : eq(s.filter, segment.filter),
      ),
    );
  return counts;
}

/**
 * Marks a team's segments (or one segment) as never counted so the next
 * recount pass refreshes them. Contact deletes and manual-member removals
 * must call this: they leave no newer row for recountStaleSegments to see.
 * The stored counts stay readable until then.
 */
export async function markSegmentsStale(
  db: Db,
  scope: { teamId: string } | { segmentId: string },
): Promise<void> {
  const s = schema.segments;
  await db
    .update(s)
    .set({ countedAt: null })
    .where("teamId" in scope ? eq(s.teamId, scope.teamId) : eq(s.id, scope.segmentId));
}

/**
 * Refreshes segments never counted or counted before `olderThanMs` ago, one
 * statement per segment so no single query grows with the number of segments.
 * A stale segment is skipped while no contact of its team and no manual
 * member was written since it was counted (index lookups, never a scan), so
 * an idle team's segments cost nothing between imports.
 */
export async function recountStaleSegments(
  db: Db,
  opts: { olderThanMs: number; now?: Date; limit?: number },
): Promise<number> {
  const now = opts.now ?? new Date();
  const before = new Date(now.getTime() - opts.olderThanMs);
  const s = schema.segments;
  const c = schema.contacts;
  const m = schema.segmentMembers;
  // Grace window: a write that committed after the count's snapshot carries
  // a timestamp before counted_at; compared strictly it would be missed
  // until the next write to the team.
  const grace = sql`${s.countedAt} - interval '5 minutes'`;
  const changedSince = or(
    exists(
      db
        .select({ one: sql`1` })
        .from(c)
        .where(and(eq(c.teamId, s.teamId), gt(c.updatedAt, grace))),
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(m)
        .where(and(eq(m.segmentId, s.id), gt(m.createdAt, grace))),
    ),
  );
  const stale = await db
    .select({ id: s.id, teamId: s.teamId, filter: s.filter })
    .from(s)
    .where(or(isNull(s.countedAt), and(lt(s.countedAt, before), changedSince)))
    .orderBy(asc(s.countedAt))
    .limit(opts.limit ?? 200);
  for (const segment of stale) {
    try {
      await recountSegment(db, segment, now);
    } catch (err) {
      console.warn(
        `segments.recount: ${segment.id} skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return stale.length;
}
