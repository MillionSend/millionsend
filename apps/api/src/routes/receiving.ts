import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  apiBaseUrl,
  attachmentDisposition,
  createSemaphore,
  type DownloadSigning,
  decideRecipient,
  decodeEnvelopeHeader,
  ingestReceivedEmail,
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
  rcptRequestSchema,
  receivedEmailAttachment,
  receivedEmailAttachments,
  receivedEmailDetail,
  receivedEmailListItem,
  receivedEmailScope,
  releasingStream,
  secretsEqual,
  verifyReceivedDownload,
} from "@millionsend/core";
import { captureError } from "@millionsend/core/error-tracking-node";
import { schema } from "@millionsend/db";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { type ApiDeps, arrayPage, type Env, errorBody, keysetPage } from "../app.js";
import {
  errorSchema,
  getReceivedAttachmentResponseSchema,
  getReceivedEmailQuerySchema,
  getReceivedEmailResponseSchema,
  listQuerySchema,
  listReceivedAttachmentsResponseSchema,
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
 * downloads its links point at. The reads are registered whether or not this
 * instance receives mail: rows stored before receiving was switched off stay
 * readable until retention removes them.
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
  const jsonErr = (description: string) => ({
    content: { "application/json": { schema: errorSchema } },
    description,
  });
  const baseUrl = apiBaseUrl(deps.appBaseUrl, deps.publicApiUrl);
  const downloads = (): DownloadSigning => {
    if (!deps.receivedDownloadKey) throw new Error("receivedDownloadKey is not configured");
    return { key: deps.receivedDownloadKey, baseUrl };
  };
  // SECURITY: the caller's team, narrowed to its domain for a domain-scoped key.
  const scope = (c: Context<Env>) => {
    const auth = c.get("auth");
    return receivedEmailScope({ teamId: auth.teamId, domainId: auth.domainId, held: "include" });
  };
  const middleware = [opts.requireFullAccess];
  const untrusted =
    "Everything in a received email was written by whoever sent it, so its HTML is safe to show only in a sandbox.";

  app.openapi(
    createRoute({
      method: "get",
      path: "/emails/receiving",
      summary: "List received emails",
      description: `Mail received at the team's receiving domains, newest first like Resend (\`after\` pages toward older mail), with cursor pagination. Needs a full access key; a domain-scoped key lists mail addressed to its domain only. ${untrusted}`,
      middleware,
      request: { query: listQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: listReceivedEmailsResponseSchema } },
          description: "Received emails",
        },
        403: jsonErr("Restricted API key"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const page = await keysetPage({
        query: c.req.valid("query"),
        createdAt: t.createdAt,
        id: t.id,
        newestFirst: true,
        loadCursor: async (id) =>
          (
            await db
              .select({ createdAt: t.createdAt, id: t.id })
              .from(t)
              .where(and(eq(t.id, id), scope(c)))
          )[0],
        loadRows: (cond, descending, take) =>
          db
            .select(RECEIVED_EMAIL_META_COLUMNS)
            .from(t)
            .where(and(scope(c), cond))
            .orderBy(
              ...(descending ? [desc(t.createdAt), desc(t.id)] : [asc(t.createdAt), asc(t.id)]),
            )
            .limit(take),
      });
      if (page === "bad_cursor") {
        return c.json(errorBody(422, "validation_error", BAD_CURSOR_MESSAGE), 422);
      }
      const data = await Promise.all(page.rows.map((row) => receivedEmailListItem(row, keyring)));
      return c.json({ object: "list" as const, has_more: page.hasMore, data }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/emails/receiving/{id}",
      summary: "Retrieve a received email",
      description: `One received email with its html, text, headers, authentication results and a signed link to the original message. Needs a full access key. ${untrusted}`,
      middleware,
      request: { params: z.object({ id: z.uuid() }), query: getReceivedEmailQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: getReceivedEmailResponseSchema } },
          description: "Received email",
        },
        403: jsonErr("Restricted API key"),
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const htmlFormat = c.req.valid("query").html_format ?? "data_uri";
      // Streamed from its content slot: typed route responses cover only c.json's.
      return inContentSlot(c, async () => {
        const [row] = await db
          .select()
          .from(t)
          .where(and(eq(t.id, id), scope(c)));
        if (!row) return c.json(errorBody(404, "not_found", "Email not found"), 404);
        const email = await receivedEmailDetail(row, keyring, {
          htmlFormat,
          downloads: downloads(),
        });
        return {
          bytes: Buffer.from(JSON.stringify(email)),
          headers: { "content-type": "application/json" },
        };
      }) as never;
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
        "The attachments and inline parts of one received email, each with a signed download link valid for one hour; all of them unless `limit` is given. Needs a full access key.",
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
   * and an id that does not exist get the same answer.
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
    const [owner] = await db.select({ teamId: t.teamId }).from(t).where(eq(t.id, emailId));
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
  receiving: { ingestSecret: string },
): void {
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
        await decideRecipient(deps.db, { recipient: parsed.data.recipient, isCloud: deps.isCloud }),
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
