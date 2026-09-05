import {
  recountSegment,
  SEGMENT_FILTER_MAX_CONDITIONS,
  SEGMENT_FILTER_VALUE_MAX_LENGTH,
  segmentContactsWhere,
  segmentWhere,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { isForeignKeyViolation } from "../db-errors";
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
  conditions: z
    .array(
      z.object({
        field: z.string(),
        op: z.string(),
        value: z.string().max(SEGMENT_FILTER_VALUE_MAX_LENGTH).nullable(),
      }),
    )
    .max(SEGMENT_FILTER_MAX_CONDITIONS),
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

/** Maps the core validator's throw to a 422; caught by error name (not the
 * class) so it holds even if two copies of core ever load. */
function surfacing422<T>(build: () => T): T {
  try {
    return build();
  } catch (err) {
    if (err instanceof Error && err.name === "SegmentFilterError") {
      throw new TRPCError({ code: "UNPROCESSABLE_CONTENT", message: err.message });
    }
    throw err;
  }
}

/** The shared translator's SQL predicate for a bare (unsaved) `filter`. */
export function segmentPredicate(filter: SegmentFilter) {
  return surfacing422(() => segmentWhere(schema.contacts, filter));
}

/**
 * The shared resolver's predicate for a SAVED segment: filter matches (when a
 * filter is set) plus manual segment_members rows. Null-filter segments
 * resolve to their members only.
 */
export function savedSegmentPredicate(segment: { id: string; filter: SegmentFilter }) {
  return surfacing422(() => segmentContactsWhere(schema.contacts, segment));
}

/** Live count of the team's contacts matching a filter (builder preview). */
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
  /**
   * Counts come from the stored columns (refreshed by recountSegment on
   * create/update/get and by the stale-segment cron), never live: four
   * screens load this list and a live count is one contacts scan per segment.
   * contactCount/countedAt are null for a segment never counted yet.
   */
  list: teamProcedure.query(({ ctx }) => {
    const s = schema.segments;
    return ctx.db
      .select({
        id: s.id,
        name: s.name,
        filter: s.filter,
        createdAt: s.createdAt,
        contactCount: s.contactCount,
        unsubscribedCount: s.unsubscribedCount,
        countedAt: s.countedAt,
      })
      .from(s)
      .where(eq(s.teamId, ctx.teamId))
      .orderBy(desc(s.createdAt), desc(s.id));
  }),

  /** Live counts; the same scan also refreshes the stored columns the list reads. */
  get: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const row = await assertSegment(ctx, input.id);
    const counts = await recountSegment(ctx.db, row).catch((err: unknown) =>
      surfacing422(() => {
        throw err;
      }),
    );
    return { ...row, ...counts };
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
        .returning({ id: s.id, teamId: s.teamId, filter: s.filter });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await recountSegment(ctx.db, row);
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
      const [row] = await ctx.db
        .update(s)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.filter !== undefined ? { filter: input.filter } : {}),
        })
        .where(and(eq(s.id, input.id), eq(s.teamId, ctx.teamId)))
        .returning({ id: s.id, teamId: s.teamId, filter: s.filter });
      // A rename leaves the membership untouched; only a filter change recounts.
      if (row && input.filter !== undefined) await recountSegment(ctx.db, row);
      return { id: input.id };
    }),

  delete: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const s = schema.segments;
    let row: { id: string } | undefined;
    try {
      [row] = await ctx.db
        .delete(s)
        .where(and(eq(s.id, input.id), eq(s.teamId, ctx.teamId)))
        .returning({ id: s.id });
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This segment is referenced by a broadcast and cannot be deleted.",
        });
      }
      throw error;
    }
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
