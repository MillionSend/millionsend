import { segmentWhere } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { router, teamProcedure } from "../trpc";

const nameSchema = z.string().trim().min(1).max(200);

// The type the core translator and the segments.filter column agree on.
type SegmentFilter = (typeof schema.segments.$inferSelect)["filter"];
type SegmentRow = typeof schema.segments.$inferSelect;

/**
 * Structural filter shape only. The authoritative field/operator validation
 * lives in the core translator (segmentFilterSchema, invoked by segmentWhere);
 * keeping the boundary loose lets an unknown field/op reach segmentWhere and
 * surface as 422 rather than a generic input error.
 */
const filterInputSchema = z.object({
  match: z.enum(["all", "any"]),
  conditions: z.array(
    z.object({ field: z.string(), op: z.string(), value: z.string().nullable() }),
  ),
});

/** Guards a segmentId belongs to the caller's team; returns the row. */
export async function assertSegment(
  ctx: { db: Db; teamId: string },
  id: string,
): Promise<SegmentRow> {
  const s = schema.segments;
  const [row] = await ctx.db
    .select()
    .from(s)
    .where(and(eq(s.id, id), eq(s.teamId, ctx.teamId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  return row;
}

/**
 * The shared translator's SQL predicate for `filter`. The core validator throws
 * on an unknown field/op — surfaced here as 422. Caught by error name (not the
 * class) so it holds even if two copies of core ever load. Returns undefined for
 * an empty condition set (matches everyone) — safe to `and(...)` in.
 */
export function segmentPredicate(filter: SegmentFilter) {
  try {
    return segmentWhere(schema.contacts, filter);
  } catch (err) {
    if (err instanceof Error && err.name === "SegmentFilterError") {
      throw new TRPCError({ code: "UNPROCESSABLE_CONTENT", message: err.message });
    }
    throw err;
  }
}

/** Live count of the team's contacts matching a filter. */
export async function countMatching(
  ctx: { db: Db; teamId: string },
  filter: SegmentFilter,
): Promise<number> {
  const c = schema.contacts;
  const [row] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(c)
    .where(and(eq(c.teamId, ctx.teamId), segmentPredicate(filter)));
  return row?.count ?? 0;
}

export const segmentsRouter = router({
  list: teamProcedure.query(async ({ ctx }) => {
    const s = schema.segments;
    const rows = await ctx.db
      .select({
        id: s.id,
        name: s.name,
        filter: s.filter,
        createdAt: s.createdAt,
      })
      .from(s)
      .where(eq(s.teamId, ctx.teamId))
      .orderBy(desc(s.createdAt), desc(s.id));
    // Live count reuses the shared translator per row. Segments are few per
    // team, so a per-row aggregate beats materializing membership.
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        count: await countMatching(ctx, row.filter),
      })),
    );
  }),

  get: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const row = await assertSegment(ctx, input.id);
    return { ...row, count: await countMatching(ctx, row.filter) };
  }),

  create: teamProcedure
    .input(z.object({ name: nameSchema, filter: filterInputSchema }))
    .mutation(async ({ ctx, input }) => {
      // Validate the filter through the core translator before storing so a bad
      // field/op is rejected (422) now, not when a later count reads it back.
      segmentPredicate(input.filter);
      const s = schema.segments;
      const [row] = await ctx.db
        .insert(s)
        .values({ teamId: ctx.teamId, name: input.name, filter: input.filter })
        .returning({ id: s.id });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return { id: row.id };
    }),

  update: teamProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: nameSchema.optional(),
        filter: filterInputSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertSegment(ctx, input.id);
      if (input.filter !== undefined) segmentPredicate(input.filter);
      const s = schema.segments;
      await ctx.db
        .update(s)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.filter !== undefined ? { filter: input.filter } : {}),
        })
        .where(and(eq(s.id, input.id), eq(s.teamId, ctx.teamId)));
      return { id: input.id };
    }),

  delete: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const s = schema.segments;
    const [row] = await ctx.db
      .delete(s)
      .where(and(eq(s.id, input.id), eq(s.teamId, ctx.teamId)))
      .returning({ id: s.id });
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    return { id: row.id };
  }),

  /** Live preview for the builder: contacts matching the filter, debounced by the UI. */
  count: teamProcedure
    .input(z.object({ filter: filterInputSchema }))
    .query(async ({ ctx, input }) => {
      return { count: await countMatching(ctx, input.filter) };
    }),
});
