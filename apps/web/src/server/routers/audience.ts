import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, ilike, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { escapeLike } from "@/lib/sql";
import { beforeCursor, createdAtCursorField, cursorSchema, paginate } from "../keyset";
import { router, teamProcedure } from "../trpc";

const emailSchema = z.string().trim().pipe(z.email()).pipe(z.string().max(320));
// "" clears the field — stored as null, never as an empty string.
const personName = z.string().trim().max(200);

/** Guards every procedure keyed by audienceId (contacts, broadcasts): NOT_FOUND outside the team. */
export async function assertAudience(
  ctx: { db: Db; teamId: string },
  audienceId: string,
): Promise<void> {
  const a = schema.audiences;
  const [row] = await ctx.db
    .select({ id: a.id })
    .from(a)
    .where(and(eq(a.id, audienceId), eq(a.teamId, ctx.teamId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
}

export const audienceRouter = router({
  audiences: router({
    list: teamProcedure.query(async ({ ctx }) => {
      const a = schema.audiences;
      const c = schema.contacts;
      return ctx.db
        .select({
          id: a.id,
          name: a.name,
          createdAt: a.createdAt,
          contacts: sql<number>`count(${c.id})::int`,
          unsubscribed: sql<number>`count(${c.id}) filter (where ${c.unsubscribed})::int`,
        })
        .from(a)
        .leftJoin(c, eq(c.audienceId, a.id))
        .where(eq(a.teamId, ctx.teamId))
        .groupBy(a.id)
        .orderBy(desc(a.createdAt), desc(a.id));
    }),

    /** Contacts-surface header: name + the stat strip's three counts. */
    get: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
      const a = schema.audiences;
      const c = schema.contacts;
      const [row] = await ctx.db
        .select({
          id: a.id,
          name: a.name,
          createdAt: a.createdAt,
          contacts: sql<number>`count(${c.id})::int`,
          unsubscribed: sql<number>`count(${c.id}) filter (where ${c.unsubscribed})::int`,
        })
        .from(a)
        .leftJoin(c, eq(c.audienceId, a.id))
        .where(and(eq(a.id, input.id), eq(a.teamId, ctx.teamId)))
        .groupBy(a.id)
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return row;
    }),

    create: teamProcedure
      .input(z.object({ name: z.string().trim().min(1).max(200) }))
      .mutation(async ({ ctx, input }) => {
        const a = schema.audiences;
        const [row] = await ctx.db
          .insert(a)
          .values({ teamId: ctx.teamId, name: input.name })
          .returning({ id: a.id });
        if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        return { id: row.id };
      }),

    delete: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
      const a = schema.audiences;
      const [row] = await ctx.db
        .delete(a)
        .where(and(eq(a.id, input.id), eq(a.teamId, ctx.teamId)))
        .returning({ id: a.id });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return { id: row.id };
    }),
  }),

  contacts: router({
    list: teamProcedure
      .input(
        z.object({
          audienceId: z.uuid(),
          search: z.string().trim().max(200).optional(),
          cursor: cursorSchema.optional(),
          limit: z.number().int().min(1).max(50).default(25),
        }),
      )
      .query(async ({ ctx, input }) => {
        await assertAudience(ctx, input.audienceId);
        const t = schema.contacts;
        const filters: (SQL | undefined)[] = [
          eq(t.teamId, ctx.teamId),
          eq(t.audienceId, input.audienceId),
        ];
        if (input.search) {
          const pattern = `%${escapeLike(input.search)}%`;
          filters.push(
            or(ilike(t.email, pattern), ilike(t.firstName, pattern), ilike(t.lastName, pattern)),
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
        return { ...paginate(rows, input.limit), total: totalRow?.total ?? 0 };
      }),

    get: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
      const t = schema.contacts;
      const a = schema.audiences;
      const [row] = await ctx.db
        .select({
          id: t.id,
          audienceId: t.audienceId,
          audienceName: a.name,
          email: t.email,
          firstName: t.firstName,
          lastName: t.lastName,
          unsubscribed: t.unsubscribed,
          createdAt: t.createdAt,
        })
        .from(t)
        .innerJoin(a, eq(a.id, t.audienceId))
        .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return row;
    }),

    add: teamProcedure
      .input(
        z.object({
          audienceId: z.uuid(),
          email: emailSchema,
          firstName: personName.optional(),
          lastName: personName.optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await assertAudience(ctx, input.audienceId);
        const t = schema.contacts;
        const [row] = await ctx.db
          .insert(t)
          .values({
            teamId: ctx.teamId,
            audienceId: input.audienceId,
            email: input.email,
            firstName: input.firstName || null,
            lastName: input.lastName || null,
          })
          .onConflictDoNothing()
          .returning({ id: t.id });
        // Conflict = already in this audience (case-insensitive unique index).
        if (!row) throw new TRPCError({ code: "CONFLICT" });
        return { id: row.id };
      }),

    /**
     * CSV import path. Rows with invalid addresses, batch-internal
     * duplicates, or addresses already in the audience count as skipped —
     * one bad CSV line must not reject the batch.
     */
    addMany: teamProcedure
      .input(
        z.object({
          audienceId: z.uuid(),
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
        await assertAudience(ctx, input.audienceId);
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
        // uuid pkey leaves possible is the case-insensitive (audienceId,
        // lower(email)) index. `returning` yields only the rows actually
        // inserted, so created/skipped stay exact.
        const inserted = await ctx.db
          .insert(t)
          .values(valid.map((v) => ({ ...v, teamId: ctx.teamId, audienceId: input.audienceId })))
          .onConflictDoNothing()
          .returning({ id: t.id });
        return { created: inserted.length, skipped: skipped + valid.length - inserted.length };
      }),

    update: teamProcedure
      .input(
        z.object({
          id: z.uuid(),
          firstName: personName.optional(),
          lastName: personName.optional(),
          unsubscribed: z.boolean().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const t = schema.contacts;
        const [row] = await ctx.db
          .update(t)
          .set({
            ...(input.firstName !== undefined ? { firstName: input.firstName || null } : {}),
            ...(input.lastName !== undefined ? { lastName: input.lastName || null } : {}),
            ...(input.unsubscribed !== undefined ? { unsubscribed: input.unsubscribed } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
          .returning({ id: t.id, unsubscribed: t.unsubscribed });
        if (!row) throw new TRPCError({ code: "NOT_FOUND" });
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
  }),
});
