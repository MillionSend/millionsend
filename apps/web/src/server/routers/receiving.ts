import { clamavHost, env, receivingMxHost, sharedInboxDomain } from "@millionsend/config";
import {
  deleteReceivedEmail,
  deriveReceivedDownloadKey,
  forwardReceivedEmail,
  hiddenTextRemoved,
  MAX_RECEIVED_MESSAGE_BYTES,
  openReceivedExtracted,
  RECEIVED_EMAIL_META_COLUMNS,
  type ReceivedEmailDetail,
  type ReceivedExtracted,
  receivedEmailDetail,
  receivedEmailScope,
  recordInboxActivity,
  releaseQuarantined,
  replyToReceivedEmail,
  signReceivedDownload,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, gte, inArray, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { apiBaseUrl } from "@/lib/api-base-url";
import { escapeLike } from "@/lib/sql";
import { fetchQuotaRow } from "../billing";
import {
  actorNames,
  forwardQuietly,
  inboxSendDeps,
  releaseFailure,
  sendResult,
  userActor,
} from "../inboxes";
import { getKeyring } from "../keyring";
import { beforeCursor, createdAtCursorField, cursorSchema, paginate } from "../keyset";
import {
  adminProcedure,
  operatorProcedure,
  receivingOnly,
  receivingProcedure,
  router,
} from "../trpc";

/** The verdicts the All received list filters on, as the dashboard names them. */
const VERDICT_FILTERS = ["clean", "suspicious", "quarantined", "spam", "virus"] as const;

const r = schema.receivedEmails;
const m = schema.receivedEmailInboxes;

/**
 * A membership (alias m) of the row. A one-table select renders its columns
 * unqualified, which inside a subquery would bind to the subquery's table:
 * the outer row is named in full.
 */
const membershipWhere = (where: SQL) =>
  sql`exists (select 1 from ${m} m where m.received_email_id = ${r}."id" and ${where})`;

const verdictFilter: Record<(typeof VERDICT_FILTERS)[number], SQL> = {
  virus: sql`${r.virusVerdict} = 'fail'`,
  spam: sql`${r.spamVerdict} = 'fail'`,
  quarantined: membershipWhere(sql`m.verdict = 'quarantined'`),
  suspicious: membershipWhere(sql`m.verdict = 'suspicious'`),
  // Clean as the row's tile reads it (lib/received-state.ts): a scanner that
  // failed is not clean, and no scanner at all is.
  clean: sql`(${r.virusVerdict} is null or ${r.virusVerdict} = 'pass') and ${r.spamVerdict} is distinct from 'fail' and not ${membershipWhere(sql`m.verdict in ('pending', 'suspicious', 'quarantined')`)}`,
};

const recipients = z.array(z.email()).max(50);

export const receivingRouter = router({
  list: receivingProcedure
    .input(
      z.object({
        cursor: cursorSchema.optional(),
        limit: z.number().int().min(1).max(50).default(25),
        search: z.string().trim().max(200).optional(),
        since: z.date().optional(),
        // An inbox id, or mail that reached an address without an inbox.
        inbox: z.union([z.uuid(), z.literal("catch_all")]).optional(),
        verdict: z.enum(VERDICT_FILTERS).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const pattern = input.search ? `%${escapeLike(input.search)}%` : null;
      const where = and(
        receivedEmailScope({ teamId: ctx.teamId, held: "include" }),
        input.inbox === "catch_all"
          ? eq(r.catchAll, true)
          : input.inbox
            ? membershipWhere(sql`m.inbox_id = ${input.inbox}`)
            : undefined,
        input.verdict ? verdictFilter[input.verdict] : undefined,
        input.since ? gte(r.createdAt, input.since) : undefined,
        pattern
          ? or(
              sql`${r.from} ilike ${pattern}`,
              sql`${r.fromName} ilike ${pattern}`,
              sql`${r.subject} ilike ${pattern}`,
              sql`${r.receivedFor}::text ilike ${pattern}`,
            )
          : undefined,
      );
      // Counted on the first page only; later pages keep reading pages[0].total.
      const [total] = input.cursor ? [] : await ctx.db.select({ n: count() }).from(r).where(where);
      // Each row's screening across the inboxes it reached, one aggregate per
      // row: still running, quarantined, or let in as suspicious by any of them.
      const screening = ctx.db
        .select({
          pending: sql<boolean>`coalesce(bool_or(${m.verdict} = 'pending'), false)`.as("pending"),
          quarantined: sql<boolean>`coalesce(bool_or(${m.verdict} = 'quarantined'), false)`.as(
            "quarantined",
          ),
          suspicious: sql<boolean>`coalesce(bool_or(${m.verdict} = 'suspicious'), false)`.as(
            "suspicious",
          ),
        })
        .from(m)
        .where(eq(m.receivedEmailId, r.id))
        .as("screening");
      // Metadata columns only: a row's sealed raw message runs to 40 MiB.
      const rows = await ctx.db
        .select({
          id: r.id,
          from: r.from,
          fromName: r.fromName,
          receivedFor: r.receivedFor,
          subject: r.subject,
          attachmentCount: r.attachmentCount,
          // Which kinds were found, never the values: a code shows only on the detail page.
          extractedKinds: r.extractedKinds,
          spamVerdict: r.spamVerdict,
          virusVerdict: r.virusVerdict,
          pending: screening.pending,
          quarantined: screening.quarantined,
          suspicious: screening.suspicious,
          createdAt: r.createdAt,
          cursorCreatedAt: createdAtCursorField(r),
        })
        .from(r)
        .crossJoinLateral(screening)
        .where(input.cursor ? and(where, beforeCursor(r, input.cursor)) : where)
        .orderBy(desc(r.createdAt), desc(r.id))
        .limit(input.limit + 1);
      return { ...paginate(rows, input.limit), total: input.cursor ? null : (total?.n ?? 0) };
    }),

  get: receivingProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const where = and(
      eq(r.id, input.id),
      receivedEmailScope({ teamId: ctx.teamId, held: "include" }),
    );
    const [row] = await ctx.db.select(RECEIVED_EMAIL_META_COLUMNS).from(r).where(where).limit(1);
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });

    const i = schema.inboxes;
    const memberships = await ctx.db
      .select({
        inboxId: m.inboxId,
        address: i.emailAddress,
        kind: i.kind,
        extractCodes: sql<boolean>`coalesce((${i.safety}->>'extract_codes')::boolean, false)`,
        threadId: m.threadId,
        verdict: m.verdict,
        senderTrust: m.senderTrust,
        quarantineReason: m.quarantineReason,
        reasons: m.reasons,
        injectionScore: m.injectionScore,
        phishingScore: m.phishingScore,
        deliveredAt: m.deliveredAt,
        quarantinedAt: m.quarantinedAt,
        releasedAt: m.releasedAt,
        releasedBy: m.releasedBy,
      })
      .from(m)
      .innerJoin(i, eq(i.id, m.inboxId))
      .where(and(eq(m.receivedEmailId, row.id), eq(m.teamId, ctx.teamId)))
      .orderBy(asc(i.createdAt));
    const virus = row.virusVerdict === "fail";
    // A virus-held catch-all row belongs to no inbox: the row itself is released.
    const heldCatchAll = virus && row.catchAll && row.releasedAt === null;

    // A support view reads the envelope, never the message: the sealed raw
    // message is not even selected, and no download link is signed.
    const hiddenBySupportView = Boolean(ctx.supportView);
    let detail: ReceivedEmailDetail | null = null;
    let extracted: ReceivedExtracted | null = null;
    let attachments: {
      id: string;
      filename: string | null;
      contentType: string;
      size: number;
      inline: boolean;
      /** Null while the message carries malware: its downloads are blocked. */
      downloadUrl: string | null;
    }[] = [];
    const [sealed] = hiddenBySupportView
      ? []
      : await ctx.db
          .select({
            rawCiphertext: r.rawCiphertext,
            rawIv: r.rawIv,
            rawWrappedDek: r.rawWrappedDek,
            extracted: r.extracted,
          })
          .from(r)
          .where(where);
    if (sealed) {
      const downloads = {
        key: deriveReceivedDownloadKey(Buffer.from(env.MASTER_ENCRYPTION_KEY ?? "", "base64")),
        baseUrl: apiBaseUrl(),
      };
      try {
        detail = await receivedEmailDetail({ ...row, ...sealed }, getKeyring(), {
          htmlFormat: "data_uri",
          downloads,
        });
        attachments = detail.attachments.map((a) => ({
          id: a.id,
          filename: a.filename,
          contentType: a.content_type,
          size: a.size,
          inline: a.content_disposition === "inline",
          downloadUrl: virus
            ? null
            : signReceivedDownload({
                ...downloads,
                teamId: row.teamId,
                emailId: row.id,
                attachmentId: a.id,
              }).url,
        }));
        extracted = await openReceivedExtracted(
          { ...row, extracted: sealed.extracted },
          getKeyring(),
        );
      } catch {
        // Undecryptable (corrupt ciphertext, unknown KEK version) reads as no
        // content: the envelope and verdicts are still worth showing.
      }
    }

    // A code or sign-in link shows only where an agent could read it too:
    // not from held mail, the failed tier, or an inbox that turned extraction off.
    const delivered = memberships.filter((x) => x.deliveredAt !== null && x.verdict !== "pending");
    const codesAllowed =
      row.senderTrust !== "failed" &&
      !virus &&
      (memberships.length === 0 ? row.catchAll : delivered.some((x) => x.extractCodes));
    const code =
      codesAllowed && extracted?.code && "value" in extracted.code ? extracted.code.value : null;
    const link = codesAllowed && extracted?.link && "url" in extracted.link ? extracted.link : null;
    const readBy = delivered.find((x) => x.extractCodes);
    if ((code || link) && readBy) {
      await recordInboxActivity(ctx.db, {
        teamId: ctx.teamId,
        inboxId: readBy.inboxId,
        actor: userActor(ctx),
        action: "code.read",
        emailId: row.id,
      });
    }

    const a = schema.inboxActivity;
    const e = schema.emails;
    // A reply is recorded under the email it sent, which names this one in In-Reply-To.
    const threadIds = [...new Set(memberships.map((x) => x.threadId))];
    const replies =
      row.messageId && threadIds.length > 0
        ? ctx.db
            .select({ id: e.id })
            .from(e)
            .where(
              and(
                inArray(e.threadId, threadIds),
                eq(e.teamId, ctx.teamId),
                sql`${e.headers}->>'In-Reply-To' = ${row.messageId}`,
              ),
            )
        : null;
    const activity = await ctx.db
      .select({ action: a.action, actor: a.actor, createdAt: a.createdAt })
      .from(a)
      .where(
        and(
          eq(a.teamId, ctx.teamId),
          or(
            and(eq(a.emailId, row.id), inArray(a.action, ["email.released", "email.forwarded"])),
            replies ? and(eq(a.action, "email.sent"), inArray(a.emailId, replies)) : undefined,
          ),
        ),
      )
      .orderBy(asc(a.createdAt))
      .limit(20);
    const names = await actorNames(ctx.db, ctx.teamId, [
      ...activity.map((x) => x.actor),
      ...memberships.map((x) => x.releasedBy ?? ""),
    ]);
    const d = schema.webhookDeliveries;
    const w = schema.webhookEndpoints;
    // Retention strips payloads, and with them this lookup: an old email shows no webhook step.
    const [webhook] = await ctx.db
      .select({ status: d.status, responseCode: d.lastResponseCode, at: d.createdAt })
      .from(d)
      .innerJoin(w, eq(w.id, d.endpointId))
      .where(
        and(
          eq(w.teamId, ctx.teamId),
          eq(d.eventType, "email.received"),
          gte(d.createdAt, row.createdAt),
          sql`${d.payload}->'data'->>'email_id' = ${row.id}`,
        ),
      )
      .orderBy(asc(d.createdAt))
      .limit(1);

    // Whitelisted shape: the sealed columns never reach the client.
    return {
      id: row.id,
      from: row.from,
      fromName: row.fromName,
      to: row.to,
      cc: row.cc,
      replyTo: row.replyTo,
      receivedFor: row.receivedFor,
      subject: row.subject,
      messageId: row.messageId,
      sizeBytes: row.sizeBytes,
      attachmentCount: row.attachmentCount,
      authentication: row.authentication,
      authDetail: row.authDetail,
      senderTrust: row.senderTrust,
      spam: { verdict: row.spamVerdict, score: row.spamScore, reasons: row.spamReasons },
      virus: { verdict: row.virusVerdict, signature: row.virusSignature },
      hiddenTextRemoved: hiddenTextRemoved(row.hiddenText),
      catchAll: row.catchAll,
      heldCatchAll,
      envelope: row.envelope,
      createdAt: row.createdAt,
      contentPurgedAt: row.contentPurgedAt,
      memberships: memberships.map(({ extractCodes: _codes, releasedBy: _by, ...x }, index) => ({
        ...x,
        releasedByName: names[activity.length + index]?.name ?? null,
      })),
      extracted: hiddenBySupportView
        ? null
        : {
            kinds: row.extractedKinds,
            code,
            link: link ? { url: link.url, matchesSender: link.linkDomainMatchesSender } : null,
          },
      activity: activity.map((x, index) => ({
        action: x.action,
        at: x.createdAt,
        by: names[index]?.name ?? null,
      })),
      webhook: webhook ?? null,
      html: detail?.html ?? null,
      text: detail?.text ?? null,
      headers: detail?.headers ?? null,
      rawUrl: virus ? null : (detail?.raw?.download_url ?? null),
      attachments,
      hiddenBySupportView,
    };
  }),

  /** Releases a virus-held catch-all row; quarantined inbox mail goes through inboxes.quarantine. */
  release: receivingProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const result = await releaseQuarantined(
      ctx.db,
      {
        enqueueWebhookDeliveries: ctx.enqueueWebhookDeliveries,
        enqueueInboxForward: forwardQuietly,
      },
      {
        teamId: ctx.teamId,
        receivedEmailId: input.id,
        inboxId: null,
        actor: userActor(ctx),
        trustSender: false,
      },
    );
    if (!result.ok) throw releaseFailure(result.reason);
    return { releasedAt: result.releasedAt };
  }),

  delete: adminProcedure
    .use(receivingOnly)
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await deleteReceivedEmail(ctx.db, {
        teamId: ctx.teamId,
        id: input.id,
        actor: userActor(ctx),
      });
      if (!deleted) throw new TRPCError({ code: "NOT_FOUND" });
      return { id: input.id };
    }),

  reply: receivingProcedure
    .input(
      z.object({
        id: z.uuid(),
        text: z.string().min(1).max(1_000_000),
        replyAll: z.boolean().optional(),
        inboxId: z.uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      sendResult(
        await replyToReceivedEmail(ctx.db, inboxSendDeps(ctx), {
          teamId: ctx.teamId,
          billing: await fetchQuotaRow(ctx.db, ctx.teamId),
          actor: userActor(ctx),
          receivedEmailId: input.id,
          body: { text: input.text, reply_all: input.replyAll, inbox_id: input.inboxId },
        }),
      ),
    ),

  forward: receivingProcedure
    .input(
      z.object({
        id: z.uuid(),
        to: recipients.min(1),
        text: z.string().max(1_000_000).optional(),
        mode: z.enum(["inline", "attachment"]).default("inline"),
        inboxId: z.uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      sendResult(
        await forwardReceivedEmail(ctx.db, inboxSendDeps(ctx), {
          teamId: ctx.teamId,
          billing: await fetchQuotaRow(ctx.db, ctx.teamId),
          actor: userActor(ctx),
          receivedEmailId: input.id,
          body: {
            to: input.to,
            text: input.text || undefined,
            mode: input.mode,
            inbox_id: input.inboxId,
          },
        }),
      ),
    ),

  /** Settings → Receiving: the instance's own intake, for its operator only. */
  health: operatorProcedure.use(receivingOnly).query(async ({ ctx }) => {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const [today] = await ctx.db.select({ n: count() }).from(r).where(gte(r.createdAt, dayStart));
    const [last] = await ctx.db
      .select({ at: r.createdAt })
      .from(r)
      .orderBy(desc(r.createdAt))
      .limit(1);
    return {
      mxHost: receivingMxHost() ?? null,
      lastMessageAt: last?.at ?? null,
      receivedToday: today?.n ?? 0,
      clamavHost: clamavHost() ?? null,
      sharedInboxDomain: sharedInboxDomain() ?? null,
      maxSizeBytes: MAX_RECEIVED_MESSAGE_BYTES,
    };
  }),
});
