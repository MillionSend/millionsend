import { env, isCloudDeployment } from "@millionsend/config";
import {
  acceptEmail,
  applyMergeFields,
  broadcastProviderBreakdown,
  cancelBroadcastRows,
  complainedEmail,
  DAY_MS,
  deliveredEmail,
  emailInsightsView,
  enableWarmup,
  fetchBroadcastInsights,
  fetchTeamStanding,
  heldByNewDomainLimit,
  injectPreheader,
  MAX_SUBJECT_LENGTH,
  type MergeContact,
  PAUSE_BOUNCE_RATE,
  PAUSE_COMPLAINT_RATE,
  parseSingleSender,
  regionPause,
  reservedSenderRefusal,
  sendRefusal,
  splitPersonName,
  substituteUnsubscribeUrl,
  verifySenderDomain,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { createTranslator } from "next-intl";
import { z } from "zod";
import { mailyDocumentSchema } from "@/lib/email-doc";
import enDeliverability from "../../../messages/en/deliverability.json";
import ptBRDeliverability from "../../../messages/pt-BR/deliverability.json";
import type { AppLocale } from "../../i18n/request";
import { fetchQuotaRow } from "../billing";
import {
  broadcastWarmup,
  heldBroadcastIds,
  planBroadcastSend,
  planHoldUntil,
  sendingProgress,
  warmupSendPlan,
} from "../broadcast-plan";
import { resolveEditorSave } from "../email-content";
import { inboxSendDeps, userActor } from "../inboxes";
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

/**
 * PRECONDITION_FAILED while the team may not send (core sendRefusal: an
 * operator suspension, or trailing rates past SES's pause line) or the
 * operator paused its broadcasts; read per call so the action bites at once.
 * The message is in the caller's locale.
 */
async function sendGuard(ctx: { db: Db; teamId: string }): Promise<TRPCError | null> {
  const refusal = await sendRefusal(ctx.db, ctx.teamId);
  const operatorPaused =
    !refusal && (await fetchTeamStanding(ctx.db, ctx.teamId))?.broadcastsPausedByOperatorAt;
  if (!refusal && !operatorPaused) return null;
  const { t, pct } = await sendGuardTranslator();
  const message = !refusal
    ? t("sendGuard.operatorPaused")
    : refusal.reason === "team_suspended"
      ? t(refusal.suspension === "review" ? "sendGuard.pendingReview" : "sendGuard.suspended")
      : t(`sendGuard.${refusal.pause.metric}`, {
          rate: pct.format(refusal.pause.rate),
          limit: pct.format(
            refusal.pause.metric === "bounce" ? PAUSE_BOUNCE_RATE : PAUSE_COMPLAINT_RATE,
          ),
          days: refusal.pause.windowDays,
        });
  return new TRPCError({ code: "PRECONDITION_FAILED", message });
}

/**
 * PRECONDITION_FAILED while broadcasts are held in the sender domain's SES
 * region (the platform breaker, or the operator's hold); transactional mail
 * is not affected, so only broadcasts check this. The message never says
 * why: the platform's rates are not the customer's to see.
 */
async function regionGuard(db: Db, region: string): Promise<TRPCError | null> {
  if (!(await regionPause(db, region))) return null;
  const { t } = await sendGuardTranslator();
  return new TRPCError({ code: "PRECONDITION_FAILED", message: t("sendGuard.regionHeld") });
}

/**
 * PRECONDITION_FAILED when the send would still be going out past the pacing
 * horizon: capacity or the team's own cap needs more days than bodies are
 * kept for. The dialog shows the same verdict; this is what enforces it. No
 * estimate (SES unreachable) refuses nothing.
 */
async function horizonGuard(
  ctx: { db: Db; teamId: string },
  region: string,
  count: number,
  at: Date,
): Promise<TRPCError | null> {
  if (count === 0) return null;
  const plan = await planBroadcastSend(ctx.db, {
    teamId: ctx.teamId,
    region,
    newSend: { count, at },
  });
  if (!plan?.estimate?.blocked) return null;
  const { t } = await sendGuardTranslator();
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message: t(isCloudDeployment() ? "sendGuard.tooLarge" : "sendGuard.tooLargeSelfHost", {
      days: plan.estimate.horizonDays,
    }),
  });
}

/** The horizon refusal for a send whose domain's warm-up, not capacity, sets its pace. */
async function warmupHorizonError(horizonDays: number): Promise<TRPCError> {
  const { t } = await sendGuardTranslator();
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message: t("sendGuard.warmupTooLong", { days: horizonDays }),
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
const subjectSchema = z.string().trim().min(1).max(MAX_SUBJECT_LENGTH);
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
  // While the walk runs, the audience it counted up front stands for the total.
  // A walk canceled midway never sets recipient_count; its rows are the total.
  const written = sql`(select count(*)::int from ${e} where ${e.broadcastId} = ${b.id})`;
  return sql<number>`coalesce(${b.recipientCount}, case when ${b.status} = 'sending' then greatest(${b.audienceCount}, ${written}) else ${written} end)`;
}

function assertDraft(row: BroadcastRow): void {
  if (row.status !== "draft") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Only drafts can be changed.",
    });
  }
}

/**
 * How many contacts a send would email right now. A topicId narrows the
 * count to that topic's subscribers per the SUBSCRIPTION RULE (globally
 * subscribed AND topic-subscribed), matching the worker's topic-scoped
 * fan-out; without one it is every non-unsubscribed contact.
 */
async function countAudience(
  ctx: { db: Db; teamId: string },
  input: { topicId?: string | null | undefined; segmentId?: string | null | undefined },
): Promise<number> {
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
    return row?.count ?? 0;
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
  return row?.count ?? 0;
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
          from: b.from,
          status: b.status,
          segmentId: b.segmentId,
          topicId: b.topicId,
          segmentName: sg.name,
          // Mirrors lib/template-mode bodyEditorMode: html without a Tiptap doc
          // node is authored outside the block editor, shown as such in the
          // list; an empty body opens in the block editor, so it isn't. The
          // sort evaluates this for every row of the team: left() reads only
          // the html's first TOAST slice, and the whole body is read only when
          // that start is blank.
          htmlAuthored: sql<boolean>`(${b.document} is null or ${b.document}->>'type' is distinct from 'doc') and (left(coalesce(${b.html}, ''), 64) ~ '\\S' or coalesce(${b.html}, '') ~ '\\S')`,
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
      const page = paginate(rows, input.limit);
      // One planner run per region for the rows still going out; nothing
      // when none is.
      const progress = page.items.some((row) => row.status === "sending")
        ? await sendingProgress(ctx.db, ctx.teamId)
        : new Map<string, never>();
      const held = await heldBroadcastIds(ctx.db, ctx.teamId, page.items);
      return {
        ...page,
        items: page.items.map((row) => {
          const p = progress.get(row.id);
          return {
            ...row,
            held: held.has(row.id),
            sentCount: p?.sentCount ?? null,
            parkedCount: p?.parkedCount ?? null,
            finishesAt: p?.finishesAt ?? null,
            releases: p?.releases ?? [],
            sent: p?.sent ?? [],
            newDomainLimit: p?.newDomainLimit ?? null,
          };
        }),
      };
    }),

  /** Detail surface: full content plus the stat strip's aggregate over fanned-out emails. */
  get: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const stored = await getOwnBroadcast(ctx, input.id);
    // A body that has reached recipients IS the content of sent emails, which
    // a support view never sees. One still queued has reached nobody, and
    // "why does this render wrong" is what support is asked before a send,
    // so a draft and a scheduled broadcast stay readable. Canceled counts as
    // reached: a cancel can land mid-fan-out, after copies have gone.
    const SENT_TO_SOMEONE: readonly string[] = ["sending", "sent", "canceled"];
    const hiddenBySupportView = Boolean(ctx.supportView) && SENT_TO_SOMEONE.includes(stored.status);
    // previewText is the preheader the worker injects into the sent html, so
    // it travels with the body and goes with it.
    const row = hiddenBySupportView
      ? { ...stored, html: null, text: null, document: null, previewText: null }
      : stored;
    const e = schema.emails;
    const tp = schema.topics;
    const [topic] = row.topicId
      ? await ctx.db.select({ name: tp.name }).from(tp).where(eq(tp.id, row.topicId)).limit(1)
      : [];
    const sg = schema.segments;
    const [segment] = row.segmentId
      ? await ctx.db.select({ name: sg.name }).from(sg).where(eq(sg.id, row.segmentId)).limit(1)
      : [];
    // "Delivered" counts every email that reached the inbox (deliveredEmail).
    // Opened likewise includes clicked; both count people only, since a
    // prefetch never lifts the status (see the tracking recorder).
    const ev = schema.emailEvents;
    // Nested: a single-table select writes the columns it holds directly
    // unqualified, and a bare "id" in the subquery would be the event's own.
    const ofEmail = sql`${ev.emailId} = ${e.id}`;
    const [stats] = await ctx.db
      .select({
        total: sql<number>`count(*)::int`,
        delivered: sql<number>`count(*) filter (where ${deliveredEmail})::int`,
        opened: sql<number>`count(*) filter (where ${e.latestStatus} in ('opened', 'clicked'))::int`,
        clicked: sql<number>`count(*) filter (where ${e.latestStatus} = 'clicked')::int`,
        prefetched: sql<number>`count(*) filter (where exists (select 1 from ${ev} where ${ofEmail} and ${ev.type} = 'prefetched'))::int`,
        bounced: sql<number>`count(*) filter (where ${e.latestStatus} = 'bounced')::int`,
        complained: sql<number>`count(*) filter (where ${complainedEmail})::int`,
        // Recipients who opted out through this email's link, from everything or from its topic.
        unsubscribed: sql<number>`count(*) filter (where exists (select 1 from ${ev} where ${ofEmail} and ${ev.type} = 'unsubscribed'))::int`,
      })
      .from(e)
      .where(and(eq(e.broadcastId, row.id), eq(e.teamId, ctx.teamId)));
    const live = stats && stats.total > 0 ? stats : null;
    const progress =
      row.status === "sending"
        ? (await sendingProgress(ctx.db, ctx.teamId)).get(row.id)
        : undefined;
    // Parked rows with no room under the team's own cap wait for its reset, not for capacity.
    const planHold =
      progress && progress.parkedCount > 0 ? await planHoldUntil(ctx.db, ctx.teamId) : null;
    // The planner knows nothing of a region hold: its forecast would be wrong while one lasts.
    const held = (await heldBroadcastIds(ctx.db, ctx.teamId, [row])).has(row.id);
    const warmup =
      progress?.warmup && progress.parkedCount > 0
        ? await broadcastWarmup(ctx.db, ctx.teamId, progress.warmup, row.scheduledAt)
        : null;
    return {
      ...row,
      hiddenBySupportView,
      held,
      warmup: warmup && { ...warmup, domain: parseSingleSender(row.from)?.domain ?? null },
      sentCount: progress?.sentCount ?? null,
      parkedCount: progress?.parkedCount ?? null,
      finishesAt: held ? null : (progress?.finishesAt ?? null),
      releases: held ? [] : (progress?.releases ?? []),
      sent: progress?.sent ?? [],
      newDomainLimit: held ? null : (progress?.newDomainLimit ?? null),
      startedAt: row.status === "sending" ? row.scheduledAt : null,
      planHold: planHold ? { resumesAt: planHold } : null,
      replyTo: firstReplyTo(row.replyTo),
      topicName: topic?.name ?? null,
      segmentName: segment?.name ?? null,
      // Live counts while any email row still exists; the counts recorded
      // before the rows aged out stand in once they are gone.
      stats: {
        total:
          row.recipientCount ??
          (row.status === "sending"
            ? Math.max(row.audienceCount ?? 0, live?.total ?? 0)
            : (live?.total ?? 0)),
        delivered: live?.delivered ?? row.deliveredCount ?? 0,
        // Engagement keeps arriving after the send, so no snapshot could
        // stand in once the rows age out: null past the metadata window,
        // zero before any fan-out (recipientCount is set when a send ends).
        opened: live?.opened ?? (row.recipientCount ? null : 0),
        clicked: live?.clicked ?? (row.recipientCount ? null : 0),
        prefetched: live?.prefetched ?? (row.recipientCount ? null : 0),
        bounced: live?.bounced ?? row.bouncedCount ?? 0,
        complained: live?.complained ?? row.complainedCount ?? 0,
        unsubscribed: live?.unsubscribed ?? (row.recipientCount ? null : 0),
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
   * `warmup` turns the sender domain's warm-up on first, which any member
   * may as part of sending; `skipInactive` is this send's own choice for
   * its inactive contacts, never the domain's setting.
   */
  send: teamProcedure
    .input(
      z.object({
        id: z.uuid(),
        scheduledAt: z.date().optional(),
        warmup: z.boolean().optional(),
        skipInactive: z.boolean().optional(),
      }),
    )
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
      const reserved = reservedSenderRefusal(row.from, env.ONBOARDING_EMAIL_FROM);
      if (reserved) throw new TRPCError({ code: "PRECONDITION_FAILED", message: reserved.message });
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
      const guardError = (await sendGuard(ctx)) ?? (await regionGuard(ctx.db, sender.region));
      if (guardError) throw guardError;
      const scheduledAt = input.scheduledAt ?? new Date();
      // Same horizon as the API: a body must not sit out the retention purge.
      if (scheduledAt.getTime() > Date.now() + MAX_SCHEDULE_AHEAD_DAYS * DAY_MS) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Broadcasts can be scheduled at most ${MAX_SCHEDULE_AHEAD_DAYS} days ahead.`,
        });
      }
      const count = await countAudience(ctx, row);
      const ramp = await warmupSendPlan(ctx.db, {
        teamId: ctx.teamId,
        domainId: sender.domainId,
        segmentId: row.segmentId,
        topicId: row.topicId,
        count,
        at: scheduledAt,
        skipInactive: input.skipInactive,
        enabling: input.warmup,
      });
      const live = ramp?.status === "warming" || ramp?.status === "paused";
      const byWarmup = ramp !== null && (live || input.warmup === true);
      // A warm-up's send goes out by its day, never on capacity: its own plan meets the horizon.
      if (byWarmup) {
        if (ramp.blocked) throw await warmupHorizonError(ramp.horizonDays);
        if (!live) await enableWarmup(ctx.db, { teamId: ctx.teamId, domainId: sender.domainId });
      } else {
        const horizonError = await horizonGuard(ctx, sender.region, count, scheduledAt);
        if (horizonError) throw horizonError;
      }
      const b = schema.broadcasts;
      // status filter re-checked in the UPDATE so two concurrent sends cannot
      // both flip the row.
      const [updated] = await ctx.db
        .update(b)
        .set({
          status: "scheduled",
          scheduledAt,
          updatedAt: new Date(),
          warmupSkipInactive: byWarmup ? (input.skipInactive ?? null) : null,
        })
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
        subject: subjectSchema,
        html: z.string().max(500_000).nullable(),
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
      const reserved = reservedSenderRefusal(input.from, env.ONBOARDING_EMAIL_FROM);
      if (reserved) throw new TRPCError({ code: "PRECONDITION_FAILED", message: reserved.message });
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
      const guardError = (await sendGuard(ctx)) ?? (await regionGuard(ctx.db, sender.region));
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
      const contact: MergeContact = {
        email: to,
        ...splitPersonName(ctx.session.user.name),
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
        inboxSendDeps(ctx),
        {
          teamId: ctx.teamId,
          billing: await fetchQuotaRow(ctx.db, ctx.teamId),
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
        { actor: userActor(ctx) },
      );
      if (!result.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: result.reason });
      if (!result.parked) return { to, hold: null };
      // Parked: the composer says so instead of "sent", naming only the new
      // domain limit; any other hold reads as a plain wait.
      const [row] = await ctx.db
        .select({ byLimit: sql<boolean>`${heldByNewDomainLimit()}` })
        .from(e)
        .where(and(eq(e.id, result.id), eq(e.teamId, ctx.teamId)));
      return {
        to,
        hold: row?.byLimit
          ? { kind: "domain_limit" as const, domain: sender.fromDomain }
          : { kind: "waiting" as const },
      };
    }),

  /**
   * Scheduled → canceled before the fan-out; sending → canceled stops the
   * rest: the fan-out's heartbeat sees the flip within a page, and every row
   * still waiting is canceled in pages. Emails already sent are not recalled.
   */
  cancel: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await getOwnBroadcast(ctx, input.id);
    const b = schema.broadcasts;
    const [updated] = await ctx.db
      .update(b)
      .set({ status: "canceled", updatedAt: new Date() })
      .where(
        and(
          eq(b.id, input.id),
          eq(b.teamId, ctx.teamId),
          inArray(b.status, ["scheduled", "sending"]),
        ),
      )
      .returning({ id: b.id });
    if (!updated) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Only scheduled or sending broadcasts can be canceled.",
      });
    }
    const canceledRemaining = await cancelBroadcastRows(ctx.db, {
      broadcastId: input.id,
      teamId: ctx.teamId,
    });
    return { id: input.id, canceledRemaining };
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
    .query(async ({ ctx, input }) => ({ count: await countAudience(ctx, input) })),

  /**
   * The send dialog's plan: the audience count and, when SES has answered,
   * how the send goes out (first wave, later days, the finish, a plan hold).
   * With the sender domain warming up (or paused, or a send far past its
   * best day), what its warm-up would do, `skipInactive` overriding its
   * inactive skip. Advisory: the send mutation runs the same planners for
   * the refusal.
   */
  sendPlan: teamProcedure
    .input(
      z.object({
        topicId: z.uuid().nullable().optional(),
        segmentId: z.uuid().nullable().optional(),
        from: z.string().trim().max(320),
        scheduledAt: z.date().optional(),
        skipInactive: z.boolean().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const cloud = isCloudDeployment();
      const count = await countAudience(ctx, input);
      const sender = await verifySenderDomain(ctx.db, ctx.teamId, input.from);
      if (!sender.ok || count === 0) return { count, cloud, estimate: null, warmup: null };
      const at = input.scheduledAt ?? new Date();
      const warmup = await warmupSendPlan(ctx.db, {
        teamId: ctx.teamId,
        domainId: sender.domainId,
        segmentId: input.segmentId ?? null,
        topicId: input.topicId ?? null,
        count,
        at,
        skipInactive: input.skipInactive,
      });
      // A live warm-up sets the pace alone; a risky send offers both.
      const live = warmup?.status === "warming" || warmup?.status === "paused";
      const plan = live
        ? null
        : await planBroadcastSend(ctx.db, {
            teamId: ctx.teamId,
            region: sender.region,
            newSend: { count, at, domainId: sender.domainId },
          });
      return {
        count,
        cloud,
        estimate: plan?.estimate ?? null,
        warmup: warmup && { ...warmup, domain: sender.fromDomain },
      };
    }),

  /** The broadcast's sends by recipient mailbox provider, for the detail page's table. */
  providers: teamProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    await getOwnBroadcast(ctx, input.id);
    return broadcastProviderBreakdown(ctx.db, { teamId: ctx.teamId, broadcastId: input.id });
  }),
});
