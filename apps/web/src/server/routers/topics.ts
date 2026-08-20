import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, not, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { isForeignKeyViolation } from "../db-errors";
import { beforeCursor, createdAtCursorField, cursorSchema, paginate } from "../keyset";
import { router, teamProcedure } from "../trpc";

/**
 * SUBSCRIPTION RULE (topic-membership half): a contact is subscribed to a
 * topic when its explicit subscription row says so, and otherwise falls back
 * to the topic's defaultSubscribed. Callers gating delivery AND this with
 * `NOT contact.unsubscribed`. Defined once here and reused by the
 * contact-detail effective-state read and the topic-scoped recipient count so
 * the two never drift from the worker's fan-out filter.
 */
export function topicMembershipSql(
  sub: typeof schema.contactTopicSubscriptions,
  topic: typeof schema.topics,
): SQL<boolean> {
  return sql<boolean>`coalesce(${sub.subscribed}, ${topic.defaultSubscribed})`;
}

/** Guards a topicId belongs to the caller's team: NOT_FOUND otherwise. */
export async function assertTopic(
  ctx: { db: Db; teamId: string },
  topicId: string,
): Promise<{ id: string; name: string; defaultSubscribed: boolean }> {
  const t = schema.topics;
  const [row] = await ctx.db
    .select({ id: t.id, name: t.name, defaultSubscribed: t.defaultSubscribed })
    .from(t)
    .where(and(eq(t.id, topicId), eq(t.teamId, ctx.teamId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  return row;
}

export const topicsRouter = router({
  list: teamProcedure.query(async ({ ctx }) => {
    const t = schema.topics;
    return ctx.db
      .select({
        id: t.id,
        name: t.name,
        description: t.description,
        defaultSubscribed: t.defaultSubscribed,
        visibility: t.visibility,
        createdAt: t.createdAt,
      })
      .from(t)
      .where(eq(t.teamId, ctx.teamId))
      .orderBy(desc(t.createdAt), desc(t.id));
  }),

  get: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const t = schema.topics;
    const [row] = await ctx.db
      .select({
        id: t.id,
        name: t.name,
        description: t.description,
        defaultSubscribed: t.defaultSubscribed,
        visibility: t.visibility,
        createdAt: t.createdAt,
      })
      .from(t)
      .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
      .limit(1);
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    return row;
  }),

  /**
   * The topic detail page's contact list: every team contact with its
   * EFFECTIVE subscription to this one topic (explicit row, else the topic's
   * default) resolved in the page query itself via the shared membership
   * rule — no per-row lookups. `subscribed` filters on that effective state.
   */
  contacts: teamProcedure
    .input(
      z.object({
        topicId: z.uuid(),
        subscribed: z.boolean().optional(),
        cursor: cursorSchema.optional(),
        limit: z.number().int().min(1).max(50).default(25),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertTopic(ctx, input.topicId);
      const c = schema.contacts;
      const t = schema.topics;
      const s = schema.contactTopicSubscriptions;
      const membership = topicMembershipSql(s, t);
      const filters: (SQL | undefined)[] = [eq(c.teamId, ctx.teamId)];
      if (input.subscribed !== undefined) {
        filters.push(input.subscribed ? membership : not(membership));
      }
      // Total counts the filter scope, not the page — the cursor is excluded.
      const [totalRow] = await ctx.db
        .select({ total: sql<number>`count(*)::int` })
        .from(c)
        .innerJoin(t, eq(t.id, input.topicId))
        .leftJoin(s, and(eq(s.topicId, t.id), eq(s.contactId, c.id)))
        .where(and(...filters));
      if (input.cursor) filters.push(beforeCursor(c, input.cursor));
      const rows = await ctx.db
        .select({
          id: c.id,
          email: c.email,
          firstName: c.firstName,
          lastName: c.lastName,
          subscribed: membership,
          createdAt: c.createdAt,
          cursorCreatedAt: createdAtCursorField(c),
        })
        .from(c)
        .innerJoin(t, eq(t.id, input.topicId))
        .leftJoin(s, and(eq(s.topicId, t.id), eq(s.contactId, c.id)))
        .where(and(...filters))
        .orderBy(desc(c.createdAt), desc(c.id))
        .limit(input.limit + 1);
      const page = paginate(rows, input.limit);
      return { items: page.items, nextCursor: page.nextCursor, total: totalRow?.total ?? 0 };
    }),

  create: teamProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(200),
        // "" clears the field — stored as null, never as an empty string.
        description: z.string().trim().max(1000).optional(),
        // Immutable after creation: opt-in (true) subscribes contacts unless
        // they opt out; opt-out (false) is the inverse. No update path.
        defaultSubscribed: z.boolean(),
        visibility: z.enum(["private", "public"]).default("private"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const t = schema.topics;
      const [row] = await ctx.db
        .insert(t)
        .values({
          teamId: ctx.teamId,
          name: input.name,
          description: input.description || null,
          defaultSubscribed: input.defaultSubscribed,
          visibility: input.visibility,
        })
        .returning({ id: t.id });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return { id: row.id };
    }),

  // defaultSubscribed is deliberately absent: immutable after creation.
  update: teamProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().trim().min(1).max(200),
        // "" clears the field — stored as null, never as an empty string.
        description: z.string().trim().max(1000).optional(),
        visibility: z.enum(["private", "public"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const t = schema.topics;
      const [row] = await ctx.db
        .update(t)
        .set({
          name: input.name,
          description: input.description || null,
          visibility: input.visibility,
        })
        .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
        .returning({ id: t.id });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return { id: row.id };
    }),

  delete: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const t = schema.topics;
    let row: { id: string } | undefined;
    try {
      [row] = await ctx.db
        .delete(t)
        .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
        .returning({ id: t.id });
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This topic is referenced by a broadcast and cannot be deleted.",
        });
      }
      throw error;
    }
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    return { id: row.id };
  }),
});
