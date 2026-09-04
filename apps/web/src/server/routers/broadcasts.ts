import { env } from "@millionsend/config";
import {
  DAY_MS,
  emailInsightsView,
  fetchBroadcastInsights,
  fetchDeliverabilityHealth,
  PAUSE_BOUNCE_RATE,
  PAUSE_COMPLAINT_RATE,
  parseSingleSender,
  regionPause,
  verifySenderDomain,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { createTranslator } from "next-intl";
import { z } from "zod";
import { mailyDocumentSchema } from "@/lib/email-doc";
import enDeliverability from "../../../messages/en/deliverability.json";
import ptBRDeliverability from "../../../messages/pt-BR/deliverability.json";
import type { AppLocale } from "../../i18n/request";
import { resolveEditorSave } from "../email-content";
import { beforeCursor, createdAtCursorField, cursorSchema, paginate } from "../keyset";
import { activeLocale } from "../locale";
import { router, teamProcedure } from "../trpc";
import { assertSegment, savedSegmentPredicate } from "./segments";
import { assertTopic, topicMembershipSql } from "./topics";

const MAX_SCHEDULE_AHEAD_DAYS = 30;

const DELIVERABILITY_MESSAGES: Record<AppLocale, typeof enDeliverability> = {
  en: enDeliverability,
  "pt-BR": ptBRDeliverability,
};

/**
 * PRECONDITION_FAILED when the team's trailing-window rates crossed a SES
 * enforcement line (fetchDeliverabilityHealth === "paused"); null otherwise.
 * "warning" never blocks. The message names the offending metric, its rate,
 * and the limit it passed, in the caller's locale.
 */
async function sendGuardTranslator() {
  const locale = await activeLocale();
  return {
    t: createTranslator({
      locale,
      messages: { deliverability: DELIVERABILITY_MESSAGES[locale] },
      namespace: "deliverability",
    }),
    pct: new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }),
  };
}

async function deliverabilityGuard(ctx: { db: Db; teamId: string }): Promise<TRPCError | null> {
  const health = await fetchDeliverabilityHealth(ctx.db, ctx.teamId);
  const reason =
    health.status === "paused" ? health.reasons.find((r) => r.tier === "paused") : null;
  if (!reason) return null;
  const { t, pct } = await sendGuardTranslator();
  const limit = reason.metric === "bounce" ? PAUSE_BOUNCE_RATE : PAUSE_COMPLAINT_RATE;
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message: t(`sendGuard.${reason.metric}`, {
      rate: pct.format(reason.rate),
      limit: pct.format(limit),
      days: reason.windowDays,
    }),
  });
}

/**
 * PRECONDITION_FAILED while the platform breaker holds broadcasts in the
 * sender domain's SES region (the account-wide rate is near SES's review
 * line); transactional mail is not affected, so only broadcasts check this.
 */
async function regionGuard(db: Db, region: string): Promise<TRPCError | null> {
  const pause = await regionPause(db, region);
  if (!pause) return null;
  const { t } = await sendGuardTranslator();
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message: t("sendGuard.regionPaused", {
      region,
      metric: t(`metric.${pause.reason?.metric ?? "complaint"}`),
    }),
  });
}

const emailSchema = z.string().trim().pipe(z.email()).pipe(z.string().max(320));
// SECURITY: a stored broadcast `from` is emitted verbatim by the worker
// fan-out, so it is the same trust boundary as the API's — it must parse as
// exactly one unambiguous mailbox (parseSingleSender, shared with the API and
// SMTP accept paths).
const fromSchema = z
  .string()
  .trim()
  .max(320)
  .refine((v) => parseSingleSender(v) !== null, {
    message: "From must be a single address like ada@example.com or Ada <ada@example.com>",
  });
const subjectSchema = z.string().trim().min(1).max(998);
// "" clears the field — stored as null, never as an empty string.
const nameSchema = z.string().trim().max(200);
const bodySchema = z.string().max(500_000);
// Maily editor source of truth; null clears it back to a legacy raw-HTML row.
const documentSchema = mailyDocumentSchema.nullable();

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
      const sg = schema.segments;
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
          segmentName: sg.name,
          recipients: sql<number>`count(${e.id})::int`,
          scheduledAt: b.scheduledAt,
          sentAt: b.sentAt,
          createdAt: b.createdAt,
          cursorCreatedAt: createdAtCursorField(b),
        })
        .from(b)
        .leftJoin(sg, eq(sg.id, b.segmentId))
        .leftJoin(e, eq(e.broadcastId, b.id))
        .where(and(...filters))
        .groupBy(b.id, sg.name)
        .orderBy(desc(b.createdAt), desc(b.id))
        .limit(input.limit + 1);
      return paginate(rows, input.limit);
    }),

  /** Detail surface: full content plus the stat strip's aggregate over fanned-out emails. */
  get: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const row = await getOwnBroadcast(ctx, input.id);
    const e = schema.emails;
    const tp = schema.topics;
    const [topic] = row.topicId
      ? await ctx.db.select({ name: tp.name }).from(tp).where(eq(tp.id, row.topicId)).limit(1)
      : [];
    const sg = schema.segments;
    const [segment] = row.segmentId
      ? await ctx.db.select({ name: sg.name }).from(sg).where(eq(sg.id, row.segmentId)).limit(1)
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
      topicName: topic?.name ?? null,
      segmentName: segment?.name ?? null,
      stats: stats ?? { total: 0, delivered: 0, bounced: 0, complained: 0 },
      insights: emailInsightsView(await fetchBroadcastInsights(ctx.db, ctx.teamId, row.id)),
    };
  }),

  create: teamProcedure
    .input(
      z.object({
        // null / omitted = all-contacts send; a topic scopes both the
        // recipient filter and each recipient's unsubscribe link.
        topicId: z.uuid().nullable().optional(),
        // null / omitted = all contacts; a segment narrows recipients to its
        // filter.
        segmentId: z.uuid().nullable().optional(),
        name: nameSchema.optional(),
        from: fromSchema,
        subject: subjectSchema,
        replyTo: emailSchema.optional(),
        html: bodySchema.optional(),
        text: bodySchema.optional(),
        document: documentSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.topicId) await assertTopic(ctx, input.topicId);
      if (input.segmentId) await assertSegment(ctx, input.segmentId);
      const saved = await resolveEditorSave(input);
      const b = schema.broadcasts;
      const [row] = await ctx.db
        .insert(b)
        .values({
          teamId: ctx.teamId,
          topicId: input.topicId ?? null,
          segmentId: input.segmentId ?? null,
          name: input.name || null,
          from: input.from,
          subject: input.subject,
          replyTo: input.replyTo ? encodeReplyTo(input.replyTo) : null,
          html: saved.html || null,
          text: saved.text || null,
          document: saved.document ?? null,
        })
        .returning({ id: b.id });
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return { id: row.id };
    }),

  update: teamProcedure
    .input(
      z.object({
        id: z.uuid(),
        topicId: z.uuid().nullable().optional(),
        segmentId: z.uuid().nullable().optional(),
        name: nameSchema.optional(),
        from: fromSchema.optional(),
        subject: subjectSchema.optional(),
        replyTo: emailSchema.or(z.literal("")).optional(),
        html: bodySchema.optional(),
        text: bodySchema.optional(),
        document: documentSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await getOwnBroadcast(ctx, input.id);
      assertDraft(row);
      if (input.topicId) await assertTopic(ctx, input.topicId);
      if (input.segmentId) await assertSegment(ctx, input.segmentId);
      const saved = await resolveEditorSave(input);
      const b = schema.broadcasts;
      const [updated] = await ctx.db
        .update(b)
        .set({
          ...(saved.topicId !== undefined ? { topicId: saved.topicId } : {}),
          ...(saved.segmentId !== undefined ? { segmentId: saved.segmentId } : {}),
          ...(saved.name !== undefined ? { name: saved.name || null } : {}),
          ...(saved.from !== undefined ? { from: saved.from } : {}),
          ...(saved.subject !== undefined ? { subject: saved.subject } : {}),
          ...(saved.replyTo !== undefined ? { replyTo: encodeReplyTo(saved.replyTo) } : {}),
          ...(saved.html !== undefined ? { html: saved.html || null } : {}),
          ...(saved.text !== undefined ? { text: saved.text || null } : {}),
          ...(saved.document !== undefined ? { document: saved.document } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(b.id, input.id), eq(b.teamId, ctx.teamId), eq(b.status, "draft")))
        .returning({ id: b.id });
      if (!updated) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Only drafts can be changed.",
        });
      }
      return { id: input.id };
    }),

  delete: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const row = await getOwnBroadcast(ctx, input.id);
    assertDraft(row);
    const b = schema.broadcasts;
    const [deleted] = await ctx.db
      .delete(b)
      .where(and(eq(b.id, input.id), eq(b.teamId, ctx.teamId), eq(b.status, "draft")))
      .returning({ id: b.id });
    if (!deleted) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Only drafts can be changed.",
      });
    }
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
      if (!env.APP_BASE_URL) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "APP_BASE_URL is not set. Unsubscribe links are built from it. Set it, restart, send again.",
        });
      }
      // Same boundary as the API's /emails and /broadcasts/{id}/send: only a
      // verified team domain may appear as the sender. The worker re-checks
      // at fan-out, but failing there leaves the broadcast stuck in
      // "scheduled" with no user-visible reason.
      const sender = await verifySenderDomain(ctx.db, ctx.teamId, row.from);
      if (!sender.ok) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            sender.reason === "invalid_sender"
              ? "From must be a single address."
              : `The ${sender.fromDomain} domain is not verified for this team.`,
        });
      }
      // Deliverability pause is enforced here, before anything is committed or
      // enqueued: a paused account must not schedule a new fan-out. "warning"
      // does not block.
      const guardError =
        (await deliverabilityGuard(ctx)) ?? (await regionGuard(ctx.db, sender.region));
      if (guardError) throw guardError;
      const scheduledAt = input.scheduledAt ?? new Date();
      // Same horizon as the API: a body must not sit out the retention purge.
      if (scheduledAt.getTime() > Date.now() + MAX_SCHEDULE_AHEAD_DAYS * DAY_MS) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Broadcasts can be scheduled at most ${MAX_SCHEDULE_AHEAD_DAYS} days ahead.`,
        });
      }
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

  /**
   * Guard-rail number: how many contacts a send would email right now. A
   * topicId narrows the count to that topic's subscribers per the SUBSCRIPTION
   * RULE (globally subscribed AND topic-subscribed), matching the worker's
   * topic-scoped fan-out; without one it is every non-unsubscribed contact.
   */
  recipientCount: teamProcedure
    .input(
      z.object({
        topicId: z.uuid().nullable().optional(),
        segmentId: z.uuid().nullable().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const c = schema.contacts;
      const base = [eq(c.teamId, ctx.teamId), eq(c.unsubscribed, false)];
      // A segment narrows recipients via the shared resolver (filter matches
      // plus manual members), AND'd on top of the global-unsubscribe and
      // topic rules — the same predicate the worker fan-out targets.
      if (input.segmentId) {
        const segment = await assertSegment(ctx, input.segmentId);
        base.push(savedSegmentPredicate(segment));
      }
      if (!input.topicId) {
        const [row] = await ctx.db
          .select({ count: sql<number>`count(*)::int` })
          .from(c)
          .where(and(...base));
        return { count: row?.count ?? 0 };
      }
      await assertTopic(ctx, input.topicId);
      const t = schema.topics;
      const s = schema.contactTopicSubscriptions;
      const [row] = await ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(c)
        .innerJoin(t, eq(t.id, input.topicId))
        .leftJoin(s, and(eq(s.topicId, input.topicId), eq(s.contactId, c.id)))
        .where(and(...base, topicMembershipSql(s, t)));
      return { count: row?.count ?? 0 };
    }),
});
