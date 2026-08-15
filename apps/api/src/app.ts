import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  type ApiKeyAuth,
  acceptEmail,
  authenticateApiKey,
  beginIdempotent,
  canonicalBodyHash,
  completeIdempotent,
  decryptEmailBody,
  extractTokenPrefix,
  fetchDeliverabilityHealth,
  type Keyring,
  PAUSE_BOUNCE_RATE,
  PAUSE_COMPLAINT_RATE,
  releaseIdempotent,
  segmentFilterSchema,
  segmentWhere,
  verifySenderDomain,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SegmentFilter } from "@millionsend/db/schema";
import type { SerializedSesEvent } from "@millionsend/queue";
import {
  type CertFetcher,
  isAllowedSnsUrl,
  parseSesEvent,
  type SnsMessage,
  snsMessageSchema,
  verifySnsMessage,
} from "@millionsend/ses";
import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { createMiddleware } from "hono/factory";
import {
  audienceResponseSchema,
  broadcastIdResponseSchema,
  cancelBroadcastResponseSchema,
  contactIdResponseSchema,
  createAudienceRequestSchema,
  createBroadcastRequestSchema,
  createContactRequestSchema,
  createSegmentRequestSchema,
  createTopicRequestSchema,
  errorSchema,
  getBroadcastResponseSchema,
  getContactResponseSchema,
  getEmailResponseSchema,
  getSegmentResponseSchema,
  type ListQuery,
  listAudiencesResponseSchema,
  listBroadcastsResponseSchema,
  listContactsResponseSchema,
  listQuerySchema,
  listSegmentsResponseSchema,
  listTopicsResponseSchema,
  removeAudienceResponseSchema,
  removeBroadcastResponseSchema,
  removeContactResponseSchema,
  removeSegmentResponseSchema,
  removeTopicResponseSchema,
  segmentResponseSchema,
  sendBroadcastRequestSchema,
  sendEmailRequestSchema,
  sendEmailResponseSchema,
  topicIdResponseSchema,
  topicResponseSchema,
  updateBroadcastRequestSchema,
  updateContactRequestSchema,
  updateContactTopicsRequestSchema,
  updateContactTopicsResponseSchema,
  updateSegmentRequestSchema,
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
  /**
   * Broadcast emails embed unsubscribe links built from APP_BASE_URL; without
   * it POST /broadcasts/{id}/send is rejected (same precondition the web
   * router enforces).
   */
  appBaseUrl?: string | undefined;
}

type Env = { Variables: { auth: ApiKeyAuth } };

class IdempotencyTakeoverError extends Error {
  constructor() {
    super("idempotency claim taken over");
  }
}

function errorBody(status: number, name: string, message: string) {
  return { statusCode: status, name, message };
}

/**
 * Coerces an incoming contact `properties` record to a flat string→string map
 * (Resend property values are strings): scalars pass through `String()`, null
 * clears a key (omitted). A nested object or array is invalid — returns null so
 * the caller answers 422 rather than silently storing structured JSON.
 */
function coerceContactProperties(input: Record<string, unknown>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object") return null;
    out[key] = String(value);
  }
  return out;
}

async function fetchSubscribeUrl(subscribeUrl: string): Promise<void> {
  const res = await fetch(subscribeUrl);
  if (!res.ok) throw new Error(`SNS subscription confirmation failed: ${res.status}`);
}

/**
 * The emails table encrypts content at rest; request logs must not become a
 * plaintext copy. Content-bearing fields lose their value before storage.
 */
const REDACTED_REQUEST_FIELDS = ["html", "text", "attachments"] as const;

function redactRequestBody(body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body;
  const copy: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const field of REDACTED_REQUEST_FIELDS) {
    if (field in copy) copy[field] = "[redacted]";
  }
  return copy;
}

const LOGGED_JSON_MAX_BYTES = 16 * 1024;

/** Oversized (or unserializable) payloads store a marker instead of the JSON. */
function capLoggedJson(value: unknown): unknown {
  if (value == null) return null;
  try {
    if (JSON.stringify(value).length > LOGGED_JSON_MAX_BYTES) return { truncated: true };
  } catch {
    return null;
  }
  return value;
}

/**
 * Keyset pagination for the Resend list endpoints: limit 1-100 (default 20),
 * `after`/`before` cursors are item ids, rows ordered by (created_at, id).
 */
async function keysetPage<R>(opts: {
  query: ListQuery;
  createdAt: AnyPgColumn;
  id: AnyPgColumn;
  /** Resolves a cursor id to its sort key, scoped to the caller's team. */
  loadCursor: (id: string) => Promise<{ createdAt: Date; id: string } | undefined>;
  loadRows: (cond: SQL | undefined, descending: boolean, take: number) => Promise<R[]>;
}): Promise<{ rows: R[]; hasMore: boolean } | "bad_cursor"> {
  const { query } = opts;
  const limit = query.limit ?? 20;
  const cursorId = query.before ?? query.after;
  let cond: SQL | undefined;
  if (cursorId) {
    const cur = await opts.loadCursor(cursorId);
    if (!cur) return "bad_cursor";
    cond = query.before
      ? sql`(${opts.createdAt}, ${opts.id}) < (${cur.createdAt}, ${cur.id}::uuid)`
      : sql`(${opts.createdAt}, ${opts.id}) > (${cur.createdAt}, ${cur.id}::uuid)`;
  }
  // One extra row decides has_more without a count query.
  const fetched = await opts.loadRows(cond, Boolean(query.before), limit + 1);
  const hasMore = fetched.length > limit;
  const rows = fetched.slice(0, limit);
  // `before` pages are fetched newest-first; responses stay oldest-first.
  if (query.before) rows.reverse();
  return { rows, hasMore };
}

/**
 * The SDK's Broadcast.status union is 'draft' | 'sent' | 'queued'; internal
 * scheduled/sending map to 'queued' at the wire. 'canceled' is a deliberate
 * superset extension (docs/resend-compatibility.md).
 */
function wireBroadcastStatus(status: string): string {
  return status === "scheduled" || status === "sending" ? "queued" : status;
}

/** Resend's opt_in/opt_out ⇄ our `subscribed` boolean (opt_in = subscribed). */
function wireSubscription(subscribed: boolean): "opt_in" | "opt_out" {
  return subscribed ? "opt_in" : "opt_out";
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
      request: { query: listQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: listAudiencesResponseSchema } },
          description: "Audiences",
        },
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const a = schema.audiences;
      const page = await keysetPage({
        query: c.req.valid("query"),
        createdAt: a.createdAt,
        id: a.id,
        loadCursor: async (id) =>
          (
            await db
              .select({ createdAt: a.createdAt, id: a.id })
              .from(a)
              .where(and(eq(a.id, id), eq(a.teamId, auth.teamId)))
          )[0],
        loadRows: (cond, descending, take) =>
          db
            .select()
            .from(a)
            .where(and(eq(a.teamId, auth.teamId), cond))
            .orderBy(
              ...(descending ? [desc(a.createdAt), desc(a.id)] : [asc(a.createdAt), asc(a.id)]),
            )
            .limit(take),
      });
      if (page === "bad_cursor") {
        return c.json(errorBody(422, "validation_error", "invalid pagination cursor"), 422);
      }
      return c.json(
        {
          object: "list" as const,
          data: page.rows.map((r) => ({
            id: r.id,
            name: r.name,
            created_at: r.createdAt.toISOString(),
          })),
          has_more: page.hasMore,
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
      let properties: Record<string, string> = {};
      if (body.properties !== undefined) {
        const coerced = coerceContactProperties(body.properties);
        if (coerced === null) {
          return c.json(
            errorBody(422, "validation_error", "contact properties must be flat string values"),
            422,
          );
        }
        properties = coerced;
      }
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
            properties,
          })
          .returning({ id: schema.contacts.id });
        if (!row) throw new Error("contact insert returned no row");
        return c.json({ object: "contact" as const, id: row.id }, 200);
      } catch (err) {
        if (isUniqueViolation(err)) {
          // "validation_error" (not "conflict"): the name must be a
          // RESEND_ERROR_CODE_KEY member for SDK clients.
          return c.json(errorBody(409, "validation_error", "Contact already exists"), 409);
        }
        throw err;
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: `/${prefix}/{audienceId}/contacts`,
      request: { params: audienceIdParam, query: listQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: listContactsResponseSchema } },
          description: "Contacts",
        },
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { audienceId } = c.req.valid("param");
      if (!(await findAudience(auth.teamId, audienceId))) {
        return c.json(errorBody(404, "not_found", "Audience not found"), 404);
      }
      const t = schema.contacts;
      const scoped = and(eq(t.audienceId, audienceId), eq(t.teamId, auth.teamId));
      const page = await keysetPage({
        query: c.req.valid("query"),
        createdAt: t.createdAt,
        id: t.id,
        loadCursor: async (id) =>
          (
            await db
              .select({ createdAt: t.createdAt, id: t.id })
              .from(t)
              .where(and(eq(t.id, id), scoped))
          )[0],
        loadRows: (cond, descending, take) =>
          db
            .select()
            .from(t)
            .where(and(scoped, cond))
            .orderBy(
              ...(descending ? [desc(t.createdAt), desc(t.id)] : [asc(t.createdAt), asc(t.id)]),
            )
            .limit(take),
      });
      if (page === "bad_cursor") {
        return c.json(errorBody(422, "validation_error", "invalid pagination cursor"), 422);
      }
      return c.json(
        {
          object: "list" as const,
          data: page.rows.map((r) => ({
            id: r.id,
            email: r.email,
            first_name: r.firstName,
            last_name: r.lastName,
            created_at: r.createdAt.toISOString(),
            unsubscribed: r.unsubscribed,
          })),
          has_more: page.hasMore,
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
          properties: contact.properties,
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
      let properties: Record<string, string> | undefined;
      if (body.properties !== undefined) {
        const coerced = coerceContactProperties(body.properties);
        if (coerced === null) {
          return c.json(
            errorBody(422, "validation_error", "contact properties must be flat string values"),
            422,
          );
        }
        properties = coerced;
      }
      const [row] = await db
        .update(schema.contacts)
        .set({
          updatedAt: new Date(),
          ...(body.first_name !== undefined ? { firstName: body.first_name } : {}),
          ...(body.last_name !== undefined ? { lastName: body.last_name } : {}),
          ...(body.unsubscribed !== undefined ? { unsubscribed: body.unsubscribed } : {}),
          ...(properties !== undefined ? { properties } : {}),
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

/**
 * Top-level /contacts, hit by the resend SDK (v6) whenever audienceId is
 * omitted: GET/PATCH/DELETE /contacts/{idOrEmail} resolve the contact across
 * every audience of the authenticated team; POST /contacts cannot be honored
 * (our contacts require an audience) and fails loudly.
 */
function registerContactRootRoutes(app: OpenAPIHono<Env>, db: Db): void {
  const jsonErr = (description: string) => ({
    content: { "application/json": { schema: errorSchema } },
    description,
  });
  const t = schema.contacts;

  // Same id-or-email resolution as the audience-scoped routes, minus the
  // audience filter — teamId stays the isolation boundary.
  const teamContactWhere = (teamId: string, idOrEmail: string) =>
    and(
      eq(t.teamId, teamId),
      z.uuid().safeParse(idOrEmail).success
        ? eq(t.id, idOrEmail)
        : sql`lower(${t.email}) = ${idOrEmail.toLowerCase()}`,
    );

  const idParam = z.object({ id: z.string().min(1) });

  // The SDK's POST /contacts has no audience, but our contacts require one:
  // reject loudly rather than 404 or a silent partial create.
  app.post("/contacts", async (c) =>
    c.json(errorBody(422, "validation_error", "audience_id is required"), 422),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/contacts",
      request: { query: listQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: listContactsResponseSchema } },
          description: "Contacts across all audiences",
        },
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const page = await keysetPage({
        query: c.req.valid("query"),
        createdAt: t.createdAt,
        id: t.id,
        loadCursor: async (id) =>
          (
            await db
              .select({ createdAt: t.createdAt, id: t.id })
              .from(t)
              .where(and(eq(t.id, id), eq(t.teamId, auth.teamId)))
          )[0],
        loadRows: (cond, descending, take) =>
          db
            .select()
            .from(t)
            .where(and(eq(t.teamId, auth.teamId), cond))
            .orderBy(
              ...(descending ? [desc(t.createdAt), desc(t.id)] : [asc(t.createdAt), asc(t.id)]),
            )
            .limit(take),
      });
      if (page === "bad_cursor") {
        return c.json(errorBody(422, "validation_error", "invalid pagination cursor"), 422);
      }
      return c.json(
        {
          object: "list" as const,
          data: page.rows.map((r) => ({
            id: r.id,
            email: r.email,
            first_name: r.firstName,
            last_name: r.lastName,
            created_at: r.createdAt.toISOString(),
            unsubscribed: r.unsubscribed,
          })),
          has_more: page.hasMore,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/contacts/{id}",
      request: { params: idParam },
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
      const { id } = c.req.valid("param");
      // ponytail: an email may exist in several audiences; reads return the
      // oldest match. Per-audience reads stay on /audiences/{id}/contacts.
      const [contact] = await db
        .select()
        .from(t)
        .where(teamContactWhere(auth.teamId, id))
        .orderBy(asc(t.createdAt), asc(t.id))
        .limit(1);
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
          properties: contact.properties,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/contacts/{id}",
      request: {
        params: idParam,
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
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      let properties: Record<string, string> | undefined;
      if (body.properties !== undefined) {
        const coerced = coerceContactProperties(body.properties);
        if (coerced === null) {
          return c.json(
            errorBody(422, "validation_error", "contact properties must be flat string values"),
            422,
          );
        }
        properties = coerced;
      }
      // An email cursor may match the same person in several audiences;
      // updating all of them is what an audience-less request means
      // (unsubscribing by email must not miss a copy).
      const rows = await db
        .update(t)
        .set({
          updatedAt: new Date(),
          ...(body.first_name !== undefined ? { firstName: body.first_name } : {}),
          ...(body.last_name !== undefined ? { lastName: body.last_name } : {}),
          ...(body.unsubscribed !== undefined ? { unsubscribed: body.unsubscribed } : {}),
          ...(properties !== undefined ? { properties } : {}),
        })
        .where(teamContactWhere(auth.teamId, id))
        .returning({ id: t.id });
      const first = rows[0];
      if (!first) return c.json(errorBody(404, "not_found", "Contact not found"), 404);
      return c.json({ object: "contact" as const, id: first.id }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/contacts/{id}",
      request: { params: idParam },
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
      const { id } = c.req.valid("param");
      // Audience-less delete removes every copy of the address (see PATCH).
      const rows = await db
        .delete(t)
        .where(teamContactWhere(auth.teamId, id))
        .returning({ id: t.id });
      const first = rows[0];
      if (!first) return c.json(errorBody(404, "not_found", "Contact not found"), 404);
      return c.json({ object: "contact" as const, contact: first.id, deleted: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/contacts/{id}/topics",
      request: {
        params: idParam,
        body: {
          content: { "application/json": { schema: updateContactTopicsRequestSchema } },
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: updateContactTopicsResponseSchema } },
          description: "Contact topic subscriptions updated",
        },
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const entries = c.req.valid("json");
      // An email may resolve to the same person across several audiences;
      // subscription state is set for every copy (see PATCH /contacts/{id}).
      const matched = await db
        .select({ id: t.id })
        .from(t)
        .where(teamContactWhere(auth.teamId, id));
      const first = matched[0];
      if (!first) return c.json(errorBody(404, "not_found", "Contact not found"), 404);
      if (entries.length === 0) return c.json({ id: first.id }, 200);

      // Topics are teamId-scoped: a subscription may only target one this
      // team owns, or a caller could write rows against another team's topic.
      const topicIds = [...new Set(entries.map((e) => e.id))];
      const owned = await db
        .select({ id: schema.topics.id })
        .from(schema.topics)
        .where(and(eq(schema.topics.teamId, auth.teamId), inArray(schema.topics.id, topicIds)));
      if (owned.length !== topicIds.length) {
        return c.json(errorBody(404, "not_found", "Topic not found"), 404);
      }

      const values = matched.flatMap((contact) =>
        entries.map((e) => ({
          contactId: contact.id,
          topicId: e.id,
          subscribed: e.subscription === "opt_in",
        })),
      );
      await db
        .insert(schema.contactTopicSubscriptions)
        .values(values)
        .onConflictDoUpdate({
          target: [
            schema.contactTopicSubscriptions.contactId,
            schema.contactTopicSubscriptions.topicId,
          ],
          set: {
            subscribed: sql`excluded.subscribed`,
            updatedAt: new Date(),
          },
        });
      return c.json({ id: first.id }, 200);
    },
  );
}

function registerTopicRoutes(app: OpenAPIHono<Env>, db: Db): void {
  const jsonErr = (description: string) => ({
    content: { "application/json": { schema: errorSchema } },
    description,
  });
  const idParam = z.object({ id: z.uuid() });
  const b = schema.topics;

  const toWire = (row: typeof schema.topics.$inferSelect) => ({
    id: row.id,
    name: row.name,
    ...(row.description !== null ? { description: row.description } : {}),
    default_subscription: wireSubscription(row.defaultSubscribed),
    created_at: row.createdAt.toISOString(),
  });

  app.openapi(
    createRoute({
      method: "post",
      path: "/topics",
      request: {
        body: { content: { "application/json": { schema: createTopicRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: topicIdResponseSchema } },
          description: "Topic created",
        },
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const [row] = await db
        .insert(b)
        .values({
          teamId: auth.teamId,
          name: body.name,
          description: body.description ?? null,
          // Immutable after creation (topics.ts): opt_in = subscribed unless
          // the contact opts out.
          defaultSubscribed: body.default_subscription === "opt_in",
        })
        .returning({ id: b.id });
      if (!row) throw new Error("topic insert returned no row");
      return c.json({ id: row.id }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/topics",
      responses: {
        200: {
          content: { "application/json": { schema: listTopicsResponseSchema } },
          description: "Topics",
        },
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const rows = await db
        .select()
        .from(b)
        .where(eq(b.teamId, auth.teamId))
        .orderBy(asc(b.createdAt), asc(b.id));
      return c.json({ data: rows.map(toWire) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/topics/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: topicResponseSchema } },
          description: "Topic",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const [row] = await db
        .select()
        .from(b)
        .where(and(eq(b.id, id), eq(b.teamId, auth.teamId)));
      if (!row) return c.json(errorBody(404, "not_found", "Topic not found"), 404);
      return c.json(toWire(row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/topics/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: removeTopicResponseSchema } },
          description: "Topic deleted",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const [row] = await db
        .delete(b)
        .where(and(eq(b.id, id), eq(b.teamId, auth.teamId)))
        .returning({ id: b.id });
      if (!row) return c.json(errorBody(404, "not_found", "Topic not found"), 404);
      return c.json({ id: row.id, object: "topic" as const, deleted: true as const }, 200);
    },
  );
}

/**
 * Segments — the real MillionSend segmentation feature (a saved filter over an
 * audience's contacts), mounted at /segments2 so it never collides with the
 * resend SDK's /segments audiences alias (docs/resend-compatibility.md).
 */
function registerSegmentRoutes(app: OpenAPIHono<Env>, db: Db): void {
  const jsonErr = (description: string) => ({
    content: { "application/json": { schema: errorSchema } },
    description,
  });
  const idParam = z.object({ id: z.uuid() });
  const s = schema.segments;

  const findAudience = async (teamId: string, id: string) =>
    (
      await db
        .select({ id: schema.audiences.id })
        .from(schema.audiences)
        .where(and(eq(schema.audiences.id, id), eq(schema.audiences.teamId, teamId)))
    )[0];

  const toWire = (row: typeof schema.segments.$inferSelect) => ({
    object: "segment" as const,
    id: row.id,
    name: row.name,
    audience_id: row.audienceId,
    filter: row.filter,
    created_at: row.createdAt.toISOString(),
  });

  // Live count of contacts the segment currently matches. Reuses the one
  // translator, so the count can never drift from what the fan-out targets.
  const contactCount = async (audienceId: string, filter: SegmentFilter): Promise<number> => {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.contacts)
      .where(
        and(eq(schema.contacts.audienceId, audienceId), segmentWhere(schema.contacts, filter)),
      );
    return row?.count ?? 0;
  };

  const filterError = (issues: string[]) => errorBody(422, "validation_error", issues.join("; "));

  app.openapi(
    createRoute({
      method: "post",
      path: "/segments2",
      request: {
        body: { content: { "application/json": { schema: createSegmentRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: segmentResponseSchema } },
          description: "Segment created",
        },
        404: jsonErr("Audience not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const body = c.req.valid("json");
      // Authoritative field/operator validation (the request schema only pins
      // the wire structure): a bad filter is a 422, never stored.
      const parsed = segmentFilterSchema.safeParse(body.filter);
      if (!parsed.success) {
        return c.json(filterError(parsed.error.issues.map((i) => i.message)), 422);
      }
      if (!(await findAudience(auth.teamId, body.audience_id))) {
        return c.json(errorBody(404, "not_found", "Audience not found"), 404);
      }
      const [row] = await db
        .insert(s)
        .values({
          teamId: auth.teamId,
          audienceId: body.audience_id,
          name: body.name,
          filter: parsed.data,
        })
        .returning();
      if (!row) throw new Error("segment insert returned no row");
      return c.json(toWire(row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/segments2",
      request: { query: listQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: listSegmentsResponseSchema } },
          description: "Segments",
        },
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const page = await keysetPage({
        query: c.req.valid("query"),
        createdAt: s.createdAt,
        id: s.id,
        loadCursor: async (id) =>
          (
            await db
              .select({ createdAt: s.createdAt, id: s.id })
              .from(s)
              .where(and(eq(s.id, id), eq(s.teamId, auth.teamId)))
          )[0],
        loadRows: (cond, descending, take) =>
          db
            .select()
            .from(s)
            .where(and(eq(s.teamId, auth.teamId), cond))
            .orderBy(
              ...(descending ? [desc(s.createdAt), desc(s.id)] : [asc(s.createdAt), asc(s.id)]),
            )
            .limit(take),
      });
      if (page === "bad_cursor") {
        return c.json(errorBody(422, "validation_error", "invalid pagination cursor"), 422);
      }
      return c.json(
        { object: "list" as const, data: page.rows.map(toWire), has_more: page.hasMore },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/segments2/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: getSegmentResponseSchema } },
          description: "Segment",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const [row] = await db
        .select()
        .from(s)
        .where(and(eq(s.id, c.req.valid("param").id), eq(s.teamId, auth.teamId)));
      if (!row) return c.json(errorBody(404, "not_found", "Segment not found"), 404);
      return c.json(
        { ...toWire(row), contact_count: await contactCount(row.audienceId, row.filter) },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/segments2/{id}",
      request: {
        params: idParam,
        body: { content: { "application/json": { schema: updateSegmentRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: segmentResponseSchema } },
          description: "Segment updated",
        },
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      let filter: SegmentFilter | undefined;
      if (body.filter !== undefined) {
        const parsed = segmentFilterSchema.safeParse(body.filter);
        if (!parsed.success) {
          return c.json(filterError(parsed.error.issues.map((i) => i.message)), 422);
        }
        filter = parsed.data;
      }
      const [row] = await db
        .update(s)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(filter !== undefined ? { filter } : {}),
        })
        .where(and(eq(s.id, id), eq(s.teamId, auth.teamId)))
        .returning();
      if (!row) return c.json(errorBody(404, "not_found", "Segment not found"), 404);
      return c.json(toWire(row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/segments2/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: removeSegmentResponseSchema } },
          description: "Segment deleted",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const [row] = await db
        .delete(s)
        .where(and(eq(s.id, id), eq(s.teamId, auth.teamId)))
        .returning({ id: s.id });
      if (!row) return c.json(errorBody(404, "not_found", "Segment not found"), 404);
      return c.json({ object: "segment" as const, id: row.id, deleted: true as const }, 200);
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

  const findTopic = async (teamId: string, id: string) =>
    (
      await db
        .select({ id: schema.topics.id })
        .from(schema.topics)
        .where(and(eq(schema.topics.id, id), eq(schema.topics.teamId, teamId)))
    )[0];

  const findSegment = async (teamId: string, id: string) =>
    (
      await db
        .select({ id: schema.segments.id, audienceId: schema.segments.audienceId })
        .from(schema.segments)
        .where(and(eq(schema.segments.id, id), eq(schema.segments.teamId, teamId)))
    )[0];

  // The wire `segment_id` is the resend alias for the target (= audienceId) OR,
  // when it names a real MillionSend segment, that segment — resolve which. A
  // real segment is authoritative for the audience it filters. Falls back to the
  // audience alias so a resend client passing an audience id as segmentId still
  // works.
  const resolveTarget = async (
    teamId: string,
    audience_id: string | undefined,
    segment_id: string | undefined,
  ): Promise<{ audienceId: string | undefined; segmentId: string | null }> => {
    if (segment_id !== undefined) {
      const seg = await findSegment(teamId, segment_id);
      if (seg) return { audienceId: seg.audienceId, segmentId: seg.id };
    }
    return { audienceId: audience_id ?? segment_id, segmentId: null };
  };

  // Accepted into the request schema so unsupported Resend knobs fail loudly
  // instead of being silently stripped (docs/resend-compatibility.md).
  const unsupported = (body: {
    preview_text?: string | undefined;
    send?: boolean | undefined;
    scheduled_at?: string | undefined;
  }): string | null => {
    if (body.preview_text !== undefined) return "preview_text is not yet supported";
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
      const { audienceId, segmentId } = await resolveTarget(
        auth.teamId,
        body.audience_id,
        body.segment_id,
      );
      if (!audienceId || !(await findAudience(auth.teamId, audienceId))) {
        return c.json(errorBody(404, "not_found", "Audience not found"), 404);
      }
      if (body.topic_id != null && !(await findTopic(auth.teamId, body.topic_id))) {
        return c.json(errorBody(404, "not_found", "Topic not found"), 404);
      }
      const [row] = await db
        .insert(schema.broadcasts)
        .values({
          teamId: auth.teamId,
          audienceId,
          segmentId,
          topicId: body.topic_id ?? null,
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
      request: { query: listQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: listBroadcastsResponseSchema } },
          description: "Broadcasts",
        },
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const b = schema.broadcasts;
      const page = await keysetPage({
        query: c.req.valid("query"),
        createdAt: b.createdAt,
        id: b.id,
        loadCursor: async (id) =>
          (
            await db
              .select({ createdAt: b.createdAt, id: b.id })
              .from(b)
              .where(and(eq(b.id, id), eq(b.teamId, auth.teamId)))
          )[0],
        loadRows: (cond, descending, take) =>
          db
            .select()
            .from(b)
            .where(and(eq(b.teamId, auth.teamId), cond))
            .orderBy(
              ...(descending ? [desc(b.createdAt), desc(b.id)] : [asc(b.createdAt), asc(b.id)]),
            )
            .limit(take),
      });
      if (page === "bad_cursor") {
        return c.json(errorBody(422, "validation_error", "invalid pagination cursor"), 422);
      }
      return c.json(
        {
          object: "list" as const,
          data: page.rows.map((r) => ({
            id: r.id,
            name: r.name,
            audience_id: r.audienceId,
            // Real segment if linked, else the resend audience alias.
            segment_id: r.segmentId ?? r.audienceId,
            status: wireBroadcastStatus(r.status),
            created_at: r.createdAt.toISOString(),
            scheduled_at: r.scheduledAt?.toISOString() ?? null,
            sent_at: r.sentAt?.toISOString() ?? null,
          })),
          has_more: page.hasMore,
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
          // Real segment if linked, else the resend audience alias.
          segment_id: broadcast.segmentId ?? broadcast.audienceId,
          from: broadcast.from,
          subject: broadcast.subject,
          reply_to: parseReplyTo(broadcast.replyTo),
          preview_text: null,
          topic_id: broadcast.topicId,
          html: broadcast.html,
          text: broadcast.text,
          status: wireBroadcastStatus(broadcast.status),
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
        return c.json(
          errorBody(400, "invalid_parameter", "Only draft broadcasts can be updated"),
          400,
        );
      }
      // Retarget only when the caller sends audience_id or segment_id; a real
      // segment sets both, an audience alias sets the audience and clears any
      // stale segment link.
      const retarget = body.audience_id !== undefined || body.segment_id !== undefined;
      let audienceId: string | undefined;
      let segmentId: string | null | undefined;
      if (retarget) {
        ({ audienceId, segmentId } = await resolveTarget(
          auth.teamId,
          body.audience_id,
          body.segment_id,
        ));
        if (audienceId === undefined || !(await findAudience(auth.teamId, audienceId))) {
          return c.json(errorBody(404, "not_found", "Audience not found"), 404);
        }
      }
      if (body.topic_id != null && !(await findTopic(auth.teamId, body.topic_id))) {
        return c.json(errorBody(404, "not_found", "Topic not found"), 404);
      }
      const [row] = await db
        .update(schema.broadcasts)
        .set({
          updatedAt: new Date(),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(audienceId !== undefined ? { audienceId } : {}),
          ...(segmentId !== undefined ? { segmentId } : {}),
          ...(body.topic_id !== undefined ? { topicId: body.topic_id } : {}),
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
        return c.json(
          errorBody(400, "invalid_parameter", "Only draft broadcasts can be updated"),
          400,
        );
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
        return c.json(
          errorBody(400, "invalid_parameter", "Only draft broadcasts can be deleted"),
          400,
        );
      }
      const [row] = await db
        .delete(schema.broadcasts)
        .where(and(eq(schema.broadcasts.id, id), eq(schema.broadcasts.status, "draft")))
        .returning({ id: schema.broadcasts.id });
      if (!row) {
        return c.json(
          errorBody(400, "invalid_parameter", "Only draft broadcasts can be deleted"),
          400,
        );
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
        403: jsonErr("Sending paused"),
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
        return c.json(
          errorBody(400, "invalid_parameter", "Only draft broadcasts can be sent"),
          400,
        );
      }
      if (!broadcast.audienceId) {
        return c.json(errorBody(422, "validation_error", "The audience no longer exists"), 422);
      }
      // Same precondition the web router enforces: unsubscribe links are
      // built from APP_BASE_URL, and a broadcast without them must not go out.
      if (!deps.appBaseUrl) {
        return c.json(
          errorBody(
            422,
            "validation_error",
            "APP_BASE_URL is not set. Unsubscribe links are built from it. Set it, restart, send again.",
          ),
          422,
        );
      }
      // Server-authoritative deliverability guardrail: a raw API client must not
      // bypass what the dashboard enforces. If the team's trailing-window bounce
      // or complaint rate has crossed SES's own pause line, block new broadcast
      // sends here — before scheduling — so we stop sending before SES pauses the
      // whole account. `sending_paused` is a MillionSend-specific error outside
      // Resend's SDK union (see docs/resend-compatibility.md, known deltas).
      const health = await fetchDeliverabilityHealth(db, auth.teamId);
      const paused = health.reasons.find((r) => r.tier === "paused");
      if (paused) {
        const limit = paused.metric === "bounce" ? PAUSE_BOUNCE_RATE : PAUSE_COMPLAINT_RATE;
        const pct = (r: number) => `${(r * 100).toFixed(2)}%`;
        return c.json(
          errorBody(
            403,
            "sending_paused",
            `Sending is paused: your ${paused.metric} rate of ${pct(paused.rate)} over the last ${health.windowDays} days is at or above the ${pct(limit)} limit. Lower it before sending new broadcasts.`,
          ),
          403,
        );
      }
      // Same boundary as /emails: only a verified team domain may appear as
      // the sender.
      const domain = await verifySenderDomain(db, auth.teamId, broadcast.from);
      if (!domain.ok) {
        return c.json(
          errorBody(
            422,
            "validation_error",
            domain.reason === "invalid_sender"
              ? "from must be a single address"
              : `The ${domain.fromDomain} domain is not verified for this team`,
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
        return c.json(
          errorBody(400, "invalid_parameter", "Only draft broadcasts can be sent"),
          400,
        );
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
          errorBody(400, "invalid_parameter", "Only scheduled broadcasts can be canceled"),
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

  // After-response request logging, authenticated requests only — an
  // unauthenticated 401 has no team to attribute the row to. /ses/events is
  // excluded entirely (SNS traffic, not a customer API call). Fire-and-forget:
  // a logging failure must never fail or slow the response. Headers are never
  // stored (Authorization included); request bodies are redacted and capped.
  app.use("*", async (c, next) => {
    await next();
    const auth = c.get("auth");
    if (!auth || c.req.path.startsWith("/ses/")) return;
    const { method, path } = c.req;
    const statusCode = c.res.status;
    // Cloned before the response is returned; both body reads happen off the
    // request's critical path.
    const resClone = c.res.clone();
    void (async () => {
      const requestBody =
        method === "GET" || method === "HEAD"
          ? null
          : redactRequestBody(await c.req.json().catch(() => null));
      // Responses carry decrypted content too (GET /emails/{id} returns
      // html/text) — redacted the same way, or the log becomes a plaintext
      // copy of the encrypted body.
      const responseBody = redactRequestBody(await resClone.json().catch(() => null));
      await deps.db.insert(schema.apiRequests).values({
        teamId: auth.teamId,
        method,
        path,
        statusCode,
        requestBody: capLoggedJson(requestBody),
        responseBody: capLoggedJson(responseBody),
      });
    })().catch((err) => console.error("api request log failed", err));
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
    const auth = await authenticateApiKey(deps.db, token);
    if (!auth) {
      return c.json(errorBody(401, "invalid_api_key", "API key is invalid"), 401);
    }
    c.set("auth", auth);
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

  // Top-level /contacts, used by the SDK when no audienceId is given.
  app.use("/contacts", requireApiKey);
  app.use("/contacts/*", requireApiKey);
  registerContactRootRoutes(app, deps.db);

  // Real segmentation (MillionSend extension). /segments2, not /segments — the
  // latter is the resend audiences alias registered above.
  app.use("/segments2", requireApiKey);
  app.use("/segments2/*", requireApiKey);
  registerSegmentRoutes(app, deps.db);

  app.use("/broadcasts", requireApiKey);
  app.use("/broadcasts/*", requireApiKey);
  registerBroadcastRoutes(app, deps);

  app.use("/topics", requireApiKey);
  app.use("/topics/*", requireApiKey);
  registerTopicRoutes(app, deps.db);

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
    // Rejected loudly instead of silently stripped (docs/resend-compatibility.md).
    if (body.headers !== undefined) {
      return c.json(errorBody(422, "validation_error", "headers are not yet supported"), 422);
    }
    if (body.topic_id != null) {
      return c.json(errorBody(422, "validation_error", "topic_id is not yet supported"), 422);
    }

    const domain = await verifySenderDomain(deps.db, auth.teamId, body.from);
    if (!domain.ok) {
      return c.json(
        errorBody(
          422,
          "validation_error",
          domain.reason === "invalid_sender"
            ? "from must be a single address"
            : `The ${domain.fromDomain} domain is not verified for this team`,
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
      const result = await acceptEmail(
        deps,
        auth,
        {
          from: body.from,
          to: body.to,
          cc: body.cc,
          bcc: body.bcc,
          replyTo: body.reply_to,
          subject: body.subject,
          html: body.html,
          text: body.text,
          tags: body.tags ? Object.fromEntries(body.tags.map((t) => [t.name, t.value])) : null,
          scheduledAt: body.scheduled_at ? new Date(body.scheduled_at) : undefined,
          domainId: domain.domainId,
        },
        {
          completeInTx: idemKey
            ? async (tx, emailId) => {
                const recorded = await completeIdempotent(tx, {
                  teamId: auth.teamId,
                  key: idemKey,
                  emailIds: [emailId],
                });
                // Another owner took over and recorded its own response:
                // abort so this branch produces no second email.
                if (!recorded) throw new IdempotencyTakeoverError();
              }
            : undefined,
        },
      );
      if (!result.ok) {
        if (idemKey) await releaseIdempotent(deps.db, { teamId: auth.teamId, key: idemKey });
        return c.json(errorBody(422, "validation_error", "All recipients are suppressed"), 422);
      }
      return c.json({ id: result.id }, 200);
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
        // SES returns a bare message id; the RFC 5322 Message-ID header SES
        // writes is '<id@<region>.amazonses.com>'. Unsent emails get a
        // placeholder so the field (required by the SDK) is always present.
        message_id: email.sesMessageId
          ? email.sesMessageId.startsWith("<")
            ? email.sesMessageId
            : `<${email.sesMessageId}@email.amazonses.com>`
          : `<${email.id}@unsent.millionsend>`,
        // Internal quota-parking is invisible on the wire: the SDK's
        // last_event union has no 'queued_quota'.
        last_event: email.latestStatus === "queued_quota" ? "queued" : email.latestStatus,
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
