import { env, receivingEnabled } from "@millionsend/config";
import {
  deriveReceivedDownloadKey,
  RECEIVED_EMAIL_META_COLUMNS,
  type ReceivedEmailDetail,
  receivedEmailDetail,
  receivedEmailScope,
  signReceivedDownload,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { apiBaseUrl } from "@/lib/api-base-url";
import { getKeyring } from "../keyring";
import { beforeCursor, createdAtCursorField, cursorSchema, paginate } from "../keyset";
import { router, teamProcedure } from "../trpc";

/** Without RECEIVING_MX_HOST the instance takes no mail, and these read as routes that do not exist. */
const receivingProcedure = teamProcedure.use(({ next }) => {
  if (!receivingEnabled()) throw new TRPCError({ code: "NOT_FOUND" });
  return next();
});

export const receivingRouter = router({
  list: receivingProcedure
    .input(
      z.object({
        cursor: cursorSchema.optional(),
        limit: z.number().int().min(1).max(50).default(25),
      }),
    )
    .query(async ({ ctx, input }) => {
      const r = schema.receivedEmails;
      const scope = receivedEmailScope({ teamId: ctx.teamId });
      // Counted on the first page only; later pages keep reading pages[0].total.
      const [count] = input.cursor
        ? []
        : await ctx.db.select({ n: sql<number>`count(*)::int` }).from(r).where(scope);
      // Metadata columns only: a row's sealed raw message runs to 40 MiB.
      const rows = await ctx.db
        .select({
          id: r.id,
          from: r.from,
          receivedFor: r.receivedFor,
          subject: r.subject,
          authentication: r.authentication,
          attachmentCount: r.attachmentCount,
          createdAt: r.createdAt,
          cursorCreatedAt: createdAtCursorField(r),
        })
        .from(r)
        .where(input.cursor ? and(scope, beforeCursor(r, input.cursor)) : scope)
        .orderBy(desc(r.createdAt), desc(r.id))
        .limit(input.limit + 1);
      return { ...paginate(rows, input.limit), total: input.cursor ? null : (count?.n ?? 0) };
    }),

  get: receivingProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const r = schema.receivedEmails;
    const where = and(eq(r.id, input.id), receivedEmailScope({ teamId: ctx.teamId }));
    const [row] = await ctx.db.select(RECEIVED_EMAIL_META_COLUMNS).from(r).where(where).limit(1);
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });

    // A support view reads the envelope, never the message: the sealed raw
    // message is not even selected, and no download link is signed.
    const hiddenBySupportView = Boolean(ctx.supportView);
    let detail: ReceivedEmailDetail | null = null;
    let attachments: {
      id: string;
      filename: string | null;
      contentType: string;
      size: number;
      inline: boolean;
      downloadUrl: string;
    }[] = [];
    const [sealed] = hiddenBySupportView
      ? []
      : await ctx.db
          .select({
            rawCiphertext: r.rawCiphertext,
            rawIv: r.rawIv,
            rawWrappedDek: r.rawWrappedDek,
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
          downloadUrl: signReceivedDownload({
            ...downloads,
            teamId: row.teamId,
            emailId: row.id,
            attachmentId: a.id,
          }).url,
        }));
      } catch {
        // Undecryptable (corrupt ciphertext, unknown KEK version) reads as no
        // content: the envelope and verdicts are still worth showing.
      }
    }

    // Whitelisted shape: the sealed columns never reach the client.
    return {
      id: row.id,
      from: row.from,
      to: row.to,
      cc: row.cc,
      replyTo: row.replyTo,
      receivedFor: row.receivedFor,
      subject: row.subject,
      messageId: row.messageId,
      sizeBytes: row.sizeBytes,
      attachmentCount: row.attachmentCount,
      authentication: row.authentication,
      envelope: row.envelope,
      createdAt: row.createdAt,
      contentPurgedAt: row.contentPurgedAt,
      html: detail?.html ?? null,
      text: detail?.text ?? null,
      headers: detail?.headers ?? null,
      rawUrl: detail?.raw?.download_url ?? null,
      attachments,
      hiddenBySupportView,
    };
  }),
});
