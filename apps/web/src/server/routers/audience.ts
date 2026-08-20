import { recordContactActivity, resultRows } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, ilike, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { escapeLike } from "@/lib/sql";
import { beforeCursor, createdAtCursorField, cursorSchema, paginate } from "../keyset";
import { router, teamProcedure } from "../trpc";
import { assertSegment, segmentPredicate } from "./segments";
import { assertTopic, topicMembershipSql } from "./topics";

const emailSchema = z.string().trim().pipe(z.email()).pipe(z.string().max(320));
// "" clears the field — stored as null, never as an empty string.
const personName = z.string().trim().max(200);
// Resend-style custom fields: a flat map of string→string. Non-string
// values are rejected at the boundary.
const propertiesSchema = z.record(z.string(), z.string());

/** Guards contact-keyed procedures: NOT_FOUND outside the team. */
async function assertContact(ctx: { db: Db; teamId: string }, contactId: string): Promise<void> {
  const c = schema.contacts;
  const [row] = await ctx.db
    .select({ id: c.id })
    .from(c)
    .where(and(eq(c.id, contactId), eq(c.teamId, ctx.teamId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
}

// Bulk selection ceiling: the contacts table's client batches larger
// selections into sequential calls of this size.
const bulkContactIds = z.array(z.uuid()).min(1).max(100);

/**
 * Guards bulk procedures: EVERY id must be one of the team's contacts —
 * NOT_FOUND before any write when even one is foreign. Returns the deduped
 * ids the writes below fan out over.
 */
async function assertContacts(
  ctx: { db: Db; teamId: string },
  contactIds: string[],
): Promise<string[]> {
  const unique = [...new Set(contactIds)];
  const c = schema.contacts;
  const [row] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(c)
    .where(and(inArray(c.id, unique), eq(c.teamId, ctx.teamId)));
  if ((row?.count ?? 0) !== unique.length) throw new TRPCError({ code: "NOT_FOUND" });
  return unique;
}

export const audienceRouter = router({
  contacts: router({
    /** The stat strip's three counts over the team's contact base. */
    stats: teamProcedure.query(async ({ ctx }) => {
      const c = schema.contacts;
      const [row] = await ctx.db
        .select({
          contacts: sql<number>`count(*)::int`,
          unsubscribed: sql<number>`count(*) filter (where ${c.unsubscribed})::int`,
        })
        .from(c)
        .where(eq(c.teamId, ctx.teamId));
      return row ?? { contacts: 0, unsubscribed: 0 };
    }),

    /**
     * Daily additions and unsubscribes for the contacts-page growth chart.
     * Unsubscribe days come from unsubscribed_at, so rows unsubscribed before
     * that column existed carry their backfilled (approximate) time.
     */
    growth: teamProcedure.query(async ({ ctx }) => {
      const c = schema.contacts;
      const added = await ctx.db
        .select({
          day: sql<string>`(${c.createdAt} at time zone 'utc')::date::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(c)
        .where(eq(c.teamId, ctx.teamId))
        .groupBy(sql`1`)
        .orderBy(sql`1`);
      const unsubscribed = await ctx.db
        .select({
          day: sql<string>`(${c.unsubscribedAt} at time zone 'utc')::date::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(c)
        .where(and(eq(c.teamId, ctx.teamId), eq(c.unsubscribed, true), isNotNull(c.unsubscribedAt)))
        .groupBy(sql`1`)
        .orderBy(sql`1`);
      return { added, unsubscribed };
    }),
    list: teamProcedure
      .input(
        z.object({
          search: z.string().trim().max(200).optional(),
          segmentId: z.uuid().optional(),
          topicId: z.uuid().optional(),
          cursor: cursorSchema.optional(),
          limit: z.number().int().min(1).max(50).default(25),
        }),
      )
      .query(async ({ ctx, input }) => {
        const t = schema.contacts;
        const filters: (SQL | undefined)[] = [eq(t.teamId, ctx.teamId)];
        if (input.search) {
          const pattern = `%${escapeLike(input.search)}%`;
          filters.push(
            or(ilike(t.email, pattern), ilike(t.firstName, pattern), ilike(t.lastName, pattern)),
          );
        }
        // Segment filter AND's the ONE core translator's predicate; a foreign
        // segment is rejected before it can widen the scope.
        if (input.segmentId) {
          const segment = await assertSegment(ctx, input.segmentId);
          // undefined = empty filter (all contacts); nothing to AND in then.
          const predicate = segmentPredicate(segment.filter);
          if (predicate) filters.push(predicate);
        }
        // Topic filter reuses the ONE membership rule via a correlated EXISTS,
        // keeping the keyset query flat so the cursor still works.
        if (input.topicId) {
          await assertTopic(ctx, input.topicId);
          const tp = schema.topics;
          const s = schema.contactTopicSubscriptions;
          filters.push(
            sql`exists (select 1 from ${tp} left join ${s} on ${and(
              eq(s.topicId, tp.id),
              eq(s.contactId, t.id),
            )} where ${and(eq(tp.id, input.topicId), topicMembershipSql(s, tp))})`,
          );
        }
        // Total counts the filter scope, not the page — the cursor is excluded.
        const [totalRow] = await ctx.db
          .select({ total: sql<number>`count(*)::int` })
          .from(t)
          .where(and(...filters));
        if (input.cursor) filters.push(beforeCursor(t, input.cursor));
        const rows = await ctx.db
          .select({
            id: t.id,
            email: t.email,
            firstName: t.firstName,
            lastName: t.lastName,
            unsubscribed: t.unsubscribed,
            createdAt: t.createdAt,
            cursorCreatedAt: createdAtCursorField(t),
          })
          .from(t)
          .where(and(...filters))
          .orderBy(desc(t.createdAt), desc(t.id))
          .limit(input.limit + 1);
        const page = paginate(rows, input.limit);
        // Opted-in topic names for the page's rows in ONE grouped query (the
        // status badge's count + tooltip), reusing the shared membership rule.
        const topicsByContact = new Map<string, string[]>();
        if (page.items.length > 0) {
          const tp = schema.topics;
          const s = schema.contactTopicSubscriptions;
          const memberships = await ctx.db
            .select({ contactId: t.id, name: tp.name })
            .from(t)
            .innerJoin(tp, eq(tp.teamId, ctx.teamId))
            .leftJoin(s, and(eq(s.topicId, tp.id), eq(s.contactId, t.id)))
            .where(
              and(
                inArray(
                  t.id,
                  page.items.map((r) => r.id),
                ),
                topicMembershipSql(s, tp),
              ),
            )
            .orderBy(asc(tp.name));
          for (const m of memberships) {
            const names = topicsByContact.get(m.contactId);
            if (names) names.push(m.name);
            else topicsByContact.set(m.contactId, [m.name]);
          }
        }
        // Manual segment names for the page's rows in ONE grouped query
        // (segment_members only — filter matches are not memberships).
        const segmentsByContact = new Map<string, string[]>();
        if (page.items.length > 0) {
          const m = schema.segmentMembers;
          const s = schema.segments;
          const memberships = await ctx.db
            .select({ contactId: m.contactId, name: s.name })
            .from(m)
            .innerJoin(s, eq(s.id, m.segmentId))
            .where(
              and(
                inArray(
                  m.contactId,
                  page.items.map((r) => r.id),
                ),
                eq(s.teamId, ctx.teamId),
              ),
            )
            .orderBy(asc(s.name));
          for (const row of memberships) {
            const names = segmentsByContact.get(row.contactId);
            if (names) names.push(row.name);
            else segmentsByContact.set(row.contactId, [row.name]);
          }
        }
        return {
          items: page.items.map((r) => ({
            ...r,
            topics: topicsByContact.get(r.id) ?? [],
            segments: segmentsByContact.get(r.id) ?? [],
          })),
          nextCursor: page.nextCursor,
          total: totalRow?.total ?? 0,
        };
      }),

    get: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
      const t = schema.contacts;
      const [row] = await ctx.db
        .select({
          id: t.id,
          email: t.email,
          firstName: t.firstName,
          lastName: t.lastName,
          unsubscribed: t.unsubscribed,
          properties: t.properties,
          createdAt: t.createdAt,
        })
        .from(t)
        .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return row;
    }),

    add: teamProcedure
      .input(
        z.object({
          email: emailSchema,
          firstName: personName.optional(),
          lastName: personName.optional(),
          properties: propertiesSchema.optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const t = schema.contacts;
        const [row] = await ctx.db
          .insert(t)
          .values({
            teamId: ctx.teamId,
            email: input.email,
            firstName: input.firstName || null,
            lastName: input.lastName || null,
            ...(input.properties !== undefined ? { properties: input.properties } : {}),
          })
          .onConflictDoNothing()
          .returning({ id: t.id });
        // Conflict = the team already has this address (case-insensitive).
        if (!row) throw new TRPCError({ code: "CONFLICT" });
        await recordContactActivity(ctx.db, {
          teamId: ctx.teamId,
          contactId: row.id,
          type: "contact_created",
        });
        return { id: row.id };
      }),

    /**
     * CSV import path. Rows with invalid addresses, batch-internal
     * duplicates, or addresses the team already has count as skipped —
     * one bad CSV line must not reject the batch.
     */
    addMany: teamProcedure
      .input(
        z.object({
          rows: z
            .array(
              z.object({
                email: z.string().trim().max(320),
                firstName: personName.optional(),
                lastName: personName.optional(),
              }),
            )
            .min(1)
            .max(1000),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const t = schema.contacts;
        let skipped = 0;
        const seen = new Set<string>();
        const valid: { email: string; firstName: string | null; lastName: string | null }[] = [];
        for (const row of input.rows) {
          const key = row.email.toLowerCase();
          if (!emailSchema.safeParse(row.email).success || seen.has(key)) {
            skipped++;
            continue;
          }
          seen.add(key);
          valid.push({
            email: row.email,
            firstName: row.firstName || null,
            lastName: row.lastName || null,
          });
        }
        if (valid.length === 0) return { created: 0, skipped };
        // ON CONFLICT, not a pre-SELECT: a concurrent import racing the same
        // address must count as skipped, never abort the batch on the unique
        // violation. Targetless is exact here — the only conflict a generated
        // uuid pkey leaves possible is the case-insensitive (teamId,
        // lower(email)) index. `returning` yields only the rows actually
        // inserted, so created/skipped stay exact.
        const inserted = await ctx.db
          .insert(t)
          .values(valid.map((v) => ({ ...v, teamId: ctx.teamId })))
          .onConflictDoNothing()
          .returning({ id: t.id });
        await recordContactActivity(
          ctx.db,
          inserted.map((r) => ({
            teamId: ctx.teamId,
            contactId: r.id,
            type: "contact_created" as const,
          })),
        );
        return { created: inserted.length, skipped: skipped + valid.length - inserted.length };
      }),

    update: teamProcedure
      .input(
        z.object({
          id: z.uuid(),
          firstName: personName.optional(),
          lastName: personName.optional(),
          unsubscribed: z.boolean().optional(),
          properties: propertiesSchema.optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const t = schema.contacts;
        // Read the flag before writing so the timeline records only real
        // flips — an update restating the current state stays silent.
        const [before] =
          input.unsubscribed === undefined
            ? []
            : await ctx.db
                .select({ unsubscribed: t.unsubscribed })
                .from(t)
                .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)));
        // properties REPLACES the whole map when provided (not a merge);
        // omitting it leaves the stored map unchanged.
        const [row] = await ctx.db
          .update(t)
          .set({
            ...(input.firstName !== undefined ? { firstName: input.firstName || null } : {}),
            ...(input.lastName !== undefined ? { lastName: input.lastName || null } : {}),
            ...(input.unsubscribed !== undefined
              ? {
                  unsubscribed: input.unsubscribed,
                  unsubscribedAt: input.unsubscribed ? new Date() : null,
                }
              : {}),
            ...(input.properties !== undefined ? { properties: input.properties } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
          .returning({ id: t.id, unsubscribed: t.unsubscribed });
        if (!row) throw new TRPCError({ code: "NOT_FOUND" });
        if (before && before.unsubscribed !== row.unsubscribed) {
          await recordContactActivity(ctx.db, {
            teamId: ctx.teamId,
            contactId: row.id,
            type: row.unsubscribed ? "unsubscribed" : "resubscribed",
          });
        }
        return row;
      }),

    delete: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
      const t = schema.contacts;
      const [row] = await ctx.db
        .delete(t)
        .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
        .returning({ id: t.id });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return { id: row.id };
    }),

    /** Bulk join: every selected contact into every chosen segment, in one
     * insert. onConflictDoNothing + returning = only REAL joins come back, so
     * the timeline never records a re-add. */
    bulkAddSegments: teamProcedure
      .input(z.object({ contactIds: bulkContactIds, segmentIds: z.array(z.uuid()).min(1).max(50) }))
      .mutation(async ({ ctx, input }) => {
        const contactIds = await assertContacts(ctx, input.contactIds);
        const segments = await Promise.all(
          [...new Set(input.segmentIds)].map((id) => assertSegment(ctx, id)),
        );
        const m = schema.segmentMembers;
        const inserted = await ctx.db
          .insert(m)
          .values(
            segments.flatMap((segment) =>
              contactIds.map((contactId) => ({ segmentId: segment.id, contactId })),
            ),
          )
          .onConflictDoNothing()
          .returning({ segmentId: m.segmentId, contactId: m.contactId });
        const names = new Map(segments.map((segment) => [segment.id, segment.name]));
        await recordContactActivity(
          ctx.db,
          inserted.map((row) => ({
            teamId: ctx.teamId,
            contactId: row.contactId,
            type: "segment_added" as const,
            data: { segmentId: row.segmentId, name: names.get(row.segmentId) ?? null },
          })),
        );
        return { added: inserted.length };
      }),

    /** Bulk leave: one delete; returning = only real leaves hit the timeline. */
    bulkRemoveSegment: teamProcedure
      .input(z.object({ contactIds: bulkContactIds, segmentId: z.uuid() }))
      .mutation(async ({ ctx, input }) => {
        const contactIds = await assertContacts(ctx, input.contactIds);
        const segment = await assertSegment(ctx, input.segmentId);
        const m = schema.segmentMembers;
        const removed = await ctx.db
          .delete(m)
          .where(and(eq(m.segmentId, segment.id), inArray(m.contactId, contactIds)))
          .returning({ contactId: m.contactId });
        await recordContactActivity(
          ctx.db,
          removed.map((row) => ({
            teamId: ctx.teamId,
            contactId: row.contactId,
            type: "segment_removed" as const,
            data: { segmentId: segment.id, name: segment.name },
          })),
        );
        return { removed: removed.length };
      }),

    /**
     * Bulk opt-in. Same effective-state rule as setTopic: prior state is the
     * explicit row when one exists, else the topic's defaultSubscribed; every
     * pair gets its explicit row upserted, but the timeline records only real
     * transitions to subscribed.
     */
    bulkSubscribeTopics: teamProcedure
      .input(z.object({ contactIds: bulkContactIds, topicIds: z.array(z.uuid()).min(1).max(50) }))
      .mutation(async ({ ctx, input }) => {
        const contactIds = await assertContacts(ctx, input.contactIds);
        const topics = await Promise.all(
          [...new Set(input.topicIds)].map((id) => assertTopic(ctx, id)),
        );
        const s = schema.contactTopicSubscriptions;
        const prior = new Map(
          (
            await ctx.db
              .select({ contactId: s.contactId, topicId: s.topicId, subscribed: s.subscribed })
              .from(s)
              .where(
                and(
                  inArray(s.contactId, contactIds),
                  inArray(
                    s.topicId,
                    topics.map((topic) => topic.id),
                  ),
                ),
              )
          ).map((row) => [`${row.contactId}:${row.topicId}`, row.subscribed]),
        );
        await ctx.db
          .insert(s)
          .values(
            topics.flatMap((topic) =>
              contactIds.map((contactId) => ({ contactId, topicId: topic.id, subscribed: true })),
            ),
          )
          .onConflictDoUpdate({
            target: [s.contactId, s.topicId],
            set: { subscribed: true, updatedAt: new Date() },
          });
        const changed = topics.flatMap((topic) =>
          contactIds
            .filter(
              (contactId) =>
                (prior.get(`${contactId}:${topic.id}`) ?? topic.defaultSubscribed) !== true,
            )
            .map((contactId) => ({
              teamId: ctx.teamId,
              contactId,
              type: "topic_opt_in" as const,
              data: { topicId: topic.id, name: topic.name },
            })),
        );
        await recordContactActivity(ctx.db, changed);
        return { optedIn: changed.length };
      }),

    /** Bulk delete. No timeline rows: the contacts' activities cascade away
     * with them. Ownership is asserted up front so a foreign id rejects the
     * whole batch before any row is gone. */
    bulkDelete: teamProcedure
      .input(z.object({ contactIds: bulkContactIds }))
      .mutation(async ({ ctx, input }) => {
        const contactIds = await assertContacts(ctx, input.contactIds);
        const t = schema.contacts;
        const deleted = await ctx.db
          .delete(t)
          .where(and(inArray(t.id, contactIds), eq(t.teamId, ctx.teamId)))
          .returning({ id: t.id });
        return { deleted: deleted.length };
      }),

    /**
     * The team's topics, each with this contact's EFFECTIVE subscribe state:
     * the explicit subscription row when one exists, else the topic's
     * defaultSubscribed. Absence of a row is not "unsubscribed" — it is the
     * default. (Global unsubscribe is a separate contact flag, surfaced
     * elsewhere; it does not change per-topic effective state here.)
     */
    topics: teamProcedure.input(z.object({ contactId: z.uuid() })).query(async ({ ctx, input }) => {
      await assertContact(ctx, input.contactId);
      const t = schema.topics;
      const s = schema.contactTopicSubscriptions;
      return ctx.db
        .select({
          id: t.id,
          name: t.name,
          description: t.description,
          defaultSubscribed: t.defaultSubscribed,
          subscribed: topicMembershipSql(s, t),
        })
        .from(t)
        .leftJoin(s, and(eq(s.topicId, t.id), eq(s.contactId, input.contactId)))
        .where(eq(t.teamId, ctx.teamId))
        .orderBy(desc(t.createdAt), desc(t.id));
    }),

    /** The contact's manual segment memberships (segment_members rows only). */
    segments: teamProcedure
      .input(z.object({ contactId: z.uuid() }))
      .query(async ({ ctx, input }) => {
        await assertContact(ctx, input.contactId);
        const m = schema.segmentMembers;
        const s = schema.segments;
        return ctx.db
          .select({ id: s.id, name: s.name })
          .from(m)
          .innerJoin(s, eq(s.id, m.segmentId))
          .where(and(eq(m.contactId, input.contactId), eq(s.teamId, ctx.teamId)))
          .orderBy(asc(s.name));
      }),

    /** Idempotent manual join: re-adding an existing member is a no-op and
     * the timeline records only first joins. */
    addSegment: teamProcedure
      .input(z.object({ contactId: z.uuid(), segmentId: z.uuid() }))
      .mutation(async ({ ctx, input }) => {
        await assertContact(ctx, input.contactId);
        const segment = await assertSegment(ctx, input.segmentId);
        const m = schema.segmentMembers;
        const [added] = await ctx.db
          .insert(m)
          .values({ segmentId: input.segmentId, contactId: input.contactId })
          .onConflictDoNothing()
          .returning({ contactId: m.contactId });
        if (added) {
          await recordContactActivity(ctx.db, {
            teamId: ctx.teamId,
            contactId: input.contactId,
            type: "segment_added",
            data: { segmentId: segment.id, name: segment.name },
          });
        }
        return { added: added !== undefined };
      }),

    /** Idempotent leave: removing a non-member is a no-op (no timeline row). */
    removeSegment: teamProcedure
      .input(z.object({ contactId: z.uuid(), segmentId: z.uuid() }))
      .mutation(async ({ ctx, input }) => {
        await assertContact(ctx, input.contactId);
        const segment = await assertSegment(ctx, input.segmentId);
        const m = schema.segmentMembers;
        const [removed] = await ctx.db
          .delete(m)
          .where(and(eq(m.segmentId, input.segmentId), eq(m.contactId, input.contactId)))
          .returning({ segmentId: m.segmentId });
        if (removed) {
          await recordContactActivity(ctx.db, {
            teamId: ctx.teamId,
            contactId: input.contactId,
            type: "segment_removed",
            data: { segmentId: segment.id, name: segment.name },
          });
        }
        return { removed: removed !== undefined };
      }),

    /** The contact's activity timeline, newest first. */
    activities: teamProcedure
      .input(z.object({ contactId: z.uuid() }))
      .query(async ({ ctx, input }) => {
        await assertContact(ctx, input.contactId);
        const a = schema.contactActivities;
        return (
          ctx.db
            .select({ id: a.id, type: a.type, data: a.data, createdAt: a.createdAt })
            .from(a)
            .where(and(eq(a.contactId, input.contactId), eq(a.teamId, ctx.teamId)))
            .orderBy(desc(a.createdAt), desc(a.id))
            // ponytail: hard cap, no paging — add a keyset cursor if timelines outgrow it
            .limit(100)
        );
      }),

    /** Upserts the explicit per-topic override for this contact. */
    setTopic: teamProcedure
      .input(z.object({ contactId: z.uuid(), topicId: z.uuid(), subscribed: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        await assertContact(ctx, input.contactId);
        const topic = await assertTopic(ctx, input.topicId);
        const s = schema.contactTopicSubscriptions;
        // Effective state before the write (explicit row, else the topic's
        // default) — the timeline records only real transitions.
        const [prior] = await ctx.db
          .select({ subscribed: s.subscribed })
          .from(s)
          .where(and(eq(s.contactId, input.contactId), eq(s.topicId, input.topicId)))
          .limit(1);
        await ctx.db
          .insert(s)
          .values({
            contactId: input.contactId,
            topicId: input.topicId,
            subscribed: input.subscribed,
          })
          .onConflictDoUpdate({
            target: [s.contactId, s.topicId],
            set: { subscribed: input.subscribed, updatedAt: new Date() },
          });
        if ((prior?.subscribed ?? topic.defaultSubscribed) !== input.subscribed) {
          await recordContactActivity(ctx.db, {
            teamId: ctx.teamId,
            contactId: input.contactId,
            type: input.subscribed ? "topic_opt_in" : "topic_opt_out",
            data: { topicId: topic.id, name: topic.name },
          });
        }
        return { subscribed: input.subscribed };
      }),
  }),

  properties: router({
    /**
     * Distinct custom-property keys in use across the team's contacts, each
     * with how many carry a non-empty value (coverage over totalContacts) and
     * one sample value. Derived from the free-form contacts.properties map —
     * there is no property-definition table. Also the source of truth for the
     * broadcast merge-field variable picker.
     */
    list: teamProcedure.query(async ({ ctx }) => {
      const c = schema.contacts;
      const [totalRow] = await ctx.db
        .select({ total: sql<number>`count(*)::int` })
        .from(c)
        .where(eq(c.teamId, ctx.teamId));
      const totalContacts = totalRow?.total ?? 0;
      // jsonb_each_text expands each contact's map to (key, value) rows; the
      // key is row data, never string-interpolated, so a hostile stored key is
      // returned as data, not executed. A {} map expands to zero rows and thus
      // contributes no key. Sorted by coverage (contactCount) desc.
      const result = await ctx.db.execute(sql`
        select kv.key as key,
               count(*)::int as "contactCount",
               min(kv.value) as "sampleValue"
        from ${c} c
        cross join lateral jsonb_each_text(c.properties) as kv(key, value)
        where c.team_id = ${ctx.teamId} and kv.value <> ''
        group by kv.key
        order by count(*) desc, kv.key asc
      `);
      const rows = resultRows<{ key: string; contactCount: number; sampleValue: string }>(result);
      return rows.map((r) => ({ ...r, totalContacts }));
    }),

    /** The team's typed property DEFINITIONS, newest first. */
    defineList: teamProcedure.query(async ({ ctx }) => {
      const p = schema.contactProperties;
      return ctx.db
        .select({
          id: p.id,
          key: p.key,
          type: p.type,
          fallbackValue: p.fallbackValue,
          createdAt: p.createdAt,
        })
        .from(p)
        .where(eq(p.teamId, ctx.teamId))
        .orderBy(desc(p.createdAt), desc(p.id));
    }),

    /**
     * Declares a typed property. The key is stored verbatim (parameterized, so
     * a hostile string stays data); CONFLICT is the case-insensitive
     * (teamId, lower(key)) unique index. The type is immutable after create
     * (the public API's PATCH only updates fallback_value).
     */
    define: teamProcedure
      .input(
        z
          .object({
            key: z.string().trim().min(1).max(200),
            type: z.enum(["string", "number"]).default("string"),
            fallbackValue: z.string().max(1000).optional(),
          })
          // A number property's fallback must read back as a finite number —
          // it is stored as text and coerced per type at the wire.
          .refine(
            (v) =>
              v.type !== "number" ||
              v.fallbackValue === undefined ||
              (v.fallbackValue.trim() !== "" && Number.isFinite(Number(v.fallbackValue))),
            { message: "fallbackValue must be a number" },
          ),
      )
      .mutation(async ({ ctx, input }) => {
        const p = schema.contactProperties;
        const [row] = await ctx.db
          .insert(p)
          .values({
            teamId: ctx.teamId,
            key: input.key,
            type: input.type,
            ...(input.fallbackValue !== undefined ? { fallbackValue: input.fallbackValue } : {}),
          })
          .onConflictDoNothing()
          .returning({ id: p.id });
        if (!row) throw new TRPCError({ code: "CONFLICT" });
        return { id: row.id };
      }),

    remove: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
      const p = schema.contactProperties;
      const [row] = await ctx.db
        .delete(p)
        .where(and(eq(p.id, input.id), eq(p.teamId, ctx.teamId)))
        .returning({ id: p.id });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return { id: row.id };
    }),
  }),
});
