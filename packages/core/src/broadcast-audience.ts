import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SegmentFilter } from "@millionsend/db/schema";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { segmentContactsWhere } from "./segment-filter.js";

/**
 * The contacts a broadcast goes to: the team's subscribed contacts, in its
 * segment (filter matches plus manual members), and in its topic by the
 * subscription rule (an explicit row wins, else the topic's default). The
 * fan-out's audience count and every preview of a send read this one
 * predicate, over `contacts` unaliased.
 */
export function broadcastAudienceWhere(
  teamId: string,
  segment: { id: string; filter: SegmentFilter | null } | null,
  topic: { id: string; defaultSubscribed: boolean } | null,
): SQL {
  const c = schema.contacts;
  const s = schema.contactTopicSubscriptions;
  const topicRule = !topic
    ? undefined
    : topic.defaultSubscribed
      ? sql`not exists (select 1 from ${s} where ${s.contactId} = ${c.id} and ${s.topicId} = ${topic.id} and ${s.subscribed} = false)`
      : sql`exists (select 1 from ${s} where ${s.contactId} = ${c.id} and ${s.topicId} = ${topic.id} and ${s.subscribed} = true)`;
  return and(
    eq(c.teamId, teamId),
    eq(c.unsubscribed, false),
    segment ? segmentContactsWhere(c, segment) : undefined,
    topicRule,
  ) as SQL;
}

/** broadcastAudienceWhere for a send's targets, read team-scoped; null when the segment or topic is not the team's. */
export async function broadcastAudience(
  db: Db,
  teamId: string,
  targets: { segmentId: string | null; topicId: string | null },
): Promise<SQL | null> {
  let segment: { id: string; filter: SegmentFilter | null } | null = null;
  if (targets.segmentId) {
    const sg = schema.segments;
    [segment = null] = await db
      .select({ id: sg.id, filter: sg.filter })
      .from(sg)
      .where(and(eq(sg.id, targets.segmentId), eq(sg.teamId, teamId)));
    if (!segment) return null;
  }
  let topic: { id: string; defaultSubscribed: boolean } | null = null;
  if (targets.topicId) {
    const t = schema.topics;
    [topic = null] = await db
      .select({ id: t.id, defaultSubscribed: t.defaultSubscribed })
      .from(t)
      .where(and(eq(t.id, targets.topicId), eq(t.teamId, teamId)));
    if (!topic) return null;
  }
  return broadcastAudienceWhere(teamId, segment, topic);
}
