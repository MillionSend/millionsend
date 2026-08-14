import { env } from "@millionsend/config";
import type { Keyring } from "@millionsend/core";
import { decryptEmailBody, type EmailBody, EnvKeyring, hashRecipient } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, ilike, lt, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { escapeLike } from "@/lib/sql";
import { router, teamProcedure } from "../trpc";

const emailStatus = z.enum(schema.emailStatusEnum.enumValues);

/** Keyset cursor over (createdAt desc, id desc); id breaks createdAt ties. */
const cursorSchema = z.object({ createdAt: z.date(), id: z.uuid() });
type Cursor = z.infer<typeof cursorSchema>;

function beforeCursor(
  t: { createdAt: AnyPgColumn; id: AnyPgColumn },
  cursor: Cursor,
): SQL | undefined {
  return or(
    lt(t.createdAt, cursor.createdAt),
    and(eq(t.createdAt, cursor.createdAt), lt(t.id, cursor.id)),
  );
}

/**
 * Splits a limit+1 fetch into the page and its next-page cursor. Rows must
 * already be ordered (createdAt desc, id desc).
 */
function paginate<T extends Cursor>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: Cursor | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor =
    rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null;
  return { items, nextCursor };
}

// Built lazily so the process only demands MASTER_ENCRYPTION_KEY when a body
// is actually read, and so tests can point the env at a test key first.
let keyring: Keyring | undefined;
function getKeyring(): Keyring {
  if (!keyring) {
    if (!env.MASTER_ENCRYPTION_KEY) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "MASTER_ENCRYPTION_KEY is not configured",
      });
    }
    keyring = EnvKeyring.fromBase64(env.MASTER_ENCRYPTION_KEY);
  }
  return keyring;
}

export const emailsRouter = router({
  list: teamProcedure
    .input(
      z.object({
        status: emailStatus.optional(),
        search: z.string().trim().max(200).optional(),
        cursor: cursorSchema.optional(),
        limit: z.number().int().min(1).max(50).default(25),
      }),
    )
    .query(async ({ ctx, input }) => {
      const t = schema.emails;
      const filters: (SQL | undefined)[] = [eq(t.teamId, ctx.teamId)];
      if (input.status) filters.push(eq(t.latestStatus, input.status));
      if (input.search) {
        const pattern = `%${escapeLike(input.search)}%`;
        filters.push(or(ilike(t.subject, pattern), sql`${t.to}::text ilike ${pattern}`));
      }
      if (input.cursor) filters.push(beforeCursor(t, input.cursor));
      const rows = await ctx.db
        .select({
          id: t.id,
          to: t.to,
          subject: t.subject,
          latestStatus: t.latestStatus,
          createdAt: t.createdAt,
          scheduledAt: t.scheduledAt,
        })
        .from(t)
        .where(and(...filters))
        .orderBy(desc(t.createdAt), desc(t.id))
        .limit(input.limit + 1);
      return paginate(rows, input.limit);
    }),

  get: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const t = schema.emails;
    const [email] = await ctx.db
      .select()
      .from(t)
      .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
      .limit(1);
    if (!email) throw new TRPCError({ code: "NOT_FOUND" });

    let body: EmailBody = { html: null, text: null };
    if (
      email.bodyCiphertext &&
      email.bodyIv &&
      email.bodyWrappedDek &&
      email.bodyKeyVersion != null
    ) {
      const kr = getKeyring();
      try {
        body = await decryptEmailBody(
          {
            ciphertext: email.bodyCiphertext,
            iv: email.bodyIv,
            wrappedDek: email.bodyWrappedDek,
            keyVersion: email.bodyKeyVersion,
          },
          kr,
        );
      } catch {
        // Undecryptable (corrupt ciphertext, unknown KEK version) reads as
        // "no body" — the metadata and events are still worth showing.
      }
    }

    const ev = schema.emailEvents;
    const events = await ctx.db
      .select({ id: ev.id, type: ev.type, occurredAt: ev.occurredAt, data: ev.data })
      .from(ev)
      .where(eq(ev.emailId, email.id))
      .orderBy(asc(ev.occurredAt), asc(ev.id));

    // Whitelisted shape: the ciphertext/key columns must never reach the client.
    return {
      id: email.id,
      from: email.from,
      to: email.to,
      cc: email.cc,
      bcc: email.bcc,
      replyTo: email.replyTo,
      subject: email.subject,
      tags: email.tags,
      latestStatus: email.latestStatus,
      createdAt: email.createdAt,
      scheduledAt: email.scheduledAt,
      sentAt: email.sentAt,
      bodyPurgedAt: email.bodyPurgedAt,
      html: body.html,
      text: body.text,
      events,
    };
  }),

  suppressions: router({
    list: teamProcedure
      .input(
        z.object({
          search: z.string().trim().max(200).optional(),
          cursor: cursorSchema.optional(),
          limit: z.number().int().min(1).max(50).default(25),
        }),
      )
      .query(async ({ ctx, input }) => {
        const t = schema.suppressions;
        const filters: (SQL | undefined)[] = [eq(t.teamId, ctx.teamId)];
        if (input.search) filters.push(ilike(t.email, `%${escapeLike(input.search)}%`));
        if (input.cursor) filters.push(beforeCursor(t, input.cursor));
        const rows = await ctx.db
          .select({ id: t.id, email: t.email, reason: t.reason, createdAt: t.createdAt })
          .from(t)
          .where(and(...filters))
          .orderBy(desc(t.createdAt), desc(t.id))
          .limit(input.limit + 1);
        return paginate(rows, input.limit);
      }),

    add: teamProcedure
      .input(
        z.object({
          email: z.string().trim().pipe(z.email()).pipe(z.string().max(320)),
          reason: z.literal("manual"),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const t = schema.suppressions;
        const emailHash = hashRecipient(input.email);
        const [row] = await ctx.db
          .insert(t)
          .values({ teamId: ctx.teamId, email: input.email, emailHash, reason: input.reason })
          .onConflictDoNothing()
          .returning({ id: t.id });
        if (row) return { id: row.id };
        // Already suppressed (any reason) — adding is idempotent.
        const [existing] = await ctx.db
          .select({ id: t.id })
          .from(t)
          .where(and(eq(t.teamId, ctx.teamId), eq(t.emailHash, emailHash)))
          .limit(1);
        if (!existing) throw new TRPCError({ code: "CONFLICT" });
        return { id: existing.id };
      }),

    remove: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
      const t = schema.suppressions;
      const [row] = await ctx.db
        .delete(t)
        .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
        .returning({ id: t.id });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return { id: row.id };
    }),
  }),
});
