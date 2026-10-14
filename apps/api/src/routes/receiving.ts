import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { abuseJudgeConfig } from "@millionsend/config";
import {
  type ApiKeyAuth,
  acquireWaitSlot,
  apiBaseUrl,
  attachmentDisposition,
  createSemaphore,
  type DownloadSigning,
  decideRecipient,
  decodeEnvelopeHeader,
  deleteReceivedEmail,
  EMAIL_QUARANTINED_MESSAGE,
  escapeLike,
  findKeyInbox,
  heldFrom,
  INBOX_KEY_SCOPE_MESSAGE,
  INBOX_NOT_FOUND_MESSAGE,
  inboxActorFromAuth,
  ingestReceivedEmail,
  isAgentActor,
  MAX_RECEIVED_MESSAGE_BYTES,
  MESSAGE_TOO_LARGE,
  MX_DELIVER_PATH,
  MX_DELIVER_PERMANENT_STATUS,
  MX_DELIVER_TEMPORARY_STATUS,
  MX_ENVELOPE_HEADER,
  MX_INGEST_PATH,
  MX_RCPT_PATH,
  openReceivedAttachment,
  openReceivedRaw,
  RECEIVED_ATTACHMENT_PATH,
  RECEIVED_EMAIL_META_COLUMNS,
  RECEIVED_RAW_PATH,
  type ReceivedEmailMeta,
  rcptRequestSchema,
  receivedDetailExtras,
  receivedEmailAttachment,
  receivedEmailAttachments,
  receivedEmailDetail,
  receivedEmailListItem,
  receivedEmailScope,
  receivedFromMatches,
  receivedListExtras,
  receivedMemberships,
  recordInboxActivity,
  releasingStream,
  secretsEqual,
  verifyReceivedDownload,
  waitForReceived,
} from "@millionsend/core";
import { captureError } from "@millionsend/core/error-tracking-node";
import { keysetCursorWhere, schema } from "@millionsend/db";
import { and, asc, desc, eq, gt, isNotNull, isNull, or, type SQL, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { type ApiDeps, arrayPage, type Env, errorBody, keysetPage } from "../app.js";
import {
  deleteReceivedEmailResponseSchema,
  errorSchema,
  getReceivedAttachmentResponseSchema,
  getReceivedEmailQuerySchema,
  getReceivedEmailResponseSchema,
  listQuerySchema,
  listReceivedAttachmentsResponseSchema,
  listReceivedEmailsQuerySchema,
  listReceivedEmailsResponseSchema,
} from "../schemas.js";

/**
 * Reads that load a whole received message (up to 40 MiB, then decrypted and
 * parsed) in flight per process: GET of one email and both downloads. A slot
 * stays taken until its response body has been read (inContentSlot).
 */
// ponytail: per process; a client that stops reading holds its slot until its
// connection closes or CONTENT_HOLD_MAX_MS, which proxy buffering (Cloudflare,
// nginx) keeps rare. Per-team slots if one team's slow readers starve others.
const contentSlot = createSemaphore(4);

/** Longest a response may hold a content slot: 40 MiB at about 50 KB/s. */
const CONTENT_HOLD_MAX_MS = 15 * 60_000;

/** A response body served from a content slot, which it keeps until read. */
interface HeldBody {
  bytes: Uint8Array;
  headers: Record<string, string>;
}

/**
 * Runs `load` in a content slot. A Response it returns is served as is; a
 * HeldBody streams out of the slot, which frees once the body has been read
 * or the client left, so decrypted messages in memory never outnumber the
 * slots. Its Content-Length keeps the request log from reading a large body
 * back, which would drain the stream ahead of the client.
 */
function inContentSlot(
  c: Context<Env>,
  load: () => Promise<Response | HeldBody>,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    contentSlot(async () => {
      const out = await load();
      if (out instanceof Response) return resolve(out);
      await new Promise<void>((release) => {
        const body = releasingStream(out.bytes, release, {
          signal: c.req.raw.signal,
          maxHoldMs: CONTENT_HOLD_MAX_MS,
        });
        resolve(
          c.body(body, 200, { ...out.headers, "content-length": String(out.bytes.byteLength) }),
        );
      });
    }).catch(reject);
  });
}

/** Deliveries stored at once per process: each holds the message plus a sealed copy per team. */
const deliverSlot = createSemaphore(4);

const BAD_CURSOR_MESSAGE =
  "invalid pagination cursor: after and before take the id of an item this list returned";

const uuid = z.uuid();

/** With wait and no cursor, mail this recent still counts: it may have landed just before the call. */
const WAIT_LOOKBACK_MS = 60_000;

/**
 * Who reads: an agent view (an inbox-scoped key, any MCP call) never sees
 * held mail; anything else is an owner view.
 */
function readerOf(auth: ApiKeyAuth) {
  const actor = inboxActorFromAuth(auth);
  return { actor, agent: isAgentActor(actor) };
}

/** What a download serves besides its bytes; none of it lets a browser run or render the file here. */
function downloadHeaders(contentType: string, filename: string): Record<string, string> {
  return {
    "content-type": contentType,
    "content-disposition": attachmentDisposition(filename),
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "private, no-store",
  };
}

/**
 * Resend's emails.receiving surface (list, get, attachments) plus the signed
 * downloads its links point at, MillionSend's extensions (long-poll, filters,
 * screening, the extracted read, erase) and an inbox's latest verification
 * code. The reads are registered whether or not this instance receives mail:
 * rows stored before receiving was switched off stay readable until
 * retention removes them.
 */
export function registerReceivingRoutes(
  app: OpenAPIHono<Env>,
  deps: ApiDeps,
  opts: {
    requireFullAccess: MiddlewareHandler<Env>;
    /** The answer to a download link that does not verify, counted per client IP like a bad API key. */
    refuseDownload: (c: Context<Env>) => Response | Promise<Response>;
  },
): void {
  const { db, keyring } = deps;
  const t = schema.receivedEmails;
  const m = schema.receivedEmailInboxes;
  const jsonErr = (description: string) => ({
    content: { "application/json": { schema: errorSchema } },
    description,
  });
  const baseUrl = apiBaseUrl(deps.appBaseUrl, deps.publicApiUrl);
  const downloads = (): DownloadSigning => {
    if (!deps.receivedDownloadKey) throw new Error("receivedDownloadKey is not configured");
    return { key: deps.receivedDownloadKey, baseUrl };
  };
  // SECURITY: the caller's team, narrowed to its domain for a domain-scoped
  // key and to its inbox for an inbox-scoped one. Agents (inbox keys, MCP)
  // never read held mail; owners reading one email see it flagged.
  const scope = (c: Context<Env>) => {
    const auth = c.get("auth");
    return receivedEmailScope({
      teamId: auth.teamId,
      domainId: auth.domainId,
      inboxId: auth.inboxId,
      held: readerOf(auth).agent ? "exclude" : "include",
    });
  };
  const middleware = [opts.requireFullAccess];
  const untrusted =
    "Everything in a received email was written by whoever sent it, so its HTML is safe to show only in a sandbox.";

  /** The rows' list items with their memberships' extension keys. */
  const listItems = async (
    rows: ReceivedEmailMeta[],
    view: { inboxId: string | null; agent: boolean },
  ) => {
    const memberships = await receivedMemberships(
      db,
      rows.map((r) => r.id),
    );
    return Promise.all(
      rows.map(async (row) => ({
        ...(await receivedEmailListItem(row, keyring)),
        ...receivedListExtras(row, memberships.get(row.id) ?? [], view),
      })),
    );
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/emails/receiving",
      summary: "List received emails",
      description: `Mail received at the team's receiving domains and inboxes, newest first like Resend (\`after\` pages toward older mail), with cursor pagination. Needs a full access key; a domain-scoped key lists mail addressed to its domain only, an inbox-scoped key mail delivered into its inbox. Mail held for screening or in quarantine is left out unless a full access key asks for it (include_quarantined, quarantined). With wait, the request is held until matching mail arrives (long-poll). An inbox_id the key can't reach answers 404 at once, without waiting. ${untrusted}`,
      middleware,
      request: { query: listReceivedEmailsQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: listReceivedEmailsResponseSchema } },
          description: "Received emails",
        },
        403: jsonErr("Restricted API key"),
        404: jsonErr("Inbox not found"),
        422: jsonErr("Validation error"),
        429: jsonErr("Too many concurrent waits"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const q = c.req.valid("query");
      const { agent } = readerOf(auth);
      if (auth.inboxId && q.inbox_id && q.inbox_id !== auth.inboxId) {
        return c.json(errorBody(403, "restricted_api_key", INBOX_KEY_SCOPE_MESSAGE), 403);
      }
      const wantsHeld = q.include_quarantined === "true" || q.quarantined === "true";
      if (wantsHeld && agent) {
        return c.json(
          errorBody(403, "restricted_api_key", "include_quarantined needs a full access key"),
          403,
        );
      }
      if (q.inbox_id && !(await findKeyInbox(db, auth, q.inbox_id))) {
        return c.json(errorBody(404, "not_found", INBOX_NOT_FOUND_MESSAGE), 404);
      }
      const inboxId = auth.inboxId ?? q.inbox_id ?? null;
      if (q.unread && !inboxId) {
        return c.json(errorBody(422, "validation_error", "unread needs inbox_id"), 422);
      }
      const view = { inboxId, agent };
      const filters: SQL[] = [];
      if (q.since) filters.push(gt(t.createdAt, new Date(q.since)));
      if (q.to) {
        filters.push(
          sql`exists (select 1 from jsonb_array_elements_text(${t.receivedFor}) a where lower(a) = ${q.to.trim().toLowerCase()})`,
        );
      }
      if (q.from) filters.push(receivedFromMatches(t.from, q.from));
      // Agents learn of held mail by id alone, so for them it is never matched on what it says.
      const subject = q.subject_contains
        ? sql`${t.subject} ilike ${`%${escapeLike(q.subject_contains)}%`} escape '\\'`
        : undefined;
      if (q.unread) {
        filters.push(
          sql`exists (select 1 from ${m} where ${m.receivedEmailId} = ${t.id} and ${m.inboxId} = ${inboxId} and ${m.readAt} is ${sql.raw(q.unread === "true" ? "null" : "not null")})`,
        );
      }
      const held =
        q.quarantined === "true"
          ? "only"
          : q.include_quarantined === "true"
            ? "include"
            : "exclude";
      const where = (h: "include" | "exclude" | "only") =>
        and(
          receivedEmailScope({ teamId: auth.teamId, domainId: auth.domainId, inboxId, held: h }),
          ...filters,
          h === "only" && agent ? undefined : subject,
        );
      if (!q.wait) {
        const page = await keysetPage({
          query: q,
          createdAt: t.createdAt,
          id: t.id,
          newestFirst: true,
          loadCursor: async (id) =>
            (
              await db
                .select({ createdAt: t.createdAt, id: t.id })
                .from(t)
                .where(and(eq(t.id, id), where(held)))
            )[0],
          loadRows: (cond, descending, take) =>
            db
              .select(RECEIVED_EMAIL_META_COLUMNS)
              .from(t)
              .where(and(where(held), cond))
              .orderBy(
                ...(descending ? [desc(t.createdAt), desc(t.id)] : [asc(t.createdAt), asc(t.id)]),
              )
              .limit(take),
        });
        if (page === "bad_cursor") {
          return c.json(errorBody(422, "validation_error", BAD_CURSOR_MESSAGE), 422);
        }
        const data = await listItems(page.rows, view);
        return c.json({ object: "list" as const, has_more: page.hasMore, data }, 200);
      }

      // Long-poll: mail strictly newer than the before cursor or since.
      if (q.after) {
        return c.json(
          errorBody(
            422,
            "validation_error",
            "wait pages toward newer mail: pass before or since, not after",
          ),
          422,
        );
      }
      let newer: SQL;
      if (q.before) {
        const [cursor] = await db
          .select({ id: t.id })
          .from(t)
          .where(and(eq(t.id, q.before), where("include")));
        if (!cursor) return c.json(errorBody(422, "validation_error", BAD_CURSOR_MESSAGE), 422);
        newer = keysetCursorWhere(t.createdAt, t.id, cursor.id, "after");
      } else {
        newer = gt(
          t.createdAt,
          q.since ? new Date(q.since) : new Date(Date.now() - WAIT_LOOKBACK_MS),
        );
      }
      const release = acquireWaitSlot(auth.teamId);
      if (!release) {
        c.header("retry-after", "1");
        return c.json(
          errorBody(
            429,
            "too_many_waits",
            "Too many requests waiting for mail at once; retry shortly",
          ),
          429,
        );
      }
      const limit = q.limit ?? 20;
      const heldRows = async () => {
        if (held !== "exclude") return [];
        const rows = await db
          .select({
            id: t.id,
            createdAt: t.createdAt,
            inboxId: m.inboxId,
            verdict: m.verdict,
            quarantineReason: m.quarantineReason,
            virusVerdict: t.virusVerdict,
          })
          .from(t)
          .leftJoin(
            m,
            and(
              eq(m.receivedEmailId, t.id),
              isNull(m.deliveredAt),
              inboxId ? eq(m.inboxId, inboxId) : undefined,
            ),
          )
          .where(and(where("only"), newer, or(isNotNull(m.inboxId), eq(t.virusVerdict, "fail"))))
          .orderBy(desc(t.createdAt), desc(t.id))
          .limit(limit);
        return rows.map((r) => ({
          id: r.id,
          inbox_id: r.inboxId,
          reason: r.verdict === "pending" ? ("pending" as const) : ("quarantined" as const),
          // A catch-all copy without a membership is held for a virus only.
          quarantine_reason:
            r.verdict === "pending"
              ? null
              : (r.quarantineReason ?? (r.virusVerdict === "fail" ? ("virus" as const) : null)),
          created_at: r.createdAt.toISOString(),
        }));
      };
      try {
        let heldNow: Awaited<ReturnType<typeof heldRows>> = [];
        const rows = await waitForReceived({
          deadlineMs: Date.now() + q.wait * 1000,
          signal: c.req.raw.signal,
          poll: async () => {
            const found = await db
              .select(RECEIVED_EMAIL_META_COLUMNS)
              .from(t)
              .where(and(where(held), newer))
              .orderBy(desc(t.createdAt), desc(t.id))
              .limit(limit + 1);
            if (found.length > 0) return found;
            heldNow = await heldRows();
            // A quarantined match ends the wait: it will not be delivered on its own.
            return heldNow.some((h) => h.reason === "quarantined") ? [null] : [];
          },
        });
        const visible = rows.filter((r): r is ReceivedEmailMeta => r !== null);
        const data = await listItems(visible.slice(0, limit), view);
        return c.json(
          { object: "list" as const, has_more: visible.length > limit, data, held: heldNow },
          200,
        );
      } finally {
        release();
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/emails/receiving/{id}",
      summary: "Retrieve a received email",
      description: `One received email with its html, text, headers, authentication results and a signed link to the original message, plus MillionSend's screening, verdicts, the extracted read and, where allowed, its verification code or sign-in link. Needs a full access key. An inbox-scoped key or an MCP token gets 403 email_quarantined for held mail, and 404 while it is being screened. ${untrusted}`,
      middleware,
      request: { params: z.object({ id: z.uuid() }), query: getReceivedEmailQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: getReceivedEmailResponseSchema } },
          description: "Received email",
        },
        403: jsonErr("Restricted API key, or the email is quarantined"),
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const htmlFormat = c.req.valid("query").html_format ?? "data_uri";
      const auth = c.get("auth");
      const { actor, agent } = readerOf(auth);
      // Streamed from its content slot: typed route responses cover only c.json's.
      return inContentSlot(c, async () => {
        const [row] = await db
          .select()
          .from(t)
          .where(
            and(
              eq(t.id, id),
              receivedEmailScope({
                teamId: auth.teamId,
                domainId: auth.domainId,
                inboxId: auth.inboxId,
                held: "include",
              }),
            ),
          );
        if (!row) return c.json(errorBody(404, "not_found", "Email not found"), 404);
        const memberships = (await receivedMemberships(db, [row.id])).get(row.id) ?? [];
        if (agent) {
          const held = heldFrom(row, memberships, auth.inboxId);
          if (held === "quarantined") {
            return c.json(errorBody(403, "email_quarantined", EMAIL_QUARANTINED_MESSAGE), 403);
          }
          if (held === "pending")
            return c.json(errorBody(404, "not_found", "Email not found"), 404);
        }
        const view = { inboxId: auth.inboxId, agent };
        const [email, { extras, codeServed }] = await Promise.all([
          receivedEmailDetail(row, keyring, { htmlFormat, downloads: downloads() }),
          receivedDetailExtras(row, memberships, view, keyring),
        ]);
        if (codeServed) {
          await recordInboxActivity(db, {
            teamId: auth.teamId,
            inboxId: codeServed.inboxId,
            actor,
            action: "code.read",
            threadId: codeServed.threadId,
            emailId: row.id,
          });
        }
        return {
          bytes: Buffer.from(JSON.stringify({ ...email, ...extras })),
          headers: { "content-type": "application/json" },
        };
      }) as never;
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/emails/receiving/{id}",
      summary: "Delete a received email",
      description:
        "MillionSend extension: erases one received email now, its sealed content, inbox memberships and received secrets with it, and threads it leaves empty. Needs a full access key that is not scoped to an inbox; for an MCP token, the owner or admin role. Webhook payloads already sent keep their metadata until the payload retention strips them.",
      middleware,
      request: { params: z.object({ id: z.uuid() }) },
      responses: {
        200: {
          content: { "application/json": { schema: deleteReceivedEmailResponseSchema } },
          description: "Deleted",
        },
        403: jsonErr("Restricted API key"),
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const [row] = await db
        .select({ id: t.id })
        .from(t)
        .where(
          and(
            eq(t.id, id),
            receivedEmailScope({ teamId: auth.teamId, domainId: auth.domainId, held: "include" }),
          ),
        );
      if (
        !row ||
        !(await deleteReceivedEmail(db, {
          teamId: auth.teamId,
          id,
          actor: inboxActorFromAuth(auth),
        }))
      ) {
        return c.json(errorBody(404, "not_found", "Email not found"), 404);
      }
      return c.json({ object: "email" as const, id, deleted: true as const }, 200);
    },
  );

  const findMeta = async (c: Context<Env>, id: string) =>
    (
      await db
        .select(RECEIVED_EMAIL_META_COLUMNS)
        .from(t)
        .where(and(eq(t.id, id), scope(c)))
    )[0];

  app.openapi(
    createRoute({
      method: "get",
      path: "/emails/receiving/{email_id}/attachments",
      summary: "List a received email's attachments",
      description:
        "The attachments and inline parts of one received email, each with a signed download link valid for one hour; all of them unless `limit` is given. Needs a full access key. The links of an email that carries malware answer 410.",
      middleware,
      request: { params: z.object({ email_id: z.uuid() }), query: listQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: listReceivedAttachmentsResponseSchema } },
          description: "Attachments",
        },
        403: jsonErr("Restricted API key"),
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const row = await findMeta(c, c.req.valid("param").email_id);
      if (!row) return c.json(errorBody(404, "not_found", "Email not found"), 404);
      const query = c.req.valid("query");
      const attachments = await receivedEmailAttachments(row, keyring, downloads());
      // Resend returns every attachment when no limit is given.
      const page = arrayPage(attachments, { ...query, limit: query.limit ?? attachments.length });
      if (page === "bad_cursor") {
        return c.json(errorBody(422, "validation_error", BAD_CURSOR_MESSAGE), 422);
      }
      return c.json({ object: "list" as const, has_more: page.hasMore, data: page.rows }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/emails/receiving/{email_id}/attachments/{id}",
      summary: "Retrieve a received email's attachment",
      description:
        "One attachment's metadata and a signed download link valid for one hour. Needs a full access key.",
      middleware,
      request: { params: z.object({ email_id: z.uuid(), id: z.uuid() }) },
      responses: {
        200: {
          content: { "application/json": { schema: getReceivedAttachmentResponseSchema } },
          description: "Attachment",
        },
        403: jsonErr("Restricted API key"),
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const { email_id, id } = c.req.valid("param");
      const row = await findMeta(c, email_id);
      if (!row) return c.json(errorBody(404, "not_found", "Email not found"), 404);
      const attachment = await receivedEmailAttachment(row, keyring, id, downloads());
      if (!attachment) return c.json(errorBody(404, "not_found", "Attachment not found"), 404);
      return c.json({ object: "attachment" as const, ...attachment }, 200);
    },
  );

  /**
   * SECURITY: no API key. The signed link is the credential (Resend's SDK
   * fetches raw.download_url with a bare fetch), verified against the team of
   * the stored row before anything is decrypted. A link that does not verify
   * and an id that does not exist get the same answer; mail carrying malware
   * answers 410, before anything is decrypted, released or not.
   */
  const serveDownload = async (c: Context<Env>, emailId: string, attachmentId?: string) => {
    const key = deps.receivedDownloadKey;
    // Only a uuid ever reaches the query.
    if (
      !key ||
      !uuid.safeParse(emailId).success ||
      (attachmentId !== undefined && !uuid.safeParse(attachmentId).success)
    ) {
      return opts.refuseDownload(c);
    }
    const [owner] = await db
      .select({ teamId: t.teamId, virusVerdict: t.virusVerdict })
      .from(t)
      .where(eq(t.id, emailId));
    const verified =
      owner !== undefined &&
      verifyReceivedDownload({
        key,
        teamId: owner.teamId,
        emailId,
        attachmentId,
        expires: c.req.query("expires"),
        signature: c.req.query("signature"),
      });
    if (!verified) return opts.refuseDownload(c);
    if (owner.virusVerdict === "fail") {
      return c.json(
        errorBody(410, "email_blocked", "This email carries malware; downloads are blocked"),
        410,
      );
    }
    return inContentSlot(c, async () => {
      const [row] = await db.select().from(t).where(eq(t.id, emailId));
      if (attachmentId === undefined) {
        const raw = row ? await openReceivedRaw(row, keyring) : null;
        if (!raw) return c.json(errorBody(404, "not_found", "This email is no longer stored"), 404);
        return { bytes: raw, headers: downloadHeaders("message/rfc822", `${emailId}.eml`) };
      }
      const file = row ? await openReceivedAttachment(row, keyring, attachmentId) : null;
      if (!file)
        return c.json(errorBody(404, "not_found", "This attachment is no longer stored"), 404);
      // Always a download: the declared type is the sender's word, so it never reaches the browser.
      return {
        bytes: file.content,
        headers: downloadHeaders(
          "application/octet-stream",
          file.attachment.filename ?? attachmentId,
        ),
      };
    });
  };

  app.get(`${RECEIVED_RAW_PATH}/:emailId`, (c) => serveDownload(c, c.req.param("emailId")));
  app.get(`${RECEIVED_ATTACHMENT_PATH}/:emailId/:attachmentId`, (c) =>
    serveDownload(c, c.req.param("emailId"), c.req.param("attachmentId")),
  );
}

/**
 * A failed MX call, logged and reported by error class and code only: a
 * failed query's message carries its parameters, which here are the
 * message's bytes and the addresses it names.
 */
function mxFailure(c: Context, err: unknown): Response {
  const code =
    (err as { code?: unknown }).code ??
    (err instanceof Error ? (err.cause as { code?: unknown } | undefined)?.code : undefined);
  const summary = `receiving: ${c.req.path} failed (${err instanceof Error ? err.name : typeof err}${typeof code === "string" ? ` ${code}` : ""})`;
  console.error(summary);
  void captureError(new Error(summary), { tags: { route: c.req.path } });
  return c.json(errorBody(500, "internal_server_error", "An unexpected error occurred"), 500);
}

/**
 * The internal API the MX (PROCESS=mx) calls, per the contract in
 * @millionsend/core/receiving-protocol. Registered only while this instance
 * receives mail, so otherwise both paths are a 404.
 */
export function registerMxIngestRoutes(
  app: OpenAPIHono<Env>,
  deps: ApiDeps,
  receiving: { mxHost: string; ingestSecret: string },
): void {
  // The inbound judge runs in the worker with this same configuration.
  const judgeAvailable = abuseJudgeConfig() !== null;
  // SECURITY: no API key and no team here; the MX's shared secret is the
  // only credential, compared in constant time.
  const mxOnly = createMiddleware<Env>(async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!secretsEqual(token, receiving.ingestSecret)) {
      return c.json(errorBody(401, "unauthorized", "Missing or invalid MX ingest secret"), 401);
    }
    return next();
  });

  app.post(`${MX_INGEST_PATH}${MX_RCPT_PATH}`, mxOnly, async (c) => {
    const parsed = rcptRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(errorBody(400, "invalid_request", "Body must be an RCPT request"), 400);
    }
    try {
      return c.json(
        await decideRecipient(deps.db, {
          recipient: parsed.data.recipient,
          isCloud: deps.isCloud,
          sharedInboxDomain: deps.sharedInboxDomain,
        }),
        200,
      );
    } catch (err) {
      return mxFailure(c, err);
    }
  });

  // The body is the message and nothing else (the envelope rides in a
  // header), so the message's own limit is the body's.
  const deliverBodyLimit = bodyLimit({
    maxSize: MAX_RECEIVED_MESSAGE_BYTES,
    onError: (c) => c.json(MESSAGE_TOO_LARGE, MX_DELIVER_PERMANENT_STATUS),
  });

  app.post(`${MX_INGEST_PATH}${MX_DELIVER_PATH}`, mxOnly, deliverBodyLimit, async (c) => {
    const envelope = decodeEnvelopeHeader(c.req.header(MX_ENVELOPE_HEADER));
    if (!envelope) {
      return c.json(
        errorBody(400, "invalid_envelope", `Missing or malformed ${MX_ENVELOPE_HEADER} header`),
        400,
      );
    }
    // The body is read inside the slot, so waiting deliveries hold no message in memory.
    return deliverSlot(async () => {
      try {
        const raw = Buffer.from(await c.req.arrayBuffer());
        const result = await ingestReceivedEmail(
          {
            db: deps.db,
            keyring: deps.keyring,
            isCloud: deps.isCloud,
            enqueueWebhookDeliveries: deps.enqueueWebhookDeliveries,
            inboxKeys: deps.inboxKeys,
            scanVirus: deps.scanVirus,
            reportScanFailure: (reason) => {
              const summary = `receiving: virus scan failed (${reason})`;
              console.warn(summary);
              void captureError(new Error(summary), { tags: { route: c.req.path } });
            },
            judgeAvailable,
            enqueueScreening: deps.enqueueScreening,
            enqueueInboxForward: deps.enqueueInboxForward,
            mxHost: receiving.mxHost,
            sharedInboxDomain: deps.sharedInboxDomain,
          },
          { raw, envelope },
        );
        if (result.ok) return c.json({ ok: true as const }, 200);
        return c.json(
          { code: result.code, enhanced: result.enhanced, message: result.message },
          result.code >= 500 ? MX_DELIVER_PERMANENT_STATUS : MX_DELIVER_TEMPORARY_STATUS,
        );
      } catch (err) {
        return mxFailure(c, err);
      }
    });
  });
}
