import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  beginIdempotent,
  canonicalBodyHash,
  completeIdempotent,
  decryptEmailBody,
  encryptEmailBody,
  extractAddrSpec,
  extractTokenPrefix,
  findSuppressed,
  type Keyring,
  PLAN_DAILY_LIMIT,
  releaseIdempotent,
  reserveDailyQuota,
  verifyApiKey,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SerializedSesEvent } from "@millionsend/queue";
import {
  type CertFetcher,
  isAllowedSnsUrl,
  parseSesEvent,
  type SnsMessage,
  snsMessageSchema,
  verifySnsMessage,
} from "@millionsend/ses";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import {
  audienceResponseSchema,
  broadcastIdResponseSchema,
  cancelBroadcastResponseSchema,
  contactIdResponseSchema,
  createAudienceRequestSchema,
  createBroadcastRequestSchema,
  createContactRequestSchema,
  errorSchema,
  getBroadcastResponseSchema,
  getContactResponseSchema,
  getEmailResponseSchema,
  listAudiencesResponseSchema,
  listBroadcastsResponseSchema,
  listContactsResponseSchema,
  removeAudienceResponseSchema,
  removeBroadcastResponseSchema,
  removeContactResponseSchema,
  sendBroadcastRequestSchema,
  sendEmailRequestSchema,
  sendEmailResponseSchema,
  updateBroadcastRequestSchema,
  updateContactRequestSchema,
} from "./schemas.js";

export interface SnsIngestDeps {
  /** Only these topics may deliver events; everything else is rejected. */
  allowedTopicArns: readonly string[];
  fetchCert: CertFetcher;
  enqueueSesEvent: (event: SerializedSesEvent, snsMessageId: string) => Promise<void>;
  /** Overridable for tests; default fetches the (validated) SubscribeURL. */
  confirmSubscription?: ((subscribeUrl: string) => Promise<void>) | undefined;
}

export interface ApiDeps {
  db: Db;
  keyring: Keyring;
  /** Cloud enforces plan quotas; self-host sends without caps. */
  isCloud: boolean;
  /**
   * Hands an accepted email to the send queue. REQUIRED: accepting mail
   * without a producer would strand it in "queued" forever.
   */
  enqueueEmailSend: (emailId: string, opts?: { startAfter?: Date }) => Promise<void>;
  /**
   * Hands a scheduled broadcast to the fan-out queue. Optional: without it a
   * send still commits (status scheduled) and the broadcasts.reconcile sweep
   * picks the broadcast up.
   */
  enqueueBroadcastSend?:
    | ((broadcastId: string, opts?: { startAfter?: Date }) => Promise<void>)
    | undefined;
  /** SES event ingestion; omitted → the endpoint does not exist (404). */
  sns?: SnsIngestDeps | undefined;
}

interface AuthContext {
  teamId: string;
  plan: (typeof schema.planEnum.enumValues)[number];
  apiKeyId: string;
}

type Env = { Variables: { auth: AuthContext } };

const LAST_USED_STAMP_INTERVAL_MS = 60_000;

class IdempotencyTakeoverError extends Error {
  constructor() {
    super("idempotency claim taken over");
  }
}

function errorBody(status: number, name: string, message: string) {
  return { statusCode: status, name, message };
}

function senderDomain(from: string): string | null {
  const addr = extractAddrSpec(from);
  const at = addr.lastIndexOf("@");
  return at > 0 ? addr.slice(at + 1).toLowerCase() : null;
}

async function fetchSubscribeUrl(subscribeUrl: string): Promise<void> {
  const res = await fetch(subscribeUrl);
  if (!res.ok) throw new Error(`SNS subscription confirmation failed: ${res.status}`);
}

function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  while (e instanceof Error) {
    if ((e as { code?: string }).code === "23505" || e.message.includes("duplicate key")) {
      return true;
    }
    e = e.cause;
  }
  return false;
}

function registerAudienceRoutes(
  app: OpenAPIHono<Env>,
  db: Db,
  prefix: "audiences" | "segments",
): void {
  const objectName = prefix === "audiences" ? "audience" : "segment";
  const jsonErr = (description: string) => ({
    content: { "application/json": { schema: errorSchema } },
    description,
  });

  const findAudience = async (teamId: string, id: string) =>
    (
      await db
        .select()
        .from(schema.audiences)
        .where(and(eq(schema.audiences.id, id), eq(schema.audiences.teamId, teamId)))
    )[0];

  // The contact path segment may be the contact UUID or its email — the
  // resend SDK sends either, undistinguished. Email matching is
  // case-insensitive, mirroring the unique index.
  const contactWhere = (teamId: string, audienceId: string, idOrEmail: string) =>
    and(
      eq(schema.contacts.audienceId, audienceId),
      eq(schema.contacts.teamId, teamId),
      z.uuid().safeParse(idOrEmail).success
        ? eq(schema.contacts.id, idOrEmail)
        : sql`lower(${schema.contacts.email}) = ${idOrEmail.toLowerCase()}`,
    );

  app.openapi(
    createRoute({
      method: "post",
      path: `/${prefix}`,
      request: {
        body: { content: { "application/json": { schema: createAudienceRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: audienceResponseSchema } },
          description: "Audience created",
        },
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { name } = c.req.valid("json");
      const [row] = await db
        .insert(schema.audiences)
        .values({ teamId: auth.teamId, name })
        .returning({ id: schema.audiences.id, name: schema.audiences.name });
      if (!row) throw new Error("audience insert returned no row");
      return c.json({ object: objectName, id: row.id, name: row.name }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: `/${prefix}`,
      responses: {
        200: {
          content: { "application/json": { schema: listAudiencesResponseSchema } },
          description: "Audiences",
        },
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const rows = await db
        .select()
        .from(schema.audiences)
        .where(eq(schema.audiences.teamId, auth.teamId))
        .orderBy(asc(schema.audiences.createdAt));
      return c.json(
        {
          object: "list" as const,
          data: rows.map((r) => ({
            id: r.id,
            name: r.name,
            created_at: r.createdAt.toISOString(),
          })),
          has_more: false,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: `/${prefix}/{id}`,
      request: { params: z.object({ id: z.uuid() }) },
      responses: {
        200: {
          content: { "application/json": { schema: audienceResponseSchema } },
          description: "Audience",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const audience = await findAudience(auth.teamId, c.req.valid("param").id);
      if (!audience) return c.json(errorBody(404, "not_found", "Audience not found"), 404);
      return c.json(
        {
          object: objectName,
          id: audience.id,
          name: audience.name,
          created_at: audience.createdAt.toISOString(),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: `/${prefix}/{id}`,
      request: { params: z.object({ id: z.uuid() }) },
      responses: {
        200: {
          content: { "application/json": { schema: removeAudienceResponseSchema } },
          description: "Audience deleted",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const [row] = await db
        .delete(schema.audiences)
        .where(and(eq(schema.audiences.id, id), eq(schema.audiences.teamId, auth.teamId)))
        .returning({ id: schema.audiences.id });
      if (!row) return c.json(errorBody(404, "not_found", "Audience not found"), 404);
      return c.json({ object: objectName, id: row.id, deleted: true as const }, 200);
    },
  );

  const audienceIdParam = z.object({ audienceId: z.uuid() });
  const contactParams = z.object({ audienceId: z.uuid(), id: z.string().min(1) });

  app.openapi(
    createRoute({
      method: "post",
      path: `/${prefix}/{audienceId}/contacts`,
      request: {
        params: audienceIdParam,
        body: { content: { "application/json": { schema: createContactRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: contactIdResponseSchema } },
          description: "Contact created",
        },
        404: jsonErr("Not found"),
        409: jsonErr("Contact already exists"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { audienceId } = c.req.valid("param");
      const body = c.req.valid("json");
      if (!(await findAudience(auth.teamId, audienceId))) {
        return c.json(errorBody(404, "not_found", "Audience not found"), 404);
      }
      try {
        const [row] = await db
          .insert(schema.contacts)
          .values({
            audienceId,
            teamId: auth.teamId,
            email: body.email,
            firstName: body.first_name ?? null,
            lastName: body.last_name ?? null,
            unsubscribed: body.unsubscribed ?? false,
          })
          .returning({ id: schema.contacts.id });
        if (!row) throw new Error("contact insert returned no row");
        return c.json({ object: "contact" as const, id: row.id }, 200);
      } catch (err) {
        if (isUniqueViolation(err)) {
          return c.json(errorBody(409, "conflict", "Contact already exists"), 409);
        }
        throw err;
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: `/${prefix}/{audienceId}/contacts`,
      request: { params: audienceIdParam },
      responses: {
        200: {
          content: { "application/json": { schema: listContactsResponseSchema } },
          description: "Contacts",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { audienceId } = c.req.valid("param");
      if (!(await findAudience(auth.teamId, audienceId))) {
        return c.json(errorBody(404, "not_found", "Audience not found"), 404);
      }
      const rows = await db
        .select()
        .from(schema.contacts)
        .where(
          and(eq(schema.contacts.audienceId, audienceId), eq(schema.contacts.teamId, auth.teamId)),
        )
        .orderBy(asc(schema.contacts.createdAt));
      return c.json(
        {
          object: "list" as const,
          data: rows.map((r) => ({
            id: r.id,
            email: r.email,
            first_name: r.firstName,
            last_name: r.lastName,
            created_at: r.createdAt.toISOString(),
            unsubscribed: r.unsubscribed,
          })),
          has_more: false,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: `/${prefix}/{audienceId}/contacts/{id}`,
      request: { params: contactParams },
      responses: {
        200: {
          content: { "application/json": { schema: getContactResponseSchema } },
          description: "Contact",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { audienceId, id } = c.req.valid("param");
      const [contact] = await db
        .select()
        .from(schema.contacts)
        .where(contactWhere(auth.teamId, audienceId, id));
      if (!contact) return c.json(errorBody(404, "not_found", "Contact not found"), 404);
      return c.json(
        {
          object: "contact" as const,
          id: contact.id,
          email: contact.email,
          first_name: contact.firstName,
          last_name: contact.lastName,
          created_at: contact.createdAt.toISOString(),
          unsubscribed: contact.unsubscribed,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: `/${prefix}/{audienceId}/contacts/{id}`,
      request: {
        params: contactParams,
        body: { content: { "application/json": { schema: updateContactRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: contactIdResponseSchema } },
          description: "Contact updated",
        },
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { audienceId, id } = c.req.valid("param");
      const body = c.req.valid("json");
      const [row] = await db
        .update(schema.contacts)
        .set({
          updatedAt: new Date(),
          ...(body.first_name !== undefined ? { firstName: body.first_name } : {}),
          ...(body.last_name !== undefined ? { lastName: body.last_name } : {}),
          ...(body.unsubscribed !== undefined ? { unsubscribed: body.unsubscribed } : {}),
        })
        .where(contactWhere(auth.teamId, audienceId, id))
        .returning({ id: schema.contacts.id });
      if (!row) return c.json(errorBody(404, "not_found", "Contact not found"), 404);
      return c.json({ object: "contact" as const, id: row.id }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: `/${prefix}/{audienceId}/contacts/{id}`,
      request: { params: contactParams },
      responses: {
        200: {
          content: { "application/json": { schema: removeContactResponseSchema } },
          description: "Contact deleted",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { audienceId, id } = c.req.valid("param");
      const [row] = await db
        .delete(schema.contacts)
        .where(contactWhere(auth.teamId, audienceId, id))
        .returning({ id: schema.contacts.id });
      if (!row) return c.json(errorBody(404, "not_found", "Contact not found"), 404);
      return c.json({ object: "contact" as const, contact: row.id, deleted: true as const }, 200);
    },
  );
}

function registerBroadcastRoutes(app: OpenAPIHono<Env>, deps: ApiDeps): void {
  const db = deps.db;
  const jsonErr = (description: string) => ({
    content: { "application/json": { schema: errorSchema } },
    description,
  });
  const idParam = z.object({ id: z.uuid() });

  const findBroadcast = async (teamId: string, id: string) =>
    (
      await db
        .select()
        .from(schema.broadcasts)
        .where(and(eq(schema.broadcasts.id, id), eq(schema.broadcasts.teamId, teamId)))
    )[0];

  const findAudience = async (teamId: string, id: string) =>
    (
      await db
        .select({ id: schema.audiences.id })
        .from(schema.audiences)
        .where(and(eq(schema.audiences.id, id), eq(schema.audiences.teamId, teamId)))
    )[0];

  // Accepted into the request schema so unsupported Resend knobs fail loudly
  // instead of being silently stripped (docs/resend-compatibility.md).
  const unsupported = (body: {
    preview_text?: string | undefined;
    topic_id?: string | null | undefined;
    send?: boolean | undefined;
    scheduled_at?: string | undefined;
  }): string | null => {
    if (body.preview_text !== undefined) return "preview_text is not yet supported";
    if (body.topic_id != null) return "topic_id is not yet supported";
    if (body.send) return "send-on-create is not supported; use POST /broadcasts/{id}/send";
    if (body.scheduled_at !== undefined) {
      return "scheduled_at on create is not supported; use POST /broadcasts/{id}/send";
    }
    return null;
  };

  const parseReplyTo = (stored: string | null): string[] | null =>
    stored === null ? null : (JSON.parse(stored) as string[]);

  app.openapi(
    createRoute({
      method: "post",
      path: "/broadcasts",
      request: {
        body: { content: { "application/json": { schema: createBroadcastRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: broadcastIdResponseSchema } },
          description: "Broadcast created as draft",
        },
        404: jsonErr("Audience not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const rejected = unsupported(body);
      if (rejected) return c.json(errorBody(422, "validation_error", rejected), 422);
      // The SDK sends the target as audience_id and/or segment_id.
      const audienceId = body.audience_id ?? body.segment_id;
      if (!audienceId || !(await findAudience(auth.teamId, audienceId))) {
        return c.json(errorBody(404, "not_found", "Audience not found"), 404);
      }
      const [row] = await db
        .insert(schema.broadcasts)
        .values({
          teamId: auth.teamId,
          audienceId,
          name: body.name ?? null,
          from: body.from,
          subject: body.subject,
          replyTo: body.reply_to ? JSON.stringify(body.reply_to) : null,
          html: body.html ?? null,
          text: body.text ?? null,
        })
        .returning({ id: schema.broadcasts.id });
      if (!row) throw new Error("broadcast insert returned no row");
      return c.json({ id: row.id }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/broadcasts",
      responses: {
        200: {
          content: { "application/json": { schema: listBroadcastsResponseSchema } },
          description: "Broadcasts",
        },
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const rows = await db
        .select()
        .from(schema.broadcasts)
        .where(eq(schema.broadcasts.teamId, auth.teamId))
        .orderBy(asc(schema.broadcasts.createdAt));
      return c.json(
        {
          object: "list" as const,
          data: rows.map((r) => ({
            id: r.id,
            name: r.name,
            audience_id: r.audienceId,
            segment_id: r.audienceId,
            status: r.status,
            created_at: r.createdAt.toISOString(),
            scheduled_at: r.scheduledAt?.toISOString() ?? null,
            sent_at: r.sentAt?.toISOString() ?? null,
          })),
          has_more: false,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/broadcasts/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: getBroadcastResponseSchema } },
          description: "Broadcast",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const broadcast = await findBroadcast(auth.teamId, c.req.valid("param").id);
      if (!broadcast) return c.json(errorBody(404, "not_found", "Broadcast not found"), 404);
      return c.json(
        {
          object: "broadcast" as const,
          id: broadcast.id,
          name: broadcast.name,
          audience_id: broadcast.audienceId,
          segment_id: broadcast.audienceId,
          from: broadcast.from,
          subject: broadcast.subject,
          reply_to: parseReplyTo(broadcast.replyTo),
          preview_text: null,
          html: broadcast.html,
          text: broadcast.text,
          status: broadcast.status,
          created_at: broadcast.createdAt.toISOString(),
          scheduled_at: broadcast.scheduledAt?.toISOString() ?? null,
          sent_at: broadcast.sentAt?.toISOString() ?? null,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/broadcasts/{id}",
      request: {
        params: idParam,
        body: { content: { "application/json": { schema: updateBroadcastRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: broadcastIdResponseSchema } },
          description: "Broadcast updated",
        },
        400: jsonErr("Not a draft"),
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const rejected = unsupported(body);
      if (rejected) return c.json(errorBody(422, "validation_error", rejected), 422);
      const broadcast = await findBroadcast(auth.teamId, id);
      if (!broadcast) return c.json(errorBody(404, "not_found", "Broadcast not found"), 404);
      if (broadcast.status !== "draft") {
        return c.json(errorBody(400, "invalid_state", "Only draft broadcasts can be updated"), 400);
      }
      const audienceId = body.audience_id ?? body.segment_id;
      if (audienceId !== undefined && !(await findAudience(auth.teamId, audienceId))) {
        return c.json(errorBody(404, "not_found", "Audience not found"), 404);
      }
      const [row] = await db
        .update(schema.broadcasts)
        .set({
          updatedAt: new Date(),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(audienceId !== undefined ? { audienceId } : {}),
          ...(body.from !== undefined ? { from: body.from } : {}),
          ...(body.subject !== undefined ? { subject: body.subject } : {}),
          ...(body.html !== undefined ? { html: body.html } : {}),
          ...(body.text !== undefined ? { text: body.text } : {}),
          ...(body.reply_to !== undefined ? { replyTo: JSON.stringify(body.reply_to) } : {}),
        })
        // Status re-checked in the WHERE: a send racing this update must not
        // let a draft-only edit land on a scheduled/sending broadcast.
        .where(and(eq(schema.broadcasts.id, id), eq(schema.broadcasts.status, "draft")))
        .returning({ id: schema.broadcasts.id });
      if (!row) {
        return c.json(errorBody(400, "invalid_state", "Only draft broadcasts can be updated"), 400);
      }
      return c.json({ id: row.id }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/broadcasts/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: removeBroadcastResponseSchema } },
          description: "Broadcast deleted",
        },
        400: jsonErr("Not a draft"),
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const broadcast = await findBroadcast(auth.teamId, id);
      if (!broadcast) return c.json(errorBody(404, "not_found", "Broadcast not found"), 404);
      if (broadcast.status !== "draft") {
        return c.json(errorBody(400, "invalid_state", "Only draft broadcasts can be deleted"), 400);
      }
      const [row] = await db
        .delete(schema.broadcasts)
        .where(and(eq(schema.broadcasts.id, id), eq(schema.broadcasts.status, "draft")))
        .returning({ id: schema.broadcasts.id });
      if (!row) {
        return c.json(errorBody(400, "invalid_state", "Only draft broadcasts can be deleted"), 400);
      }
      return c.json({ object: "broadcast" as const, id: row.id, deleted: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/broadcasts/{id}/send",
      request: {
        params: idParam,
        body: { content: { "application/json": { schema: sendBroadcastRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: broadcastIdResponseSchema } },
          description: "Broadcast scheduled",
        },
        400: jsonErr("Not a draft"),
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const broadcast = await findBroadcast(auth.teamId, id);
      if (!broadcast) return c.json(errorBody(404, "not_found", "Broadcast not found"), 404);
      if (broadcast.status !== "draft") {
        return c.json(errorBody(400, "invalid_state", "Only draft broadcasts can be sent"), 400);
      }
      if (!broadcast.audienceId) {
        return c.json(errorBody(422, "validation_error", "The audience no longer exists"), 422);
      }
      // Same boundary as /emails: only a verified team domain may appear as
      // the sender.
      const fromDomain = senderDomain(broadcast.from);
      const domain = fromDomain
        ? (
            await db
              .select({ status: schema.domains.status })
              .from(schema.domains)
              .where(
                and(eq(schema.domains.teamId, auth.teamId), eq(schema.domains.name, fromDomain)),
              )
          )[0]
        : undefined;
      if (domain?.status !== "verified") {
        return c.json(
          errorBody(
            422,
            "validation_error",
            `The ${fromDomain ?? "sender"} domain is not verified for this team`,
          ),
          422,
        );
      }
      const scheduledAt = body.scheduled_at ? new Date(body.scheduled_at) : new Date();
      const [row] = await db
        .update(schema.broadcasts)
        .set({ status: "scheduled", scheduledAt, updatedAt: new Date() })
        .where(and(eq(schema.broadcasts.id, id), eq(schema.broadcasts.status, "draft")))
        .returning({ id: schema.broadcasts.id });
      if (!row) {
        return c.json(errorBody(400, "invalid_state", "Only draft broadcasts can be sent"), 400);
      }
      // Enqueue failure must not undo the commit — the reconcile sweep
      // re-enqueues scheduled broadcasts whose job was lost.
      try {
        await deps.enqueueBroadcastSend?.(row.id, { startAfter: scheduledAt });
      } catch (err) {
        console.error("broadcast.send enqueue failed; reconcile sweep will recover", err);
      }
      return c.json({ id: row.id }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/broadcasts/{id}/cancel",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: cancelBroadcastResponseSchema } },
          description: "Broadcast canceled",
        },
        400: jsonErr("Not scheduled"),
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const broadcast = await findBroadcast(auth.teamId, id);
      if (!broadcast) return c.json(errorBody(404, "not_found", "Broadcast not found"), 404);
      // Scheduled only: the fan-out handler re-checks status, so a cancel
      // that wins this update beats a racing send job.
      const [row] = await db
        .update(schema.broadcasts)
        .set({ status: "canceled", updatedAt: new Date() })
        .where(and(eq(schema.broadcasts.id, id), eq(schema.broadcasts.status, "scheduled")))
        .returning({ id: schema.broadcasts.id });
      if (!row) {
        return c.json(
          errorBody(400, "invalid_state", "Only scheduled broadcasts can be canceled"),
          400,
        );
      }
      return c.json({ object: "broadcast" as const, id: row.id }, 200);
    },
  );
}

export function createApi(deps: ApiDeps): OpenAPIHono<Env> {
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          errorBody(
            422,
            "validation_error",
            result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          ),
          422,
        );
      }
    },
  });

  // Uncaught throws must still speak Resend's error format — SDK clients
  // parse the body as JSON.
  app.onError((err, c) => {
    console.error("unhandled api error", err);
    return c.json(errorBody(500, "internal_server_error", "An unexpected error occurred"), 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "MillionSend API", version: "1.0.0" },
  });

  const requireApiKey = createMiddleware<Env>(async (c, next) => {
    // Both /emails and /emails/* register this; skip the second pass.
    if (c.get("auth")) return next();
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const prefix = token ? extractTokenPrefix(token) : null;
    if (!token || !prefix) {
      return c.json(errorBody(401, "missing_api_key", "Missing or malformed API key"), 401);
    }
    const candidates = await deps.db
      .select({
        id: schema.apiKeys.id,
        keyHash: schema.apiKeys.keyHash,
        teamId: schema.apiKeys.teamId,
        lastUsedAt: schema.apiKeys.lastUsedAt,
        plan: schema.teams.plan,
      })
      .from(schema.apiKeys)
      .innerJoin(schema.teams, eq(schema.apiKeys.teamId, schema.teams.id))
      .where(and(eq(schema.apiKeys.tokenPrefix, prefix), isNull(schema.apiKeys.revokedAt)));
    const match = candidates.find((k) => verifyApiKey(token, k.keyHash));
    if (!match) {
      return c.json(errorBody(401, "invalid_api_key", "API key is invalid"), 401);
    }
    c.set("auth", { teamId: match.teamId, plan: match.plan, apiKeyId: match.id });
    const now = Date.now();
    if (!match.lastUsedAt || now - match.lastUsedAt.getTime() > LAST_USED_STAMP_INTERVAL_MS) {
      deps.db
        .update(schema.apiKeys)
        .set({ lastUsedAt: new Date(now) })
        .where(eq(schema.apiKeys.id, match.id))
        .then(
          () => undefined,
          () => undefined,
        );
    }
    await next();
  });
  app.use("/emails", requireApiKey);
  app.use("/emails/*", requireApiKey);

  // The resend SDK (v6+) aliases `audiences` to segments: audience CRUD goes
  // to /segments (object: "segment") and contact list to
  // /segments/{id}/contacts, while contact CRUD stays on
  // /audiences/{id}/contacts. Same handlers on both prefixes keeps every SDK
  // path working (docs/resend-compatibility.md).
  for (const prefix of ["audiences", "segments"] as const) {
    app.use(`/${prefix}`, requireApiKey);
    app.use(`/${prefix}/*`, requireApiKey);
    registerAudienceRoutes(app, deps.db, prefix);
  }

  app.use("/broadcasts", requireApiKey);
  app.use("/broadcasts/*", requireApiKey);
  registerBroadcastRoutes(app, deps);

  const sendRoute = createRoute({
    method: "post",
    path: "/emails",
    request: {
      body: { content: { "application/json": { schema: sendEmailRequestSchema } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: sendEmailResponseSchema } },
        description: "Email accepted",
      },
      409: {
        content: { "application/json": { schema: errorSchema } },
        description: "Idempotency conflict",
      },
      422: {
        content: { "application/json": { schema: errorSchema } },
        description: "Validation error",
      },
    },
  });

  app.openapi(sendRoute, async (c) => {
    const auth = c.get("auth");
    const body = c.req.valid("json");

    if (body.attachments && body.attachments.length > 0) {
      return c.json(errorBody(422, "validation_error", "Attachments are not yet supported"), 422);
    }

    // Sender domain must be one of the team's verified domains — otherwise
    // any key could queue mail claiming any sender.
    const fromDomain = senderDomain(body.from);
    const domain = fromDomain
      ? (
          await deps.db
            .select({ id: schema.domains.id, status: schema.domains.status })
            .from(schema.domains)
            .where(and(eq(schema.domains.teamId, auth.teamId), eq(schema.domains.name, fromDomain)))
        )[0]
      : undefined;
    if (domain?.status !== "verified") {
      return c.json(
        errorBody(
          422,
          "validation_error",
          `The ${fromDomain ?? "sender"} domain is not verified for this team`,
        ),
        422,
      );
    }

    // Idempotency FIRST: a replay must return the stored response even if
    // recipients were suppressed after the original send.
    const idemKey = c.req.header("idempotency-key") ?? null;
    if (idemKey) {
      const begin = await beginIdempotent(deps.db, {
        teamId: auth.teamId,
        key: idemKey,
        bodyHash: canonicalBodyHash(body),
      });
      if (begin.kind === "replay") {
        const first = begin.emailIds[0];
        if (first) return c.json({ id: first }, 200);
        return c.json(
          errorBody(409, "concurrent_idempotent_requests", "Idempotency record is incomplete"),
          409,
        );
      }
      if (begin.kind === "conflict") {
        return c.json(
          errorBody(
            409,
            "invalid_idempotent_request",
            "Idempotency key was used with a different payload",
          ),
          409,
        );
      }
      if (begin.kind === "in_flight") {
        return c.json(
          errorBody(
            409,
            "concurrent_idempotent_requests",
            "A request with this idempotency key is still processing",
          ),
          409,
        );
      }
    }

    try {
      // Suppression: dedupe, check every recipient field, and strip
      // suppressed addresses; refuse only when no `to` recipient remains.
      const allRecipients = [...new Set([...body.to, ...(body.cc ?? []), ...(body.bcc ?? [])])];
      const suppressed = await findSuppressed(deps.db, auth.teamId, allRecipients);
      const keep = (list: string[] | undefined) => list?.filter((r) => !suppressed.has(r));
      const to = keep(body.to) ?? [];
      if (to.length === 0) {
        if (idemKey) await releaseIdempotent(deps.db, { teamId: auth.teamId, key: idemKey });
        return c.json(errorBody(422, "validation_error", "All recipients are suppressed"), 422);
      }
      const cc = keep(body.cc);
      const bcc = keep(body.bcc);

      const encrypted = await encryptEmailBody(
        { html: body.html ?? null, text: body.text ?? null },
        deps.keyring,
      );

      const limit = deps.isCloud ? PLAN_DAILY_LIMIT[auth.plan] : null;
      // Quota reservation, email insert, and idempotency completion commit
      // atomically (the quota contract).
      const accepted = await deps.db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const quota = await reserveDailyQuota(txDb, { teamId: auth.teamId, count: 1, limit });
        const [row] = await tx
          .insert(schema.emails)
          .values({
            teamId: auth.teamId,
            domainId: domain.id,
            apiKeyId: auth.apiKeyId,
            from: body.from,
            to,
            cc: cc && cc.length > 0 ? cc : null,
            bcc: bcc && bcc.length > 0 ? bcc : null,
            replyTo: body.reply_to ?? null,
            subject: body.subject,
            tags: body.tags ? Object.fromEntries(body.tags.map((t) => [t.name, t.value])) : null,
            latestStatus: quota.reserved ? "queued" : "queued_quota",
            scheduledAt: body.scheduled_at ? new Date(body.scheduled_at) : null,
            bodyCiphertext: encrypted.ciphertext,
            bodyIv: encrypted.iv,
            bodyWrappedDek: encrypted.wrappedDek,
            bodyKeyVersion: encrypted.keyVersion,
          })
          .returning({ id: schema.emails.id });
        if (!row) throw new Error("email insert returned no row");
        if (idemKey) {
          const recorded = await completeIdempotent(txDb, {
            teamId: auth.teamId,
            key: idemKey,
            emailIds: [row.id],
          });
          // Another owner took over and recorded its own response: abort so
          // this branch produces no second email.
          if (!recorded) throw new IdempotencyTakeoverError();
        }
        return { id: row.id, parked: !quota.reserved };
      });
      // After commit: hand the send to the queue (quota-parked emails wait
      // for the midnight drain instead). An enqueue failure must NOT undo
      // the accept — the email and its idempotency record are committed, so
      // rethrowing would let a retry create a second email. The reconcile
      // sweep re-enqueues any accepted email whose job was lost.
      if (!accepted.parked) {
        try {
          await deps.enqueueEmailSend(
            accepted.id,
            body.scheduled_at ? { startAfter: new Date(body.scheduled_at) } : {},
          );
        } catch (err) {
          console.error("email.send enqueue failed; reconcile sweep will recover", err);
        }
      }
      return c.json({ id: accepted.id }, 200);
    } catch (err) {
      if (err instanceof IdempotencyTakeoverError && idemKey) {
        const replay = await beginIdempotent(deps.db, {
          teamId: auth.teamId,
          key: idemKey,
          bodyHash: canonicalBodyHash(body),
        });
        if (replay.kind === "replay" && replay.emailIds[0]) {
          return c.json({ id: replay.emailIds[0] }, 200);
        }
        return c.json(
          errorBody(409, "concurrent_idempotent_requests", "Request superseded by a retry"),
          409,
        );
      }
      // A failed request must not brick its idempotency key for the lease.
      if (idemKey) {
        await releaseIdempotent(deps.db, { teamId: auth.teamId, key: idemKey }).catch(() => {});
      }
      throw err;
    }
  });

  const getRoute = createRoute({
    method: "get",
    path: "/emails/{id}",
    request: { params: z.object({ id: z.uuid() }) },
    responses: {
      200: {
        content: { "application/json": { schema: getEmailResponseSchema } },
        description: "Email",
      },
      404: {
        content: { "application/json": { schema: errorSchema } },
        description: "Not found",
      },
    },
  });

  app.openapi(getRoute, async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");
    const [email] = await deps.db
      .select()
      .from(schema.emails)
      .where(and(eq(schema.emails.id, id), eq(schema.emails.teamId, auth.teamId)));
    if (!email) {
      return c.json(errorBody(404, "not_found", "Email not found"), 404);
    }
    let html: string | null = null;
    let text: string | null = null;
    const { bodyCiphertext, bodyIv, bodyWrappedDek, bodyKeyVersion } = email;
    if (bodyCiphertext && bodyIv && bodyWrappedDek && bodyKeyVersion !== null) {
      try {
        const body = await decryptEmailBody(
          {
            ciphertext: bodyCiphertext,
            iv: bodyIv,
            wrappedDek: bodyWrappedDek,
            keyVersion: bodyKeyVersion,
          },
          deps.keyring,
        );
        html = body.html;
        text = body.text;
      } catch {
        // Corrupt or purged body must not 500 the metadata read.
      }
    }
    return c.json(
      {
        object: "email" as const,
        id: email.id,
        from: email.from,
        to: email.to,
        cc: email.cc ?? null,
        bcc: email.bcc ?? null,
        reply_to: email.replyTo ?? null,
        subject: email.subject,
        html,
        text,
        created_at: email.createdAt.toISOString(),
        scheduled_at: email.scheduledAt?.toISOString() ?? null,
        last_event: email.latestStatus,
      },
      200,
    );
  });

  const sns = deps.sns;
  if (sns) {
    // SES event ingestion. No API-key auth: the SNS signature (verified
    // against Amazon's cert on an allowlisted host, plus the topic
    // allowlist) IS the authentication. Everything in the body is untrusted
    // until verifySnsMessage says otherwise.
    app.post("/ses/events", async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json(errorBody(400, "invalid_payload", "Body must be JSON"), 400);
      }
      const parsed = snsMessageSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json(errorBody(400, "invalid_payload", "Not an SNS message"), 400);
      }
      const msg: SnsMessage = parsed.data;
      const verdict = await verifySnsMessage(msg, {
        fetchCert: sns.fetchCert,
        allowedTopicArns: sns.allowedTopicArns,
      });
      if (!verdict.ok) {
        return c.json(errorBody(403, "forbidden", "SNS message rejected"), 403);
      }

      if (msg.Type === "SubscriptionConfirmation") {
        // Fetch only AWS's own URL — a signed message from an allowlisted
        // topic still doesn't get to point us at arbitrary hosts.
        if (!msg.SubscribeURL || !isAllowedSnsUrl(msg.SubscribeURL)) {
          return c.json(errorBody(400, "invalid_payload", "SubscribeURL rejected"), 400);
        }
        await (sns.confirmSubscription ?? fetchSubscribeUrl)(msg.SubscribeURL);
        return c.json({ ok: true }, 200);
      }

      if (msg.Type === "Notification") {
        let inner: unknown;
        try {
          inner = JSON.parse(msg.Message);
        } catch {
          // Verified but not JSON: ack so SNS stops redelivering something
          // a retry can never fix.
          return c.json({ ok: true }, 200);
        }
        const event = parseSesEvent(inner);
        if (event) {
          // The SNS MessageId dedupes redeliveries twice over: as the queue
          // singletonKey while a job is queued, and durably in the handler
          // via the unique email_events.sns_message_id.
          await sns.enqueueSesEvent(
            { ...event, occurredAt: event.occurredAt.toISOString() },
            msg.MessageId,
          );
        }
        return c.json({ ok: true }, 200);
      }

      // UnsubscribeConfirmation: acknowledged, nothing to do.
      return c.json({ ok: true }, 200);
    });
  }

  return app;
}
