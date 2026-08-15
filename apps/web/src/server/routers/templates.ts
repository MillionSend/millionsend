import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { blockDocSchema } from "@/lib/email-blocks/model";
import { beforeCursor, createdAtCursorField, cursorSchema, paginate } from "../keyset";
import { router, teamProcedure } from "../trpc";

const nameSchema = z.string().trim().min(1).max(200);
// "" clears the field — stored as null, never as an empty string.
const subjectSchema = z.string().trim().max(998);
const bodySchema = z.string().max(500_000);
// Block-editor source of truth; null clears it back to a legacy raw-HTML row.
const documentSchema = blockDocSchema.nullable();

type TemplateRow = typeof schema.templates.$inferSelect;

async function getOwnTemplate(ctx: { db: Db; teamId: string }, id: string): Promise<TemplateRow> {
  const t = schema.templates;
  const [row] = await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.id, id), eq(t.teamId, ctx.teamId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  return row;
}

export const templatesRouter = router({
  list: teamProcedure
    .input(
      z.object({
        cursor: cursorSchema.optional(),
        limit: z.number().int().min(1).max(50).default(25),
      }),
    )
    .query(async ({ ctx, input }) => {
      const t = schema.templates;
      // Templates page on (updatedAt desc, id desc): a template you just
      // edited surfaces first. The keyset helpers are column-agnostic, so
      // updatedAt rides in their createdAt slot.
      const keys = { createdAt: t.updatedAt, id: t.id };
      const filters = [eq(t.teamId, ctx.teamId)];
      if (input.cursor) {
        const cursorFilter = beforeCursor(keys, input.cursor);
        if (cursorFilter) filters.push(cursorFilter);
      }
      const rows = await ctx.db
        .select({
          id: t.id,
          name: t.name,
          updatedAt: t.updatedAt,
          cursorCreatedAt: createdAtCursorField(keys),
        })
        .from(t)
        .where(and(...filters))
        .orderBy(desc(t.updatedAt), desc(t.id))
        .limit(input.limit + 1);
      return paginate(rows, input.limit);
    }),

  get: teamProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => getOwnTemplate(ctx, input.id)),

  create: teamProcedure
    .input(
      z.object({
        name: nameSchema,
        subject: subjectSchema.optional(),
        html: bodySchema.min(1),
        text: bodySchema.optional(),
        document: documentSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const t = schema.templates;
      const [row] = await ctx.db
        .insert(t)
        .values({
          teamId: ctx.teamId,
          name: input.name,
          subject: input.subject || null,
          html: input.html,
          text: input.text || null,
          document: input.document ?? null,
        })
        .returning({ id: t.id });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return { id: row.id };
    }),

  update: teamProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: nameSchema.optional(),
        subject: subjectSchema.optional(),
        html: bodySchema.min(1).optional(),
        text: bodySchema.optional(),
        document: documentSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await getOwnTemplate(ctx, input.id);
      const t = schema.templates;
      await ctx.db
        .update(t)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.subject !== undefined ? { subject: input.subject || null } : {}),
          ...(input.html !== undefined ? { html: input.html } : {}),
          ...(input.text !== undefined ? { text: input.text || null } : {}),
          ...(input.document !== undefined ? { document: input.document } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)));
      return { id: input.id };
    }),

  delete: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await getOwnTemplate(ctx, input.id);
    const t = schema.templates;
    await ctx.db.delete(t).where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)));
    return { id: input.id };
  }),

  duplicate: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const source = await getOwnTemplate(ctx, input.id);
    const t = schema.templates;
    const [row] = await ctx.db
      .insert(t)
      .values({
        teamId: ctx.teamId,
        name: `${source.name} (copy)`,
        subject: source.subject,
        html: source.html,
        text: source.text,
        document: source.document,
      })
      .returning({ id: t.id });
    if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    return { id: row.id };
  }),
});
