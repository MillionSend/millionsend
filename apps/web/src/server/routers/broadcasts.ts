import { env } from "@millionsend/config";
import {
  acceptEmail,
  applyMergeFields,
  DAY_MS,
  emailInsightsView,
  fetchBroadcastInsights,
  fetchDeliverabilityHealth,
  fetchEffectivePlan,
  injectPreheader,
  type MergeContact,
  PAUSE_BOUNCE_RATE,
  PAUSE_COMPLAINT_RATE,
  parseSingleSender,
  regionPause,
  substituteUnsubscribeUrl,
  verifySenderDomain,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, gt, sql } from "drizzle-orm";
import { createTranslator } from "next-intl";
import { z } from "zod";
import { mailyDocumentSchema } from "@/lib/email-doc";
import enDeliverability from "../../../messages/en/deliverability.json";
import ptBRDeliverability from "../../../messages/pt-BR/deliverability.json";
import type { AppLocale } from "../../i18n/request";
import { resolveEditorSave } from "../email-content";
import { getKeyring } from "../keyring";
import { beforeCursor, createdAtCursorField, cursorSchema, paginate } from "../keyset";
import { activeLocale } from "../locale";
import { router, teamProcedure } from "../trpc";
import { assertSegment, savedSegmentPredicate } from "./segments";
import { assertTopic, topicMembershipSql } from "./topics";

const MAX_SCHEDULE_AHEAD_DAYS = 30;

/**
 * Test sends are real emails through the team's quota to the signed-in
 * user. The tag marks them so the per-team hourly cap below can count them
 * without a table of its own.
 */
const TEST_SEND_TAG = "millionsend_test";
const TEST_SENDS_PER_HOUR = 10;

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

/**
 * recipient_count is written once when the fan-out completes and survives the
 * emails retention purge; rows that predate the column (or are still sending)
 * fall back to a live count over the fan-out's own unique index, per row.
 */
function recipientsSql(b: typeof schema.broadcasts) {
  const e = schema.emails;
  return sql<number>`coalesce(${b.recipientCount}, (select count(*)::int from ${e} where ${e.broadcastId} = ${b.id}))`;
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
          recipients: recipientsSql(b),
          scheduledAt: b.scheduledAt,
          sentAt: b.sentAt,
          createdAt: b.createdAt,
          cursorCreatedAt: createdAtCursorField(b),
        })
        .from(b)
        .leftJoin(sg, eq(sg.id, b.segmentId))
        .where(and(...filters))
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
    // Opened likewise includes clicked; both count people only, since a
    // prefetch never lifts the status (see the tracking recorder).
    const ev = schema.emailEvents;
    const [stats] = await ctx.db
      .select({
        total: sql<number>`count(*)::int`,
        delivered: sql<number>`count(*) filter (where ${e.latestStatus} in ('delivered', 'opened', 'clicked'))::int`,
        opened: sql<number>`count(*) filter (where ${e.latestStatus} in ('opened', 'clicked'))::int`,
        clicked: sql<number>`count(*) filter (where ${e.latestStatus} = 'clicked')::int`,
        prefetched: sql<number>`count(*) filter (where exists (select 1 from ${ev} where ${ev.emailId} = ${e.id} and ${ev.type} = 'prefetched'))::int`,
        bounced: sql<number>`count(*) filter (where ${e.latestStatus} = 'bounced')::int`,
        complained: sql<number>`count(*) filter (where ${e.latestStatus} = 'complained')::int`,
      })
      .from(e)
      .where(and(eq(e.broadcastId, row.id), eq(e.teamId, ctx.teamId)));
    const live = stats && stats.total > 0 ? stats : null;
    return {
      ...row,
      replyTo: firstReplyTo(row.replyTo),
      topicName: topic?.name ?? null,
      segmentName: segment?.name ?? null,
      // Live counts while any email row still exists; the counts recorded
      // before the rows aged out stand in once they are gone.
      stats: {
        total: row.recipientCount ?? live?.total ?? 0,
        delivered: live?.delivered ?? row.deliveredCount ?? 0,
        // Engagement keeps arriving after the send, so no snapshot could
        // stand in once the rows age out: null past the metadata window,
        // zero before any fan-out (recipientCount is set when a send ends).
        opened: live?.opened ?? (row.recipientCount ? null : 0),
        clicked: live?.clicked ?? (row.recipientCount ? null : 0),
        prefetched: live?.prefetched ?? (row.recipientCount ? null : 0),
        bounced: live?.bounced ?? row.bouncedCount ?? 0,
        complained: live?.complained ?? row.complainedCount ?? 0,
      },
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

  /**
   * Sends the composer's current content to the signed-in user, rendered the
   * way the fan-out renders it (merge fields, preheader), with the subject
   * marked as a test. Needs no saved draft, so a new broadcast can be
   * previewed in a real inbox before its first save.
   */
  sendTest: teamProcedure
    .input(
      z.object({
        from: z.string().trim().min(1),
        subject: z.string().trim().min(1),
        html: z.string().nullable(),
        text: z.string().nullable(),
        previewText: z.string().nullable().optional(),
        replyTo: z.array(z.string().trim().min(1)).max(10).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const to = ctx.session?.user.email;
      if (!to) throw new TRPCError({ code: "UNAUTHORIZED" });
      if (!input.html && !input.text) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Write some content first." });
      }
      const sender = await verifySenderDomain(ctx.db, ctx.teamId, input.from);
      if (!sender.ok) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            sender.reason === "invalid_sender"
              ? "From must be a single address."
              : `The ${sender.fromDomain} domain is not verified for this team.`,
        });
      }
      const guardError =
        (await deliverabilityGuard(ctx)) ?? (await regionGuard(ctx.db, sender.region));
      if (guardError) throw guardError;
      const e = schema.emails;
      const [recent] = await ctx.db
        .select({ n: count() })
        .from(e)
        .where(
          and(
            eq(e.teamId, ctx.teamId),
            gt(e.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
            sql`${e.tags} ? ${TEST_SEND_TAG}`,
          ),
        );
      if ((recent?.n ?? 0) >= TEST_SENDS_PER_HOUR) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS" });
      }
      // The reader is the sender's own account, so merge fields resolve to
      // it; there is no contact to unsubscribe, so the link points home.
      const [firstName, ...rest] = (ctx.session.user.name ?? "").trim().split(/\s+/);
      const contact: MergeContact = {
        email: to,
        firstName: firstName || null,
        lastName: rest.length > 0 ? rest.join(" ") : null,
        properties: {},
      };
      const unsubscribeUrl = env.APP_BASE_URL ? `${env.APP_BASE_URL}/broadcasts` : "#";
      const personalize = (content: string | null, html: boolean) =>
        content === null
          ? undefined
          : applyMergeFields(substituteUnsubscribeUrl(content, unsubscribeUrl), contact, { html });
      const htmlWithPreheader =
        input.html && input.previewText
          ? injectPreheader(input.html, input.previewText)
          : input.html;
      const result = await acceptEmail(
        {
          db: ctx.db,
          keyring: getKeyring(),
          isCloud: env.IS_CLOUD,
          // Absent in tests: the reconcile sweep re-enqueues accepted rows.
          enqueueEmailSend: ctx.enqueueEmailSend ?? (async () => {}),
        },
        {
          teamId: ctx.teamId,
          plan: (await fetchEffectivePlan(ctx.db, ctx.teamId)) ?? "free",
          apiKeyId: null,
        },
        {
          from: input.from,
          to: [to],
          ...(input.replyTo && input.replyTo.length > 0 ? { replyTo: input.replyTo } : {}),
          subject: `[Test] ${applyMergeFields(input.subject, contact, { html: false })}`,
          html: personalize(htmlWithPreheader, true),
          text: personalize(input.text, false),
          tags: { [TEST_SEND_TAG]: "1" },
          domainId: sender.domainId,
        },
      );
      if (!result.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: result.reason });
      return { to };
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
