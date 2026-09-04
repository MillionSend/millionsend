import {
  decryptEmailBody,
  type EmailBody,
  emailInsightsView,
  fetchEmailInsights,
  hashRecipient,
  utcDay,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, gte, ilike, lt, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { escapeLike } from "@/lib/sql";
import { getKeyring } from "../keyring";
import { adminProcedure, router, teamProcedure } from "../trpc";

const emailStatus = z.enum(schema.emailStatusEnum.enumValues);

/**
 * Keyset cursor over (createdAt desc, id desc); id breaks createdAt ties.
 * createdAt travels as the Postgres text rendering of the timestamptz, not
 * as a Date: timestamptz carries microseconds and a JS Date only
 * milliseconds, so a Date round-trip would silently skip same-millisecond
 * rows at page boundaries.
 */
const cursorSchema = z.object({ createdAt: z.string(), id: z.uuid() });
type Cursor = z.infer<typeof cursorSchema>;

function beforeCursor(
  t: { createdAt: AnyPgColumn; id: AnyPgColumn },
  cursor: Cursor,
): SQL | undefined {
  return or(
    sql`${t.createdAt} < ${cursor.createdAt}::timestamptz`,
    and(sql`${t.createdAt} = ${cursor.createdAt}::timestamptz`, lt(t.id, cursor.id)),
  );
}

/** Mirror of beforeCursor for ascending (createdAt asc, id asc) pages. */
function afterCursor(
  t: { createdAt: AnyPgColumn; id: AnyPgColumn },
  cursor: Cursor,
): SQL | undefined {
  return or(
    sql`${t.createdAt} > ${cursor.createdAt}::timestamptz`,
    and(sql`${t.createdAt} = ${cursor.createdAt}::timestamptz`, gt(t.id, cursor.id)),
  );
}

/** Full-precision cursor value for a row's createdAt (see cursorSchema). */
function createdAtCursorField(t: { createdAt: AnyPgColumn }): SQL<string> {
  return sql<string>`${t.createdAt}::text`;
}

/**
 * Splits a limit+1 fetch into the page and its next-page cursor. Rows must
 * already be ordered on (createdAt, id) in the direction the cursor filter
 * walks; the cursorCreatedAt field feeds the cursor and is stripped from
 * the returned items.
 */
function paginate<T extends { id: string; cursorCreatedAt: string }>(
  rows: T[],
  limit: number,
): { items: Omit<T, "cursorCreatedAt">[]; nextCursor: Cursor | null } {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last ? { createdAt: last.cursorCreatedAt, id: last.id } : null;
  const items = page.map(({ cursorCreatedAt: _cursorCreatedAt, ...item }) => item);
  return { items, nextCursor };
}

export const emailsRouter = router({
  list: teamProcedure
    .input(
      z.object({
        status: emailStatus.optional(),
        search: z.string().trim().max(200).optional(),
        apiKeyId: z.uuid().optional(),
        domainId: z.uuid().optional(),
        broadcastId: z.uuid().optional(),
        since: z.coerce.date().optional(),
        cursor: cursorSchema.optional(),
        limit: z.number().int().min(1).max(50).default(25),
        // "asc" reads oldest-first (e.g. a team's very first email).
        order: z.enum(["asc", "desc"]).default("desc"),
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
      if (input.apiKeyId) filters.push(eq(t.apiKeyId, input.apiKeyId));
      if (input.domainId) filters.push(eq(t.domainId, input.domainId));
      if (input.broadcastId) filters.push(eq(t.broadcastId, input.broadcastId));
      if (input.since) filters.push(gte(t.createdAt, input.since));
      // Total counts the filter scope, not the page — the cursor is excluded.
      const [totalRow] = await ctx.db
        .select({ total: sql<number>`count(*)::int` })
        .from(t)
        .where(and(...filters));
      const ascending = input.order === "asc";
      if (input.cursor) {
        filters.push(ascending ? afterCursor(t, input.cursor) : beforeCursor(t, input.cursor));
      }
      const rows = await ctx.db
        .select({
          id: t.id,
          to: t.to,
          subject: t.subject,
          latestStatus: t.latestStatus,
          createdAt: t.createdAt,
          cursorCreatedAt: createdAtCursorField(t),
          scheduledAt: t.scheduledAt,
        })
        .from(t)
        .where(and(...filters))
        .orderBy(...(ascending ? [asc(t.createdAt), asc(t.id)] : [desc(t.createdAt), desc(t.id)]))
        .limit(input.limit + 1);
      return { ...paginate(rows, input.limit), total: totalRow?.total ?? 0 };
    }),

  /** Masthead proof strip + cap banner: today's sends, all-time deliveries, p50, queued backlog. */
  stats: teamProcedure.query(async ({ ctx }) => {
    const today = utcDay();
    const c = schema.usageCounters;
    const [usage] = await ctx.db
      .select({
        sentToday: sql<number>`coalesce(sum(${c.sent}) filter (where ${c.day} = ${today}), 0)::int`,
        deliveredAllTime: sql<number>`coalesce(sum(${c.delivered}), 0)::int`,
      })
      .from(c)
      .where(eq(c.teamId, ctx.teamId));

    const t = schema.emails;
    const [queued] = await ctx.db
      .select({ count: sql<number>`count(*)::int` })
      .from(t)
      .where(and(eq(t.teamId, ctx.teamId), eq(t.latestStatus, "queued_quota")));

    // p50 over SES delivery processingTimeMillis recorded in delivered events.
    const ev = schema.emailEvents;
    const [p50] = await ctx.db
      .select({
        p50: sql<
          string | null
        >`percentile_cont(0.5) within group (order by (${ev.data}->'delivery'->>'processingTimeMillis')::numeric)`,
      })
      .from(ev)
      .innerJoin(t, eq(ev.emailId, t.id))
      .where(
        and(
          eq(t.teamId, ctx.teamId),
          eq(ev.type, "delivered"),
          sql`${ev.data}->'delivery'->>'processingTimeMillis' is not null`,
        ),
      );

    return {
      sentToday: usage?.sentToday ?? 0,
      deliveredAllTime: usage?.deliveredAllTime ?? 0,
      queuedQuota: queued?.count ?? 0,
      p50DeliveryMs: p50?.p50 == null ? null : Math.round(Number(p50.p50)),
    };
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
          { teamId: email.teamId, rowId: email.id },
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

    const insightsRow = await fetchEmailInsights(ctx.db, ctx.teamId, {
      emailId: email.id,
      broadcastId: email.broadcastId,
    });
    const insights = emailInsightsView(insightsRow);

    let apiKeyName: string | null = null;
    if (email.apiKeyId) {
      const k = schema.apiKeys;
      const [key] = await ctx.db
        .select({ name: k.name })
        .from(k)
        .where(and(eq(k.id, email.apiKeyId), eq(k.teamId, ctx.teamId)))
        .limit(1);
      apiKeyName = key?.name ?? null;
    }

    // Whitelisted shape: the ciphertext/key columns must never reach the client.
    return {
      apiKeyName,
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
      insights,
    };
  }),

  suppressions: router({
    list: teamProcedure
      .input(
        z.object({
          search: z.string().trim().max(200).optional(),
          reason: z.enum(schema.suppressionReasonEnum.enumValues).optional(),
          since: z.coerce.date().optional(),
          cursor: cursorSchema.optional(),
          limit: z.number().int().min(1).max(50).default(25),
        }),
      )
      .query(async ({ ctx, input }) => {
        const t = schema.suppressions;
        const filters: (SQL | undefined)[] = [eq(t.teamId, ctx.teamId)];
        if (input.search) filters.push(ilike(t.email, `%${escapeLike(input.search)}%`));
        if (input.reason) filters.push(eq(t.reason, input.reason));
        if (input.since) filters.push(gte(t.createdAt, input.since));
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
            reason: t.reason,
            createdAt: t.createdAt,
            cursorCreatedAt: createdAtCursorField(t),
          })
          .from(t)
          .where(and(...filters))
          .orderBy(desc(t.createdAt), desc(t.id))
          .limit(input.limit + 1);
        return { ...paginate(rows, input.limit), total: totalRow?.total ?? 0 };
      }),

    /** Masthead proof strip: "{total} addresses blocked · {n} bounce · {n} complaint". */
    stats: teamProcedure.query(async ({ ctx }) => {
      const t = schema.suppressions;
      const rows = await ctx.db
        .select({ reason: t.reason, count: sql<number>`count(*)::int` })
        .from(t)
        .where(eq(t.teamId, ctx.teamId))
        .groupBy(t.reason);
      const byReason = Object.fromEntries(rows.map((r) => [r.reason, r.count])) as Partial<
        Record<(typeof schema.suppressionReasonEnum.enumValues)[number], number>
      >;
      return { total: rows.reduce((sum, r) => sum + r.count, 0), byReason };
    }),

    get: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
      const t = schema.suppressions;
      const [row] = await ctx.db
        .select({
          id: t.id,
          email: t.email,
          reason: t.reason,
          createdAt: t.createdAt,
          sourceEmailId: t.sourceEmailId,
        })
        .from(t)
        .where(and(eq(t.id, input.id), eq(t.teamId, ctx.teamId)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });

      // The SMTP diagnostic lives on the source email's bounce event; the
      // team guard on the join keeps a stray sourceEmailId from leaking
      // another tenant's event payload.
      let bounce: Record<string, unknown> | null = null;
      if (row.sourceEmailId) {
        const ev = schema.emailEvents;
        const e = schema.emails;
        const [event] = await ctx.db
          .select({ data: ev.data })
          .from(ev)
          .innerJoin(e, eq(ev.emailId, e.id))
          .where(
            and(
              eq(ev.emailId, row.sourceEmailId),
              eq(e.teamId, ctx.teamId),
              eq(ev.type, "bounced"),
            ),
          )
          .orderBy(desc(ev.occurredAt), desc(ev.id))
          .limit(1);
        const data = event?.data?.bounce;
        bounce = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
      }
      return { ...row, bounce };
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

    // Admin-only: lifting a bounce/complaint block re-exposes sender reputation.
    remove: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
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
