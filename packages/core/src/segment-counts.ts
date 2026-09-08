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
 * A count this old is refreshed even when nothing looks changed: contact
 * deletes and manual-member removals leave no newer row behind, so the
 * change checks below cannot see them.
 * ponytail: bounded staleness instead of a signal; have those paths null
 * segments.counted_at for the team and drop this ceiling.
 */
const RECOUNT_CEILING_MS = 24 * 60 * 60 * 1000;

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
  const ceiling = new Date(now.getTime() - RECOUNT_CEILING_MS);
  const s = schema.segments;
  const c = schema.contacts;
  const m = schema.segmentMembers;
  const changedSince = or(
    exists(
      db
        .select({ one: sql`1` })
        .from(c)
        .where(and(eq(c.teamId, s.teamId), gt(c.updatedAt, s.countedAt))),
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(m)
        .where(and(eq(m.segmentId, s.id), gt(m.createdAt, s.countedAt))),
    ),
  );
  const stale = await db
    .select({ id: s.id, teamId: s.teamId, filter: s.filter })
    .from(s)
    .where(
      or(isNull(s.countedAt), lt(s.countedAt, ceiling), and(lt(s.countedAt, before), changedSince)),
    )
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
