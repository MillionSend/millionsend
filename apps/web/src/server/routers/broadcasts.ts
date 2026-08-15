import { env } from "@millionsend/config";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { beforeCursor, createdAtCursorField, cursorSchema, paginate } from "../keyset";
import { router, teamProcedure } from "../trpc";
import { assertAudience } from "./audience";

const emailSchema = z.string().trim().pipe(z.email()).pipe(z.string().max(320));
// Accepts a bare address or a display-name form ("Ada <ada@example.com>");
// the send pipeline validates the address itself.
const fromSchema = z.string().trim().min(1).max(320);
const subjectSchema = z.string().trim().min(1).max(998);
// "" clears the field — stored as null, never as an empty string.
const nameSchema = z.string().trim().max(200);
const bodySchema = z.string().max(500_000);

type BroadcastRow = typeof schema.broadcasts.$inferSelect;

/**
 * The replyTo column holds a JSON-encoded string array (the public API
 * accepts one or many addresses); the dashboard edits a single address, so it
 * stores a one-element array and surfaces the first.
 */
function encodeReplyTo(address: string): string | null {
  return address ? JSON.stringify([address]) : null;
}

function firstReplyTo(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : null;
  } catch {
    return null;
  }
}

async function getOwnBroadcast(ctx: { db: Db; teamId: string }, id: string): Promise<BroadcastRow> {
  const b = schema.broadcasts;
  const [row] = await ctx.db
    .select()
    .from(b)
    .where(and(eq(b.id, id), eq(b.teamId, ctx.teamId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  return row;
}

function assertDraft(row: BroadcastRow): void {
  if (row.status !== "draft") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Only drafts can be changed.",
    });
  }
}

export const broadcastsRouter = router({
  list: teamProcedure
    .input(
      z.object({
        cursor: cursorSchema.optional(),
        limit: z.number().int().min(1).max(50).default(25),
      }),
    )
    .query(async ({ ctx, input }) => {
      const b = schema.broadcasts;
      const a = schema.audiences;
      const e = schema.emails;
      const filters = [eq(b.teamId, ctx.teamId)];
      if (input.cursor) {
        const cursorFilter = beforeCursor(b, input.cursor);
        if (cursorFilter) filters.push(cursorFilter);
      }
      const rows = await ctx.db
        .select({
          id: b.id,
          name: b.name,
          subject: b.subject,
          status: b.status,
          audienceName: a.name,
          recipients: sql<number>`count(${e.id})::int`,
          scheduledAt: b.scheduledAt,
          sentAt: b.sentAt,
          createdAt: b.createdAt,
          cursorCreatedAt: createdAtCursorField(b),
        })
        .from(b)
        .leftJoin(a, eq(a.id, b.audienceId))
        .leftJoin(e, eq(e.broadcastId, b.id))
        .where(and(...filters))
        .groupBy(b.id, a.name)
        .orderBy(desc(b.createdAt), desc(b.id))
        .limit(input.limit + 1);
      return paginate(rows, input.limit);
    }),

  /** Detail surface: full content plus the stat strip's aggregate over fanned-out emails. */
  get: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const row = await getOwnBroadcast(ctx, input.id);
    const a = schema.audiences;
    const e = schema.emails;
    const [audience] = row.audienceId
      ? await ctx.db.select({ name: a.name }).from(a).where(eq(a.id, row.audienceId)).limit(1)
      : [];
    // "Delivered" counts the delivered rung and everything above it on the
    // status ladder — an opened or clicked email was necessarily delivered.
    const [stats] = await ctx.db
      .select({
        total: sql<number>`count(*)::int`,
        delivered: sql<number>`count(*) filter (where ${e.latestStatus} in ('delivered', 'opened', 'clicked'))::int`,
        bounced: sql<number>`count(*) filter (where ${e.latestStatus} = 'bounced')::int`,
        complained: sql<number>`count(*) filter (where ${e.latestStatus} = 'complained')::int`,
      })
      .from(e)
      .where(and(eq(e.broadcastId, row.id), eq(e.teamId, ctx.teamId)));
    return {
      ...row,
      replyTo: firstReplyTo(row.replyTo),
      audienceName: audience?.name ?? null,
      stats: stats ?? { total: 0, delivered: 0, bounced: 0, complained: 0 },
    };
  }),

  create: teamProcedure
    .input(
      z.object({
        audienceId: z.uuid(),
        name: nameSchema.optional(),
        from: fromSchema,
        subject: subjectSchema,
        replyTo: emailSchema.optional(),
        html: bodySchema.optional(),
        text: bodySchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertAudience(ctx, input.audienceId);
      const b = schema.broadcasts;
      const [row] = await ctx.db
        .insert(b)
        .values({
          teamId: ctx.teamId,
          audienceId: input.audienceId,
          name: input.name || null,
          from: input.from,
          subject: input.subject,
          replyTo: input.replyTo ? encodeReplyTo(input.replyTo) : null,
          html: input.html || null,
          text: input.text || null,
        })
        .returning({ id: b.id });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return { id: row.id };
    }),

  update: teamProcedure
    .input(
      z.object({
        id: z.uuid(),
        audienceId: z.uuid().optional(),
        name: nameSchema.optional(),
        from: fromSchema.optional(),
        subject: subjectSchema.optional(),
        replyTo: emailSchema.or(z.literal("")).optional(),
        html: bodySchema.optional(),
        text: bodySchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await getOwnBroadcast(ctx, input.id);
      assertDraft(row);
      if (input.audienceId) await assertAudience(ctx, input.audienceId);
      const b = schema.broadcasts;
      await ctx.db
        .update(b)
        .set({
          ...(input.audienceId !== undefined ? { audienceId: input.audienceId } : {}),
          ...(input.name !== undefined ? { name: input.name || null } : {}),
          ...(input.from !== undefined ? { from: input.from } : {}),
          ...(input.subject !== undefined ? { subject: input.subject } : {}),
          ...(input.replyTo !== undefined ? { replyTo: encodeReplyTo(input.replyTo) } : {}),
          ...(input.html !== undefined ? { html: input.html || null } : {}),
          ...(input.text !== undefined ? { text: input.text || null } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(b.id, input.id), eq(b.teamId, ctx.teamId)));
      return { id: input.id };
    }),

  delete: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const row = await getOwnBroadcast(ctx, input.id);
    assertDraft(row);
    const b = schema.broadcasts;
    await ctx.db.delete(b).where(and(eq(b.id, input.id), eq(b.teamId, ctx.teamId)));
    return { id: input.id };
  }),

  /**
   * Draft → scheduled, then hands the broadcast to the fan-out queue. The
   * enqueue is best-effort: the broadcasts.reconcile sweep re-enqueues
   * scheduled broadcasts whose job was lost, and the fan-out is idempotent
   * per contact via the emails (broadcastId, contactId) unique index.
   */
  send: teamProcedure
    .input(z.object({ id: z.uuid(), scheduledAt: z.date().optional() }))
    .mutation(async ({ ctx, input }) => {
      const row = await getOwnBroadcast(ctx, input.id);
      if (row.status !== "draft") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Only drafts can be sent.",
        });
      }
      // ON DELETE SET NULL: a null audienceId means the audience was deleted
      // after this draft was written.
      if (!row.audienceId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The audience no longer exists. Pick another one.",
        });
      }
      if (!env.APP_BASE_URL) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "APP_BASE_URL is not set. Unsubscribe links are built from it. Set it, restart, send again.",
        });
      }
      const scheduledAt = input.scheduledAt ?? new Date();
      const b = schema.broadcasts;
      // status filter re-checked in the UPDATE so two concurrent sends cannot
      // both flip the row.
      const [updated] = await ctx.db
        .update(b)
        .set({ status: "scheduled", scheduledAt, updatedAt: new Date() })
        .where(and(eq(b.id, input.id), eq(b.teamId, ctx.teamId), eq(b.status, "draft")))
        .returning({ id: b.id });
      if (!updated) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only drafts can be sent." });
      }
      // Enqueue failure must not undo the commit — the reconcile sweep
      // re-enqueues scheduled broadcasts whose job was lost.
      try {
        await ctx.enqueueBroadcastSend?.(input.id, { startAfter: scheduledAt });
      } catch (err) {
        console.error("broadcast.send enqueue failed; reconcile sweep will recover", err);
      }
      return { id: input.id, scheduledAt };
    }),

  cancel: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await getOwnBroadcast(ctx, input.id);
    const b = schema.broadcasts;
    const [updated] = await ctx.db
      .update(b)
      .set({ status: "canceled", updatedAt: new Date() })
      .where(and(eq(b.id, input.id), eq(b.teamId, ctx.teamId), eq(b.status, "scheduled")))
      .returning({ id: b.id });
    if (!updated) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Only scheduled broadcasts can be canceled.",
      });
    }
    return { id: input.id };
  }),

  /** Guard-rail number: how many contacts a send would email right now. */
  recipientCount: teamProcedure
    .input(z.object({ audienceId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      await assertAudience(ctx, input.audienceId);
      const c = schema.contacts;
      const [row] = await ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(c)
        .where(
          and(
            eq(c.teamId, ctx.teamId),
            eq(c.audienceId, input.audienceId),
            eq(c.unsubscribed, false),
          ),
        );
      return { count: row?.count ?? 0 };
    }),
});
