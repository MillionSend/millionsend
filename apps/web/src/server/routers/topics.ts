import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
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
export async function assertTopic(ctx: { db: Db; teamId: string }, topicId: string): Promise<void> {
  const t = schema.topics;
  const [row] = await ctx.db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.id, topicId), eq(t.teamId, ctx.teamId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
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
        createdAt: t.createdAt,
      })
      .from(t)
      .where(eq(t.teamId, ctx.teamId))
      .orderBy(desc(t.createdAt), desc(t.id));
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
        })
        .returning({ id: t.id });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return { id: row.id };
    }),

  delete: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const t = schema.topics;
    const [row] = await ctx.db
      .delete(t)
      .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
      .returning({ id: t.id });
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    return { id: row.id };
  }),
});
