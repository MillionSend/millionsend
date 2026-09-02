import { getConnInfo } from "@hono/node-server/conninfo";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  type AcceptEmailPayload,
  type AcceptEmailResult,
  type ApiKeyAuth,
  acceptEmail,
  authenticateApiKey,
  beginIdempotent,
  CONTACT_PROPERTY_VALUE_MAX_LENGTH,
  type ContactActivityRow,
  canonicalBodyHash,
  clearUnsubscribeSuppression,
  completeIdempotent,
  DAY_MS,
  decryptEmailBody,
  eraseRecipient,
  estimateAttachmentBytes,
  extractTokenPrefix,
  fetchAccountScore,
  fetchDeliverabilityHealth,
  fetchEmailInsights,
  findSuppressed,
  findTopicOptOuts,
  type Keyring,
  MAX_ATTACHMENT_BYTES,
  PAUSE_BOUNCE_RATE,
  PAUSE_COMPLAINT_RATE,
  parseScheduledAt,
  recordContactActivity,
  releaseIdempotent,
  SCHEDULED_AT_FORMS,
  scoreBand,
  segmentContactsWhere,
  segmentFilterSchema,
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
import { and, asc, desc, eq, inArray, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { secureHeaders } from "hono/secure-headers";
import { INTERNAL_AUTH, registerMcp } from "./mcp.js";
import { registerApiKeyRoutes } from "./routes/api-keys.js";
import { registerContactPropertyRoutes } from "./routes/contact-properties.js";
import { type DomainsSesDeps, registerDomainRoutes } from "./routes/domains.js";
import { registerSuppressionRoutes } from "./routes/suppressions.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import {
  addContactSegmentResponseSchema,
  batchContactsHeadersSchema,
  batchContactsQuerySchema,
  batchContactsRequestSchema,
  batchContactsResponseSchema,
  batchEmailRequestSchema,
  batchEmailResponseSchema,
  broadcastIdResponseSchema,
  type CreateContactRequest,
  cancelBroadcastResponseSchema,
  cancelEmailResponseSchema,
  contactIdResponseSchema,
  createBroadcastRequestSchema,
  createContactRequestSchema,
  createSegmentRequestSchema,
  createTopicRequestSchema,
  deliverabilityResponseSchema,
  emailInsightsResponseSchema,
  errorSchema,
  getBroadcastResponseSchema,
  getContactResponseSchema,
  getEmailResponseSchema,
  getSegmentResponseSchema,
  type ListQuery,
  listBroadcastsResponseSchema,
  listContactsResponseSchema,
  listEmailsResponseSchema,
  listQuerySchema,
  listSegmentsResponseSchema,
  listTopicsResponseSchema,
  removeBroadcastResponseSchema,
  removeContactResponseSchema,
  removeContactSegmentResponseSchema,
  removeEmailResponseSchema,
  removeSegmentResponseSchema,
  removeTopicResponseSchema,
  type SendEmailRequest,
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
  updateEmailRequestSchema,
  updateEmailResponseSchema,
  updateSegmentRequestSchema,
  updateTopicRequestSchema,
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
  /** SES identity management; omitted → the /domains routes do not exist (404). */
  ses?: DomainsSesDeps | undefined;
  /**
   * Broadcast emails embed unsubscribe links built from APP_BASE_URL; without
   * it POST /broadcasts/{id}/send is rejected (same precondition the web
   * router enforces).
   */
  appBaseUrl?: string | undefined;
  /**
   * Public origin of this API, when a reverse proxy serves it somewhere other
   * than port 3001 of the dashboard host. Omitted → derived from appBaseUrl.
   * MCP tokens are bound to it, so it must match what clients actually dial.
   */
  publicApiUrl?: string | undefined;
  /**
   * Whether a domain may adopt a branded tracking subdomain (a customer CNAME
   * pointing at this app). Omitted means yes; false drops the CNAME from the
   * DNS checklist and refuses to store one, for a deployment that holds no
   * certificate for customer-owned hostnames.
   */
  trackingSubdomains?: boolean | undefined;
  /** Per-key fixed-window request cap. Defaults to 600 requests/minute. */
  rateLimitPerMinute?: number | undefined;
  /** Deployed source revision, reported by /health. */
  revision?: string | undefined;
  /**
   * Per-team fixed-window request cap across all of the team's keys, so
   * minting keys cannot multiply the per-key cap. Defaults to 3000/minute.
   */
  teamRateLimitPerMinute?: number | undefined;
}

export type Env = { Variables: { auth: ApiKeyAuth; rateLimited: boolean } };

class IdempotencyTakeoverError extends Error {
  constructor() {
    super("idempotency claim taken over");
  }
}

export function errorBody(status: number, name: string, message: string) {
  return { statusCode: status, name, message };
}

/** Wire message for a failed schema parse: `path: issue; path: issue`. */
export function validationMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

/**
 * SECURITY: a domain-scoped API key (domainId set) may only send from that one
 * verified domain; a null domainId sends from any of the team's domains. The
 * scope is server-side, resolved from the authenticated key — never the payload.
 */
function keyForbidsSendingDomain(auth: ApiKeyAuth, domainId: string): boolean {
  return auth.domainId !== null && auth.domainId !== domainId;
}

const RESTRICTED_DOMAIN_MESSAGE = "This API key can only send from its assigned domain";

/**
 * SECURITY: which of the team's emails a key may cancel, reschedule or
 * delete. A sending_access key is confined to its own sends and a
 * domain-scoped key to its domain; an unscoped full_access key manages the
 * whole team's mail. Rows outside the scope read as not found.
 */
function emailScopeConditions(auth: ApiKeyAuth): SQL[] {
  const conditions: SQL[] = [];
  if (auth.permission === "sending_access") {
    conditions.push(auth.apiKeyId ? eq(schema.emails.apiKeyId, auth.apiKeyId) : sql`false`);
  }
  if (auth.domainId !== null) conditions.push(eq(schema.emails.domainId, auth.domainId));
  return conditions;
}

/** Wire status + body for an accept the pipeline refused. */
function acceptRejection(result: Exclude<AcceptEmailResult, { ok: true }>) {
  switch (result.reason) {
    case "quota_backlog_full":
      return {
        status: 429 as const,
        body: errorBody(
          429,
          "daily_quota_exceeded",
          "Daily sending quota exceeded and the queued backlog is full; retry after the UTC day rolls over",
        ),
      };
    case "attachments_too_large":
      return {
        status: 422 as const,
        body: errorBody(
          422,
          "validation_error",
          `Attachments exceed ${Math.floor(result.maxBytes / (1024 * 1024))} MiB in total`,
        ),
      };
    case "all_suppressed":
      return {
        status: 422 as const,
        body: errorBody(422, "validation_error", "All recipients are suppressed"),
      };
  }
}

/**
 * Server-authoritative deliverability guardrail on every send surface: a raw
 * API client must not bypass what the dashboard enforces. If the team's
 * trailing-window bounce or complaint rate has crossed SES's own pause line,
 * new sends are refused so we stop before SES pauses the whole account.
 * `sending_paused` is a MillionSend-specific error outside Resend's SDK
 * union (see docs/resend-compatibility.md, known deltas). Returns the error
 * body, or null when sending may proceed.
 */
async function sendingPausedError(
  deps: Pick<ApiDeps, "db" | "isCloud">,
  auth: ApiKeyAuth,
): Promise<ReturnType<typeof errorBody> | null> {
  const health = await fetchDeliverabilityHealth(
    deps.db,
    auth.teamId,
    deps.isCloud ? { plan: auth.plan } : {},
  );
  const paused = health.reasons.find((r) => r.tier === "paused");
  if (!paused) return null;
  const limit = paused.metric === "bounce" ? PAUSE_BOUNCE_RATE : PAUSE_COMPLAINT_RATE;
  const pct = (r: number) => `${(r * 100).toFixed(2)}%`;
  return errorBody(
    403,
    "sending_paused",
    `Sending is paused: your ${paused.metric} rate of ${pct(paused.rate)} over the last ${health.windowDays} days is at or above the ${pct(limit)} limit. Lower it before sending again.`,
  );
}

/** Refusal from acceptEmail inside a caller-owned batch transaction. */
class AcceptRejectedError extends Error {
  constructor(
    readonly result: Exclude<AcceptEmailResult, { ok: true }>,
    readonly index: number,
  ) {
    super(`batch item ${index} refused: ${result.reason}`);
  }
}

/** Topic lookup scoped to the caller's team — a foreign topic id is a 404. */
async function findTeamTopic(
  db: Db,
  teamId: string,
  id: string,
): Promise<{ id: string } | undefined> {
  const [row] = await db
    .select({ id: schema.topics.id })
    .from(schema.topics)
    .where(and(eq(schema.topics.id, id), eq(schema.topics.teamId, teamId)));
  return row;
}

function findEmailInsights(
  db: Db,
  teamId: string,
  email: { id: string; broadcastId: string | null },
) {
  return fetchEmailInsights(db, teamId, { emailId: email.id, broadcastId: email.broadcastId });
}

/** Maps a validated Resend-shaped send body to the shared accept payload. */
function toAcceptPayload(body: SendEmailRequest, domainId: string): AcceptEmailPayload {
  // `content` is guaranteed by the schema's superRefine; the `?? ""` only
  // satisfies the optional wire type.
  const attachments = body.attachments?.map((a) => ({
    filename: a.filename,
    content: a.content ?? "",
    ...(a.content_type ? { contentType: a.content_type } : {}),
  }));
  return {
    from: body.from,
    to: body.to,
    cc: body.cc,
    bcc: body.bcc,
    replyTo: body.reply_to,
    subject: body.subject,
    html: body.html,
    text: body.text,
    tags: body.tags ? Object.fromEntries(body.tags.map((t) => [t.name, t.value])) : null,
    headers: body.headers && Object.keys(body.headers).length > 0 ? body.headers : undefined,
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
    // Schema-validated, so this always resolves; re-resolved here because
    // the wire value may be relative ("in 2 hours").
    scheduledAt: body.scheduled_at ? (parseScheduledAt(body.scheduled_at) ?? undefined) : undefined,
    domainId,
    topicId: body.topic_id ?? undefined,
  };
}

/** Registered property types by lower(key) — the registry index is
 * case-insensitive, and contact map keys are matched the same way. */
type ContactPropertyTypes = Map<string, "string" | "number">;

async function loadContactPropertyTypes(db: Db, teamId: string): Promise<ContactPropertyTypes> {
  const p = schema.contactProperties;
  const rows = await db.select({ key: p.key, type: p.type }).from(p).where(eq(p.teamId, teamId));
  return new Map(rows.map((r) => [r.key.toLowerCase(), r.type]));
}

/**
 * The numeric reading of a property value, or null when it has none:
 * String(value) must be non-blank and parse to a finite number (values are
 * stored as text, so this is the shared write-validate/read-back rule).
 */
export function numericPropertyValue(value: unknown): number | null {
  const str = String(value).trim();
  if (str === "") return null;
  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

/**
 * Coerces an incoming contact `properties` record to the stored flat
 * string→string map: scalars pass through `String()`, null clears a key
 * (omitted). Invalid — for a precise 422 rather than silently storing bad
 * data — are nested objects/arrays, and values for a key registered as
 * 'number' that don't parse to a finite number.
 */
function coerceContactProperties(
  input: Record<string, unknown>,
  types: ContactPropertyTypes,
): { ok: true; properties: Record<string, string> } | { ok: false; message: string } {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object") {
      return { ok: false, message: "contact properties must be flat string or number values" };
    }
    if (types.get(key.toLowerCase()) === "number" && numericPropertyValue(value) === null) {
      return { ok: false, message: `property "${key}" must be a number` };
    }
    const text = String(value);
    if (text.length > CONTACT_PROPERTY_VALUE_MAX_LENGTH) {
      return {
        ok: false,
        message: `property "${key}" exceeds ${CONTACT_PROPERTY_VALUE_MAX_LENGTH} characters`,
      };
    }
    out[key] = text;
  }
  return { ok: true, properties: out };
}

type WireContactPropertyValue =
  | { type: "string"; value: string }
  | { type: "number"; value: number };

/**
 * GET /contacts/{id} wire: each stored value wrapped as {type, value}, typed
 * per the team's registry. Unregistered keys — and number-typed values that
 * no longer parse (typed after the value was stored) — read as strings.
 */
function wireContactProperties(
  map: Record<string, string>,
  types: ContactPropertyTypes,
): Record<string, WireContactPropertyValue> {
  const out: Record<string, WireContactPropertyValue> = {};
  for (const [key, value] of Object.entries(map)) {
    const num = types.get(key.toLowerCase()) === "number" ? numericPropertyValue(value) : null;
    out[key] = num === null ? { type: "string", value } : { type: "number", value: num };
  }
  return out;
}

async function fetchSubscribeUrl(subscribeUrl: string): Promise<void> {
  const res = await fetch(subscribeUrl, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`SNS subscription confirmation failed: ${res.status}`);
}

/**
 * Request logs store metadata only: the emails table encrypts content at
 * rest and contacts carry PII, so neither request nor success-response bodies
 * are kept. Error responses are the one body stored — they are the API's own
 * messages, never a copy of the payload — and email path segments
 * (/contacts/{email}) are masked.
 */
function maskEmailPathSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Not percent-encoded; the raw segment is what gets inspected.
      }
      return decoded.includes("@") ? "[email]" : segment;
    })
    .join("/");
}

const RATE_WINDOW_MS = 60_000;
const RATE_COUNTER_SWEEP_SIZE = 10_000;
const AUTH_FAILURES_PER_MINUTE = 20;

/**
 * Fixed-window hit counter. Returns the count for `key` in the current
 * window after this hit, plus the seconds until the window rolls over.
 * ponytail: per-process; the DB bucket table is keyed by api_key uuid, so
 * move these there (text key) if the API ever runs more than one replica.
 */
function fixedWindowCounter() {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return (key: string, now = Date.now()): { count: number; retryAfterSec: number } => {
    const windowStart = now - (now % RATE_WINDOW_MS);
    if (hits.size > RATE_COUNTER_SWEEP_SIZE) {
      for (const [k, v] of hits) if (v.windowStart !== windowStart) hits.delete(k);
    }
    const current = hits.get(key);
    const count = current?.windowStart === windowStart ? current.count + 1 : 1;
    hits.set(key, { windowStart, count });
    return {
      count,
      retryAfterSec: Math.max(1, Math.ceil((windowStart + RATE_WINDOW_MS - now) / 1000)),
    };
  };
}

/**
 * Cloud sits behind Cloudflare only (the origin firewall admits nothing
 * else), so cf-connecting-ip is authoritative there; self-host reads the
 * socket. Null when unknowable (in-process requests) — never bucket those
 * together, or one shared bucket would throttle everyone.
 */
function clientIp(c: Context, isCloud: boolean): string | null {
  if (isCloud) return c.req.header("cf-connecting-ip") ?? null;
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

const LOGGED_JSON_MAX_BYTES = 16 * 1024;

/** Oversized (or unserializable) payloads store a marker instead of the JSON. */
function capLoggedJson(value: unknown): unknown {
  if (value == null) return null;
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > LOGGED_JSON_MAX_BYTES) {
      return { truncated: true };
    }
  } catch {
    return null;
  }
  return value;
}

/**
 * Keyset pagination for the Resend list endpoints: limit 1-100 (default 20),
 * `after`/`before` cursors are item ids, rows ordered by (created_at, id).
 */
export async function keysetPage<R>(opts: {
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

export function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  while (e instanceof Error) {
    if ((e as { code?: string }).code === "23505" || e.message.includes("duplicate key")) {
      return true;
    }
    e = e.cause;
  }
  return false;
}

function isForeignKeyViolation(err: unknown): boolean {
  let current: unknown = err;
  while (current instanceof Error) {
    if ((current as Error & { code?: string }).code === "23503") return true;
    current = current.cause;
  }
  return false;
}

/** ListContacts wire item, shared by GET /contacts and GET /segments/{id}/contacts. */
function contactListItem(r: typeof schema.contacts.$inferSelect) {
  return {
    id: r.id,
    email: r.email,
    first_name: r.firstName,
    last_name: r.lastName,
    created_at: r.createdAt.toISOString(),
    unsubscribed: r.unsubscribed,
  };
}

/**
 * Team-global contact CRUD: one row per (team, lower(email)), enforced by the
 * contacts_team_email_idx unique index. The resend SDK (v6) reaches these
 * paths whenever audienceId is omitted; passing audienceId routes it to the
 * legacy /audiences/{id}/contacts aliases registered below, which run the
 * same operations (audiences are a pure alias of segments in resend v6).
 */
function registerContactRootRoutes(app: OpenAPIHono<Env>, db: Db): void {
  const jsonErr = (description: string) => ({
    content: { "application/json": { schema: errorSchema } },
    description,
  });
  const t = schema.contacts;

  // The contact path segment may be the contact UUID or its email — the
  // resend SDK sends either, undistinguished. Email matching is
  // case-insensitive, mirroring the unique index.
  const teamContactWhere = (teamId: string, idOrEmail: string) =>
    and(
      eq(t.teamId, teamId),
      z.uuid().safeParse(idOrEmail).success
        ? eq(t.id, idOrEmail)
        : sql`lower(${t.email}) = ${idOrEmail.toLowerCase()}`,
    );

  const idParam = z.object({ id: z.string().min(1) });
  const membershipParams = z.object({ id: z.string().min(1), segmentId: z.uuid() });
  const audienceParams = z.object({ audienceId: z.uuid() });
  const audienceContactParams = z.object({ audienceId: z.uuid(), id: z.string().min(1) });

  const findContact = async (teamId: string, idOrEmail: string) =>
    (await db.select().from(t).where(teamContactWhere(teamId, idOrEmail)))[0];

  const contactDetailWire = (
    contact: typeof schema.contacts.$inferSelect,
    types: ContactPropertyTypes,
  ) => ({
    ...contactListItem(contact),
    object: "contact" as const,
    properties: wireContactProperties(contact.properties, types),
  });

  /**
   * The team's own segments among `ids` as id→name; unknown/foreign ids are
   * absent. The names feed activity-timeline snapshots.
   */
  const teamSegmentNames = async (teamId: string, ids: string[]): Promise<Map<string, string>> => {
    if (ids.length === 0) return new Map();
    const owned = await db
      .select({ id: schema.segments.id, name: schema.segments.name })
      .from(schema.segments)
      .where(and(eq(schema.segments.teamId, teamId), inArray(schema.segments.id, ids)));
    return new Map(owned.map((s) => [s.id, s.name]));
  };

  const teamTopicInfo = async (
    teamId: string,
    ids: string[],
  ): Promise<Map<string, { name: string; defaultSubscribed: boolean }>> => {
    if (ids.length === 0) return new Map();
    const owned = await db
      .select({
        id: schema.topics.id,
        name: schema.topics.name,
        defaultSubscribed: schema.topics.defaultSubscribed,
      })
      .from(schema.topics)
      .where(and(eq(schema.topics.teamId, teamId), inArray(schema.topics.id, ids)));
    return new Map(
      owned.map((r) => [r.id, { name: r.name, defaultSubscribed: r.defaultSubscribed }]),
    );
  };

  /**
   * Full-ownership variants: the map when every id is the team's own, else
   * null — truthy on ownership, so boolean call sites read the same.
   */
  const ownsSegments = async (teamId: string, ids: string[]) => {
    const owned = await teamSegmentNames(teamId, ids);
    return ids.every((id) => owned.has(id)) ? owned : null;
  };

  const ownsTopics = async (teamId: string, ids: string[]) => {
    const owned = await teamTopicInfo(teamId, ids);
    return ids.every((id) => owned.has(id)) ? owned : null;
  };

  // "validation_error" for 409 (not "conflict"): the name must be a
  // RESEND_ERROR_CODE_KEY member for SDK clients.
  type BatchItemError = { ok: false; status: 404 | 409 | 422; name: string; message: string };
  type BatchItemResult =
    | { ok: true; id: string; status: "created" | "updated" | "skipped" }
    | BatchItemError;
  type ContactConflictMode = "error" | "skip" | "upsert";

  /** One write per lower(email) — the key of the contacts unique index. */
  type BatchContactRow = {
    indices: number[];
    key: string;
    email: string;
    firstName: string | undefined;
    lastName: string | undefined;
    unsubscribed: boolean | undefined;
    properties: Record<string, string>;
    segmentIds: Set<string>;
    topicSubs: Map<string, boolean>;
  };

  const topicActivity = (
    teamId: string,
    contactId: string,
    topicId: string,
    subscribed: boolean,
    name: string | undefined,
  ): ContactActivityRow => ({
    teamId,
    contactId,
    type: subscribed ? "topic_opt_in" : "topic_opt_out",
    data: { topicId, name: name ?? null },
  });

  /**
   * Batch write shared by POST /contacts/batch and POST /contacts (a one-item
   * strict batch). Results align with `items` by index; an item handed in as
   * an error (wire-shape failure) passes through untouched. Strict mode
   * returns before the first write when any item failed, so the caller can
   * answer with that item's status; unattempted items are then undefined.
   *
   * SECURITY: segment/topic associations are validated against the caller's
   * team before anything is written — a foreign id must not link a contact
   * into another team's segment or topic. Contacts + associations commit in
   * one transaction, so a rejected association never leaves a bare contact
   * behind.
   *
   * Conflicts are classified from a pre-select that is not serializable with
   * concurrent writers: a contact created (or a segment/topic deleted) in
   * between fails the transaction with a unique/FK violation, and the batch is
   * re-classified against the new state — so the item lands as a conflict or
   * not-found, never as a 500.
   */
  const batchContactsOp = async (
    teamId: string,
    items: (CreateContactRequest | BatchItemError)[],
    opts: { onConflict: ContactConflictMode; strict: boolean },
  ): Promise<(BatchItemResult | undefined)[]> => {
    const { onConflict, strict } = opts;
    const results: (BatchItemResult | undefined)[] = items.map(() => undefined);
    const types = await loadContactPropertyTypes(db, teamId);
    const rows = new Map<string, BatchContactRow>();
    for (const [i, item] of items.entries()) {
      if ("ok" in item) {
        results[i] = item;
        continue;
      }
      let properties: Record<string, string> = {};
      if (item.properties !== undefined) {
        const coerced = coerceContactProperties(item.properties, types);
        if (!coerced.ok) {
          results[i] = {
            ok: false,
            status: 422,
            name: "validation_error",
            message: coerced.message,
          };
          continue;
        }
        properties = coerced.properties;
      }
      const key = item.email.toLowerCase();
      const segmentIds = new Set((item.segments ?? []).map((s) => s.id));
      // A topic repeated in the payload: the last entry wins, matching the
      // upsert semantics of PATCH /contacts/{id}/topics.
      const topicSubs = new Map(
        (item.topics ?? []).map((e) => [e.id, e.subscription === "opt_in"]),
      );
      const prior = rows.get(key);
      if (!prior) {
        rows.set(key, {
          indices: [i],
          key,
          email: item.email,
          firstName: item.first_name,
          lastName: item.last_name,
          unsubscribed: item.unsubscribed,
          properties,
          segmentIds,
          topicSubs,
        });
        continue;
      }
      if (onConflict === "error") {
        results[i] = {
          ok: false,
          status: 422,
          name: "validation_error",
          message: "Duplicate email in batch",
        };
        continue;
      }
      // skip: the first occurrence wins; upsert: collapse — later scalars
      // override, associations union.
      prior.indices.push(i);
      if (onConflict === "upsert") {
        if (item.first_name !== undefined) prior.firstName = item.first_name;
        if (item.last_name !== undefined) prior.lastName = item.last_name;
        if (item.unsubscribed !== undefined) prior.unsubscribed = item.unsubscribed;
        Object.assign(prior.properties, properties);
        for (const id of segmentIds) prior.segmentIds.add(id);
        for (const [id, sub] of topicSubs) prior.topicSubs.set(id, sub);
      }
    }

    const fail = (row: BatchContactRow, error: BatchItemError) => {
      for (const i of row.indices) results[i] = error;
    };
    const succeed = (
      row: BatchContactRow,
      id: string,
      status: "created" | "updated" | "skipped",
    ) => {
      for (const [n, i] of row.indices.entries()) {
        results[i] = { ok: true, id, status: n > 0 && onConflict === "skip" ? "skipped" : status };
      }
    };
    const notFound = (message: string): BatchItemError => ({
      ok: false,
      status: 404,
      name: "not_found",
      message,
    });

    for (let attempt = 0; ; attempt++) {
      const pending = [...rows.values()].filter((r) => results[r.indices[0] ?? -1] === undefined);
      const segmentNames = await teamSegmentNames(teamId, [
        ...new Set(pending.flatMap((r) => [...r.segmentIds])),
      ]);
      const topicInfo = await teamTopicInfo(teamId, [
        ...new Set(pending.flatMap((r) => [...r.topicSubs.keys()])),
      ]);
      const existing =
        pending.length === 0
          ? []
          : await db
              .select({ id: t.id, email: t.email, unsubscribed: t.unsubscribed })
              .from(t)
              .where(
                and(
                  eq(t.teamId, teamId),
                  inArray(
                    sql`lower(${t.email})`,
                    pending.map((r) => r.key),
                  ),
                ),
              );
      const existingByKey = new Map(existing.map((e) => [e.email.toLowerCase(), e]));
      const inserts: BatchContactRow[] = [];
      const updates: { row: BatchContactRow; found: (typeof existing)[number] }[] = [];
      for (const row of pending) {
        if ([...row.segmentIds].some((id) => !segmentNames.has(id))) {
          fail(row, notFound("Segment not found"));
        } else if ([...row.topicSubs.keys()].some((id) => !topicInfo.has(id))) {
          fail(row, notFound("Topic not found"));
        } else {
          const found = existingByKey.get(row.key);
          if (!found) inserts.push(row);
          else if (onConflict === "error") {
            fail(row, {
              ok: false,
              status: 409,
              name: "validation_error",
              message: "Contact already exists",
            });
          } else if (onConflict === "skip") succeed(row, found.id, "skipped");
          else updates.push({ row, found });
        }
      }
      if (strict && results.some((r) => r !== undefined && !r.ok)) return results;
      if (inserts.length === 0 && updates.length === 0) return results;

      try {
        const written = await db.transaction(async (tx) => {
          const idByKey = new Map<string, string>();
          if (inserts.length > 0) {
            const created = await tx
              .insert(t)
              .values(
                inserts.map((row) => ({
                  teamId,
                  email: row.email,
                  firstName: row.firstName ?? null,
                  lastName: row.lastName ?? null,
                  unsubscribed: row.unsubscribed ?? false,
                  ...(row.unsubscribed ? { unsubscribedAt: new Date() } : {}),
                  properties: row.properties,
                })),
              )
              .returning({ id: t.id, email: t.email });
            for (const c of created) idByKey.set(c.email.toLowerCase(), c.id);
          }
          for (const { row, found } of updates) {
            // A batch never re-subscribes anyone: unsubscribed:false on an
            // opted-out contact is ignored, and the retained one-click
            // suppression stays. Re-subscribing is the explicit PATCH.
            const unsubscribe = row.unsubscribed === true && !found.unsubscribed;
            await tx
              .update(t)
              .set({
                updatedAt: new Date(),
                ...(row.firstName !== undefined ? { firstName: row.firstName } : {}),
                ...(row.lastName !== undefined ? { lastName: row.lastName } : {}),
                ...(unsubscribe ? { unsubscribed: true, unsubscribedAt: new Date() } : {}),
                ...(Object.keys(row.properties).length > 0
                  ? { properties: sql`${t.properties} || ${JSON.stringify(row.properties)}::jsonb` }
                  : {}),
              })
              .where(and(eq(t.id, found.id), eq(t.teamId, teamId)));
            idByKey.set(row.key, found.id);
          }
          const writtenRows = [...inserts, ...updates.map((u) => u.row)].map((row) => {
            const id = idByKey.get(row.key);
            if (!id) throw new Error("contact write returned no row");
            return { row, id };
          });
          const m = schema.segmentMembers;
          const memberValues = writtenRows.flatMap(({ row, id }) =>
            [...row.segmentIds].map((segmentId) => ({ segmentId, contactId: id })),
          );
          // Idempotent: `returning` lists only first joins, so the timeline
          // records those alone.
          const added =
            memberValues.length === 0
              ? []
              : await tx
                  .insert(m)
                  .values(memberValues)
                  .onConflictDoNothing()
                  .returning({ segmentId: m.segmentId, contactId: m.contactId });
          const s = schema.contactTopicSubscriptions;
          const updatedIds = updates.map((u) => u.found.id);
          // Effective state before the upsert (explicit row, else the topic's
          // default) — the timeline records only real transitions.
          const prior =
            updatedIds.length === 0 || topicInfo.size === 0
              ? []
              : await tx
                  .select({ contactId: s.contactId, topicId: s.topicId, subscribed: s.subscribed })
                  .from(s)
                  .where(
                    and(
                      inArray(s.contactId, updatedIds),
                      inArray(s.topicId, [...topicInfo.keys()]),
                    ),
                  );
          const subValues = writtenRows.flatMap(({ row, id }) =>
            [...row.topicSubs].map(([topicId, subscribed]) => ({
              contactId: id,
              topicId,
              subscribed,
            })),
          );
          if (subValues.length > 0) {
            await tx
              .insert(s)
              .values(subValues)
              .onConflictDoUpdate({
                target: [s.contactId, s.topicId],
                set: { subscribed: sql`excluded.subscribed`, updatedAt: new Date() },
              });
          }
          return { writtenRows, added, prior };
        });

        const activity: ContactActivityRow[] = [];
        const priorSubs = new Map(
          written.prior.map((p) => [`${p.contactId}:${p.topicId}`, p.subscribed]),
        );
        const updatedBy = new Map(updates.map((u) => [u.found.id, u]));
        for (const { row, id } of written.writtenRows) {
          const update = updatedBy.get(id);
          if (!update) {
            succeed(row, id, "created");
            activity.push({ teamId, contactId: id, type: "contact_created" });
            for (const [topicId, subscribed] of row.topicSubs) {
              activity.push(
                topicActivity(teamId, id, topicId, subscribed, topicInfo.get(topicId)?.name),
              );
            }
            continue;
          }
          succeed(row, id, "updated");
          if (row.unsubscribed === true && !update.found.unsubscribed) {
            activity.push({ teamId, contactId: id, type: "unsubscribed" });
          }
          for (const [topicId, subscribed] of row.topicSubs) {
            const before =
              priorSubs.get(`${id}:${topicId}`) ?? topicInfo.get(topicId)?.defaultSubscribed;
            if (before !== subscribed) {
              activity.push(
                topicActivity(teamId, id, topicId, subscribed, topicInfo.get(topicId)?.name),
              );
            }
          }
        }
        for (const a of written.added) {
          activity.push({
            teamId,
            contactId: a.contactId,
            type: "segment_added",
            data: { segmentId: a.segmentId, name: segmentNames.get(a.segmentId) ?? null },
          });
        }
        await recordContactActivity(db, activity);
        return results;
      } catch (err) {
        if (attempt < 2 && (isUniqueViolation(err) || isForeignKeyViolation(err))) continue;
        throw err;
      }
    }
  };

  /** Creation shared by POST /contacts and its legacy audiences alias. */
  const createContactOp = async (
    teamId: string,
    body: CreateContactRequest,
  ): Promise<BatchItemResult> => {
    const [result] = await batchContactsOp(teamId, [body], { onConflict: "error", strict: true });
    if (!result) throw new Error("contact batch returned no result");
    return result;
  };

  /** Update shared by PATCH /contacts/{id} and its legacy audiences alias. */
  const updateContactOp = async (
    teamId: string,
    idOrEmail: string,
    body: z.infer<typeof updateContactRequestSchema>,
  ): Promise<{ invalid: string } | { id: string } | undefined> => {
    let properties: Record<string, string> | undefined;
    if (body.properties !== undefined) {
      const coerced = coerceContactProperties(
        body.properties,
        await loadContactPropertyTypes(db, teamId),
      );
      if (!coerced.ok) return { invalid: coerced.message };
      properties = coerced.properties;
    }
    // Read the flag before writing so the timeline records only real flips —
    // a PATCH restating the current state stays silent.
    const [before] =
      body.unsubscribed === undefined
        ? []
        : await db
            .select({ unsubscribed: t.unsubscribed })
            .from(t)
            .where(teamContactWhere(teamId, idOrEmail));
    const [row] = await db
      .update(t)
      .set({
        updatedAt: new Date(),
        ...(body.first_name !== undefined ? { firstName: body.first_name } : {}),
        ...(body.last_name !== undefined ? { lastName: body.last_name } : {}),
        ...(body.unsubscribed !== undefined
          ? {
              unsubscribed: body.unsubscribed,
              unsubscribedAt: body.unsubscribed ? new Date() : null,
            }
          : {}),
        ...(properties !== undefined ? { properties } : {}),
      })
      .where(teamContactWhere(teamId, idOrEmail))
      .returning({ id: t.id, email: t.email });
    // Only this explicit re-subscribe lifts the retained one-click opt-out;
    // creating or importing the address again leaves it in place.
    if (row && body.unsubscribed === false) {
      await clearUnsubscribeSuppression(db, teamId, row.email);
    }
    if (row && before && before.unsubscribed !== body.unsubscribed) {
      await recordContactActivity(db, {
        teamId,
        contactId: row.id,
        type: body.unsubscribed ? "unsubscribed" : "resubscribed",
      });
    }
    return row;
  };

  const deleteContactOp = async (teamId: string, idOrEmail: string) => {
    const row = (
      await db
        .delete(t)
        .where(teamContactWhere(teamId, idOrEmail))
        .returning({ id: t.id, email: t.email })
    )[0];
    // Deleting a contact is an erasure: the address must not survive in
    // email history, event payloads or API logs.
    if (row) await eraseRecipient(db, teamId, row.email);
    return row;
  };

  app.openapi(
    createRoute({
      method: "post",
      path: "/contacts",
      request: {
        body: { content: { "application/json": { schema: createContactRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: contactIdResponseSchema } },
          description: "Contact created",
        },
        404: jsonErr("Unknown segment or topic"),
        409: jsonErr("Contact already exists"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const result = await createContactOp(auth.teamId, c.req.valid("json"));
      if (!result.ok) {
        return c.json(errorBody(result.status, result.name, result.message), result.status);
      }
      return c.json({ object: "contact" as const, id: result.id }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/contacts/batch",
      summary: "Create contacts in bulk",
      description:
        "MillionSend extension: creates up to 1000 contacts in one request (Resend imports " +
        "contacts only via CSV). Each item is a CreateContactRequest. `on_conflict` decides what " +
        "happens to an email that already belongs to a contact — `error` (default), `skip`, or " +
        "`upsert`. An upsert updates `first_name`/`last_name` only when provided, merges " +
        "`properties` (provided keys overwrite), adds `segments` and upserts `topics`. " +
        "`unsubscribed: true` opts the contact out; `unsubscribed: false` on an already " +
        "unsubscribed contact is ignored — a batch never re-subscribes anyone, that stays an " +
        "explicit PATCH /contacts/{id}. The `x-batch-validation` header picks strict (default, " +
        "all-or-nothing) or permissive (valid subset written, failures listed in `errors`).",
      request: {
        query: batchContactsQuerySchema,
        headers: batchContactsHeadersSchema,
        body: { content: { "application/json": { schema: batchContactsRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: batchContactsResponseSchema } },
          description: "Batch processed",
        },
        404: jsonErr("Unknown segment or topic (strict mode)"),
        409: jsonErr("Contact already exists (strict mode, on_conflict=error)"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const strict = c.req.valid("header")["x-batch-validation"] !== "permissive";
      const { on_conflict } = c.req.valid("query");
      const items = c.req.valid("json").map((raw): CreateContactRequest | BatchItemError => {
        const parsed = createContactRequestSchema.safeParse(raw);
        return parsed.success
          ? parsed.data
          : {
              ok: false,
              status: 422,
              name: "validation_error",
              message: validationMessage(parsed.error),
            };
      });
      const results = await batchContactsOp(auth.teamId, items, {
        onConflict: on_conflict,
        strict,
      });
      if (strict) {
        const index = results.findIndex((r) => r !== undefined && !r.ok);
        const failed = results[index];
        if (failed && !failed.ok) {
          return c.json(
            errorBody(failed.status, failed.name, `contacts.${index}: ${failed.message}`),
            failed.status,
          );
        }
      }
      const data: z.infer<typeof batchContactsResponseSchema>["data"] = [];
      const errors: { index: number; message: string }[] = [];
      const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
      for (const [index, r] of results.entries()) {
        if (!r) throw new Error(`contact batch left item ${index} unresolved`);
        if (r.ok) {
          data.push({ object: "contact", index, id: r.id, status: r.status });
          counts[r.status]++;
        } else {
          errors.push({ index, message: r.message });
          counts.failed++;
        }
      }
      return c.json({ data, counts, ...(strict ? {} : { errors }) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/contacts",
      request: { query: listQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: listContactsResponseSchema } },
          description: "Contacts",
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
        { object: "list" as const, data: page.rows.map(contactListItem), has_more: page.hasMore },
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
      const contact = await findContact(auth.teamId, c.req.valid("param").id);
      if (!contact) return c.json(errorBody(404, "not_found", "Contact not found"), 404);
      return c.json(
        contactDetailWire(contact, await loadContactPropertyTypes(db, auth.teamId)),
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
      const row = await updateContactOp(auth.teamId, c.req.valid("param").id, c.req.valid("json"));
      if (row && "invalid" in row) {
        return c.json(errorBody(422, "validation_error", row.invalid), 422);
      }
      if (!row) return c.json(errorBody(404, "not_found", "Contact not found"), 404);
      return c.json({ object: "contact" as const, id: row.id }, 200);
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
      const row = await deleteContactOp(auth.teamId, c.req.valid("param").id);
      if (!row) return c.json(errorBody(404, "not_found", "Contact not found"), 404);
      return c.json({ object: "contact" as const, contact: row.id, deleted: true as const }, 200);
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
      const contact = await findContact(auth.teamId, id);
      if (!contact) return c.json(errorBody(404, "not_found", "Contact not found"), 404);
      if (entries.length === 0) return c.json({ id: contact.id }, 200);

      // Topics are teamId-scoped: a subscription may only target one this
      // team owns, or a caller could write rows against another team's topic.
      const topicIds = [...new Set(entries.map((e) => e.id))];
      const topicInfo = await ownsTopics(auth.teamId, topicIds);
      if (!topicInfo) {
        return c.json(errorBody(404, "not_found", "Topic not found"), 404);
      }

      // Effective state before the write (explicit row, else the topic's
      // default) — the timeline records only real transitions.
      const s = schema.contactTopicSubscriptions;
      const prior = new Map(
        (
          await db
            .select({ topicId: s.topicId, subscribed: s.subscribed })
            .from(s)
            .where(and(eq(s.contactId, contact.id), inArray(s.topicId, topicIds)))
        ).map((r) => [r.topicId, r.subscribed]),
      );

      await db
        .insert(schema.contactTopicSubscriptions)
        .values(
          entries.map((e) => ({
            contactId: contact.id,
            topicId: e.id,
            subscribed: e.subscription === "opt_in",
          })),
        )
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

      const changed: ContactActivityRow[] = [];
      for (const e of entries) {
        const topic = topicInfo.get(e.id);
        if (!topic) continue;
        const next = e.subscription === "opt_in";
        if ((prior.get(e.id) ?? topic.defaultSubscribed) !== next) {
          changed.push({
            teamId: auth.teamId,
            contactId: contact.id,
            type: next ? "topic_opt_in" : "topic_opt_out",
            data: { topicId: e.id, name: topic.name },
          });
        }
        prior.set(e.id, next);
      }
      await recordContactActivity(db, changed);
      return c.json({ id: contact.id }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/contacts/{id}/segments/{segmentId}",
      request: { params: membershipParams },
      responses: {
        200: {
          content: { "application/json": { schema: addContactSegmentResponseSchema } },
          description: "Contact added to the segment",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id, segmentId } = c.req.valid("param");
      const contact = await findContact(auth.teamId, id);
      if (!contact) return c.json(errorBody(404, "not_found", "Contact not found"), 404);
      // SECURITY: the segment must be the team's own, or this would write a
      // membership into another team's segment.
      const segmentNames = await ownsSegments(auth.teamId, [segmentId]);
      if (!segmentNames) {
        return c.json(errorBody(404, "not_found", "Segment not found"), 404);
      }
      // Idempotent: re-adding an existing member succeeds without a new row;
      // `returning` is empty then, so the timeline records only first joins.
      const [added] = await db
        .insert(schema.segmentMembers)
        .values({ segmentId, contactId: contact.id })
        .onConflictDoNothing()
        .returning({ contactId: schema.segmentMembers.contactId });
      if (added) {
        await recordContactActivity(db, {
          teamId: auth.teamId,
          contactId: contact.id,
          type: "segment_added",
          data: { segmentId, name: segmentNames.get(segmentId) ?? null },
        });
      }
      return c.json({ id: contact.id }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/contacts/{id}/segments/{segmentId}",
      request: { params: membershipParams },
      responses: {
        200: {
          content: { "application/json": { schema: removeContactSegmentResponseSchema } },
          description: "Contact removed from the segment",
        },
        404: jsonErr("Not found"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id, segmentId } = c.req.valid("param");
      const contact = await findContact(auth.teamId, id);
      if (!contact) return c.json(errorBody(404, "not_found", "Contact not found"), 404);
      // No team check on the segment: membership rows only ever link same-team
      // pairs, so a foreign segmentId matches no row and 404s below.
      const m = schema.segmentMembers;
      const [removed] = await db
        .delete(m)
        .where(and(eq(m.segmentId, segmentId), eq(m.contactId, contact.id)))
        .returning({ segmentId: m.segmentId });
      if (!removed) {
        return c.json(errorBody(404, "not_found", "Contact is not a member of this segment"), 404);
      }
      // A membership row existed, so the segment is the team's own (rows only
      // ever link same-team pairs); fetch its name for the timeline snapshot.
      const [segment] = await db
        .select({ name: schema.segments.name })
        .from(schema.segments)
        .where(eq(schema.segments.id, segmentId));
      await recordContactActivity(db, {
        teamId: auth.teamId,
        contactId: contact.id,
        type: "segment_removed",
        data: { segmentId, name: segment?.name ?? null },
      });
      return c.json({ id: contact.id, audienceId: segmentId, deleted: true as const }, 200);
    },
  );

  // Legacy audiences aliases (resend v6: contacts.create/get/update/remove
  // with audienceId). An audience IS a segment; the create alias additionally
  // joins the new contact to it, and the read/write aliases only require the
  // audience to exist for the team before running the same operations.
  app.openapi(
    createRoute({
      method: "post",
      path: "/audiences/{audienceId}/contacts",
      request: {
        params: audienceParams,
        body: { content: { "application/json": { schema: createContactRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: contactIdResponseSchema } },
          description: "Contact created in the audience",
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
      const result = await createContactOp(auth.teamId, {
        ...body,
        segments: [...(body.segments ?? []), { id: audienceId }],
      });
      if (!result.ok) {
        return c.json(errorBody(result.status, result.name, result.message), result.status);
      }
      return c.json({ object: "contact" as const, id: result.id }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/audiences/{audienceId}/contacts/{id}",
      request: { params: audienceContactParams },
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
      if (!(await ownsSegments(auth.teamId, [audienceId]))) {
        return c.json(errorBody(404, "not_found", "Audience not found"), 404);
      }
      const contact = await findContact(auth.teamId, id);
      if (!contact) return c.json(errorBody(404, "not_found", "Contact not found"), 404);
      return c.json(
        contactDetailWire(contact, await loadContactPropertyTypes(db, auth.teamId)),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/audiences/{audienceId}/contacts/{id}",
      request: {
        params: audienceContactParams,
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
      if (!(await ownsSegments(auth.teamId, [audienceId]))) {
        return c.json(errorBody(404, "not_found", "Audience not found"), 404);
      }
      const row = await updateContactOp(auth.teamId, id, c.req.valid("json"));
      if (row && "invalid" in row) {
        return c.json(errorBody(422, "validation_error", row.invalid), 422);
      }
      if (!row) return c.json(errorBody(404, "not_found", "Contact not found"), 404);
      return c.json({ object: "contact" as const, id: row.id }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/audiences/{audienceId}/contacts/{id}",
      request: { params: audienceContactParams },
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
      if (!(await ownsSegments(auth.teamId, [audienceId]))) {
        return c.json(errorBody(404, "not_found", "Audience not found"), 404);
      }
      const row = await deleteContactOp(auth.teamId, id);
      if (!row) return c.json(errorBody(404, "not_found", "Contact not found"), 404);
      return c.json({ object: "contact" as const, contact: row.id, deleted: true as const }, 200);
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
    visibility: row.visibility,
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
          // Full object (not just { id }): additive over the SDK's { id }
          // typing, and lets an agent confirm the create without a re-read.
          content: { "application/json": { schema: topicResponseSchema } },
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
          // Omitted → the column default ('private').
          ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
        })
        .returning();
      if (!row) throw new Error("topic insert returned no row");
      return c.json(toWire(row), 200);
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
      // Same envelope as the other list endpoints; topics are never paginated,
      // so has_more is always false.
      return c.json(
        { object: "list" as const, data: rows.map(toWire), has_more: false as const },
        200,
      );
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
      method: "patch",
      path: "/topics/{id}",
      request: {
        params: idParam,
        body: { content: { "application/json": { schema: updateTopicRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: topicIdResponseSchema } },
          description: "Topic updated",
        },
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const changes = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
      };
      // The SDK always posts a body (its `id` is dropped by the schema); a
      // PATCH with nothing editable is a no-op ack, not an error.
      if (Object.keys(changes).length === 0) {
        const existing = await findTeamTopic(db, auth.teamId, id);
        if (!existing) return c.json(errorBody(404, "not_found", "Topic not found"), 404);
        return c.json({ id: existing.id }, 200);
      }
      const [row] = await db
        .update(b)
        .set(changes)
        .where(and(eq(b.id, id), eq(b.teamId, auth.teamId)))
        .returning({ id: b.id });
      if (!row) return c.json(errorBody(404, "not_found", "Topic not found"), 404);
      return c.json({ id: row.id }, 200);
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
        409: jsonErr("Topic is in use"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      let row: { id: string } | undefined;
      try {
        [row] = await db
          .delete(b)
          .where(and(eq(b.id, id), eq(b.teamId, auth.teamId)))
          .returning({ id: b.id });
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          return c.json(errorBody(409, "conflict", "This topic is referenced by a broadcast"), 409);
        }
        throw error;
      }
      if (!row) return c.json(errorBody(404, "not_found", "Topic not found"), 404);
      return c.json({ id: row.id, object: "topic" as const, deleted: true as const }, 200);
    },
  );
}

/**
 * Segments — MillionSend segmentation (a saved filter over the team's
 * contacts, docs/resend-compatibility.md).
 */
function registerSegmentRoutes(app: OpenAPIHono<Env>, db: Db): void {
  const jsonErr = (description: string) => ({
    content: { "application/json": { schema: errorSchema } },
    description,
  });
  const idParam = z.object({ id: z.uuid() });
  const s = schema.segments;

  const toWire = (row: typeof schema.segments.$inferSelect) => ({
    object: "segment" as const,
    id: row.id,
    name: row.name,
    filter: row.filter,
    created_at: row.createdAt.toISOString(),
  });

  // Live count of contacts the segment currently resolves to (filter matches
  // plus manual members). Reuses the one resolver, so the count can never
  // drift from what the fan-out targets.
  const contactCount = async (
    teamId: string,
    segment: { id: string; filter: SegmentFilter | null },
  ): Promise<number> => {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.contacts)
      .where(
        and(eq(schema.contacts.teamId, teamId), segmentContactsWhere(schema.contacts, segment)),
      );
    return row?.count ?? 0;
  };

  const filterError = (issues: string[]) => errorBody(422, "validation_error", issues.join("; "));

  app.openapi(
    createRoute({
      method: "post",
      path: "/segments",
      request: {
        body: { content: { "application/json": { schema: createSegmentRequestSchema } } },
      },
      responses: {
        200: {
          content: { "application/json": { schema: segmentResponseSchema } },
          description: "Segment created",
        },
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const body = c.req.valid("json");
      // Authoritative field/operator validation (the request schema only pins
      // the wire structure): a bad filter is a 422, never stored. No filter =
      // manual segment (membership rows only).
      let filter: SegmentFilter | null = null;
      if (body.filter !== undefined) {
        const parsed = segmentFilterSchema.safeParse(body.filter);
        if (!parsed.success) {
          return c.json(filterError(parsed.error.issues.map((i) => i.message)), 422);
        }
        filter = parsed.data;
      }
      const [row] = await db
        .insert(s)
        .values({ teamId: auth.teamId, name: body.name, filter })
        .returning();
      if (!row) throw new Error("segment insert returned no row");
      return c.json(toWire(row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/segments",
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
      path: "/segments/{id}",
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
      return c.json({ ...toWire(row), contact_count: await contactCount(auth.teamId, row) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/segments/{id}/contacts",
      request: { params: idParam, query: listQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: listContactsResponseSchema } },
          description: "Contacts the segment resolves to",
        },
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const [segment] = await db
        .select()
        .from(s)
        .where(and(eq(s.id, c.req.valid("param").id), eq(s.teamId, auth.teamId)));
      if (!segment) return c.json(errorBody(404, "not_found", "Segment not found"), 404);
      const ct = schema.contacts;
      const inSegment = segmentContactsWhere(ct, segment);
      const page = await keysetPage({
        query: c.req.valid("query"),
        createdAt: ct.createdAt,
        id: ct.id,
        loadCursor: async (id) =>
          (
            await db
              .select({ createdAt: ct.createdAt, id: ct.id })
              .from(ct)
              .where(and(eq(ct.id, id), eq(ct.teamId, auth.teamId)))
          )[0],
        loadRows: (cond, descending, take) =>
          db
            .select()
            .from(ct)
            .where(and(eq(ct.teamId, auth.teamId), inSegment, cond))
            .orderBy(
              ...(descending ? [desc(ct.createdAt), desc(ct.id)] : [asc(ct.createdAt), asc(ct.id)]),
            )
            .limit(take),
      });
      if (page === "bad_cursor") {
        return c.json(errorBody(422, "validation_error", "invalid pagination cursor"), 422);
      }
      return c.json(
        { object: "list" as const, data: page.rows.map(contactListItem), has_more: page.hasMore },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/segments/{id}",
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
      // undefined = keep; null = clear (the segment becomes manual-only).
      let filter: SegmentFilter | null | undefined;
      if (body.filter === null) {
        filter = null;
      } else if (body.filter !== undefined) {
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
      path: "/segments/{id}",
      request: { params: idParam },
      responses: {
        200: {
          content: { "application/json": { schema: removeSegmentResponseSchema } },
          description: "Segment deleted",
        },
        404: jsonErr("Not found"),
        409: jsonErr("Segment is in use"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      let row: { id: string } | undefined;
      try {
        [row] = await db
          .delete(s)
          .where(and(eq(s.id, id), eq(s.teamId, auth.teamId)))
          .returning({ id: s.id });
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          return c.json(
            errorBody(409, "conflict", "This segment is referenced by a broadcast"),
            409,
          );
        }
        throw error;
      }
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

  const findTopic = (teamId: string, id: string) => findTeamTopic(db, teamId, id);

  const findSegment = async (teamId: string, id: string) =>
    (
      await db
        .select({ id: schema.segments.id })
        .from(schema.segments)
        .where(and(eq(schema.segments.id, id), eq(schema.segments.teamId, teamId)))
    )[0];

  // Every guard plus the draft→scheduled CAS behind POST /broadcasts/{id}/send,
  // shared with send-on-create (POST /broadcasts with send: true) so the two
  // entry points can never drift.
  const initiateSend = async (
    auth: ApiKeyAuth,
    broadcast: { id: string; from: string },
    scheduledAtInput: string | undefined,
  ): Promise<
    | { ok: true; id: string }
    | { ok: false; status: 400 | 403 | 422; body: ReturnType<typeof errorBody> }
  > => {
    const fail = (status: 400 | 403 | 422, name: string, message: string) => ({
      ok: false as const,
      status,
      body: errorBody(status, name, message),
    });
    // Same precondition the web router enforces: unsubscribe links are
    // built from APP_BASE_URL, and a broadcast without them must not go out.
    if (!deps.appBaseUrl) {
      return fail(
        422,
        "validation_error",
        "APP_BASE_URL is not set. Unsubscribe links are built from it. Set it, restart, send again.",
      );
    }
    const paused = await sendingPausedError(deps, auth);
    if (paused) return { ok: false as const, status: 403 as const, body: paused };
    // Same boundary as /emails: only a verified team domain may appear as
    // the sender.
    const domain = await verifySenderDomain(db, auth.teamId, broadcast.from);
    if (!domain.ok) {
      return fail(
        422,
        "validation_error",
        domain.reason === "invalid_sender"
          ? "from must be a single address"
          : `The ${domain.fromDomain} domain is not verified for this team`,
      );
    }
    // Same per-key domain confinement as /emails and SMTP: a domain-scoped
    // key must not send from a different team domain.
    if (keyForbidsSendingDomain(auth, domain.domainId)) {
      return fail(403, "restricted_api_key", RESTRICTED_DOMAIN_MESSAGE);
    }
    // Schema-validated, so parseScheduledAt always resolves (the ?? only
    // satisfies the type); relative forms ("in 2 days") resolve against now.
    const scheduledAt =
      (scheduledAtInput ? parseScheduledAt(scheduledAtInput) : null) ?? new Date();
    const [row] = await db
      .update(schema.broadcasts)
      .set({ status: "scheduled", scheduledAt, updatedAt: new Date() })
      .where(and(eq(schema.broadcasts.id, broadcast.id), eq(schema.broadcasts.status, "draft")))
      .returning({ id: schema.broadcasts.id });
    if (!row) {
      return fail(400, "invalid_parameter", "Only draft broadcasts can be sent");
    }
    // Enqueue failure must not undo the commit — the reconcile sweep
    // re-enqueues scheduled broadcasts whose job was lost.
    try {
      await deps.enqueueBroadcastSend?.(row.id, { startAfter: scheduledAt });
    } catch (err) {
      console.error("broadcast.send enqueue failed; reconcile sweep will recover", err);
    }
    return { ok: true, id: row.id };
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
          description: "Broadcast created (and scheduled when send: true)",
        },
        400: jsonErr("Broadcast state conflict"),
        403: jsonErr("Restricted API key or sending paused"),
        404: jsonErr("Not found"),
        422: jsonErr("Validation error"),
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const body = c.req.valid("json");
      // Targeting is optional: no segment and no topic means every contact.
      if (body.segment_id !== undefined && !(await findSegment(auth.teamId, body.segment_id))) {
        return c.json(errorBody(422, "validation_error", "Segment not found"), 422);
      }
      if (body.topic_id != null && !(await findTopic(auth.teamId, body.topic_id))) {
        return c.json(errorBody(404, "not_found", "Topic not found"), 404);
      }
      // A domain-scoped key must not even stage a broadcast from a domain
      // outside its scope. Sender-domain verification stays deferred to send
      // (a draft may hold an as-yet-unverified From), so only a resolved
      // verified domain is scope-checked here.
      const domain = await verifySenderDomain(db, auth.teamId, body.from);
      if (domain.ok && keyForbidsSendingDomain(auth, domain.domainId)) {
        return c.json(errorBody(403, "restricted_api_key", RESTRICTED_DOMAIN_MESSAGE), 403);
      }
      const [row] = await db
        .insert(schema.broadcasts)
        .values({
          teamId: auth.teamId,
          segmentId: body.segment_id ?? null,
          topicId: body.topic_id ?? null,
          name: body.name ?? null,
          from: body.from,
          subject: body.subject,
          replyTo: body.reply_to ? JSON.stringify(body.reply_to) : null,
          previewText: body.preview_text ?? null,
          html: body.html ?? null,
          text: body.text ?? null,
        })
        .returning({ id: schema.broadcasts.id });
      if (!row) throw new Error("broadcast insert returned no row");
      // send: true — the identical guards and scheduling as POST
      // /broadcasts/{id}/send. A failed guard returns its error but the
      // just-created draft remains, fixable and sendable later.
      if (body.send) {
        const out = await initiateSend(auth, { id: row.id, from: body.from }, body.scheduled_at);
        if (!out.ok) return c.json(out.body, out.status);
      }
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
            segment_id: r.segmentId,
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
          segment_id: broadcast.segmentId,
          from: broadcast.from,
          subject: broadcast.subject,
          reply_to: parseReplyTo(broadcast.replyTo),
          preview_text: broadcast.previewText,
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
      const broadcast = await findBroadcast(auth.teamId, id);
      if (!broadcast) return c.json(errorBody(404, "not_found", "Broadcast not found"), 404);
      if (broadcast.status !== "draft") {
        return c.json(
          errorBody(400, "invalid_parameter", "Only draft broadcasts can be updated"),
          400,
        );
      }
      if (body.segment_id !== undefined && !(await findSegment(auth.teamId, body.segment_id))) {
        return c.json(errorBody(422, "validation_error", "Segment not found"), 422);
      }
      if (body.topic_id != null && !(await findTopic(auth.teamId, body.topic_id))) {
        return c.json(errorBody(404, "not_found", "Topic not found"), 404);
      }
      const [row] = await db
        .update(schema.broadcasts)
        .set({
          updatedAt: new Date(),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.segment_id !== undefined ? { segmentId: body.segment_id } : {}),
          ...(body.topic_id !== undefined ? { topicId: body.topic_id } : {}),
          ...(body.from !== undefined ? { from: body.from } : {}),
          ...(body.subject !== undefined ? { subject: body.subject } : {}),
          ...(body.html !== undefined ? { html: body.html } : {}),
          ...(body.text !== undefined ? { text: body.text } : {}),
          ...(body.reply_to !== undefined ? { replyTo: JSON.stringify(body.reply_to) } : {}),
          ...(body.preview_text !== undefined ? { previewText: body.preview_text } : {}),
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
      const out = await initiateSend(auth, broadcast, body.scheduled_at);
      if (!out.ok) return c.json(out.body, out.status);
      return c.json({ id: out.id }, 200);
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
        return c.json(errorBody(422, "validation_error", validationMessage(result.error)), 422);
      }
    },
  });

  // First middleware: MCP tools authenticate their in-process REST calls by
  // Request identity (see INTERNAL_AUTH). Must run before any middleware that
  // could replace c.req.raw, and before the request logger reads `auth`.
  app.use("*", async (c, next) => {
    const internal = INTERNAL_AUTH.get(c.req.raw);
    if (internal) c.set("auth", internal);
    return next();
  });

  // Uncaught throws must still speak Resend's error format — SDK clients
  // parse the body as JSON.
  app.onError((err, c) => {
    console.error("unhandled api error", err);
    return c.json(errorBody(500, "internal_server_error", "An unexpected error occurred"), 500);
  });

  // Wildcard CORS is safe here: auth is an explicit Authorization header
  // (never cookies), so cross-origin pages can't ride ambient credentials.
  // It's what lets the docs playground call the API from the browser.
  // allowHeaders unset -> hono reflects Access-Control-Request-Headers.
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: ["retry-after"],
      maxAge: 86400,
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 25 * 1024 * 1024,
      onError: (c) =>
        c.json(errorBody(413, "payload_too_large", "Request body exceeds 25 MiB"), 413),
    }),
  );
  app.use("*", secureHeaders());

  const health = { status: "ok" as const, revision: deps.revision ?? "unknown" };
  app.get("/health", (c) => c.json(health));

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "MillionSend API", version: "1.0.0" },
    // Servers drive the docs playground's target picker: Cloud first (docs
    // convention), then a variable entry self-hosters point at their origin.
    servers: [
      { url: "https://api.millionsend.com", description: "MillionSend Cloud" },
      {
        url: "{baseUrl}",
        description: "Self-hosted instance",
        variables: { baseUrl: { default: "http://localhost:3001" } },
      },
    ],
  });

  // After-response request logging, authenticated requests only — an
  // unauthenticated 401 has no team to attribute the row to. /ses/events is
  // excluded entirely (SNS traffic, not a customer API call). Fire-and-forget:
  // a logging failure must never fail or slow the response. Headers are never
  // stored (Authorization included); see maskEmailPathSegments for what is.
  app.use("*", async (c, next) => {
    const startedAt = Date.now();
    await next();
    const auth = c.get("auth");
    if (!auth || c.req.path.startsWith("/ses/")) return;
    const durationMs = Date.now() - startedAt;
    const { method } = c.req;
    const path = maskEmailPathSegments(c.req.path);
    const statusCode = c.res.status;
    const requestLength = c.req.header("content-length");
    const responseLength = c.res.headers.get("content-length");
    // Cloned before the response is returned; the body read happens off the
    // request's critical path.
    const resClone = statusCode >= 400 ? c.res.clone() : null;
    void (async () => {
      const errorResponse = resClone ? await resClone.json().catch(() => null) : null;
      await deps.db.insert(schema.apiRequests).values({
        teamId: auth.teamId,
        apiKeyId: auth.apiKeyId,
        method,
        path,
        statusCode,
        durationMs,
        requestBytes: requestLength == null ? null : Number(requestLength),
        responseBytes: responseLength == null ? null : Number(responseLength),
        requestBody: null,
        responseBody: capLoggedJson(errorResponse),
      });
    })().catch((err) => console.error("api request log failed", err));
  });

  // Failed authentications are counted per client IP: every attempt costs a
  // prefix-indexed key lookup, and nothing else throttles a caller that has
  // no key to bucket on.
  const countAuthFailure = fixedWindowCounter();
  const authFailure = (c: Context, name: string, message: string) => {
    const ip = clientIp(c, deps.isCloud);
    if (ip) {
      const failures = countAuthFailure(`ip:${ip}`);
      if (failures.count > AUTH_FAILURES_PER_MINUTE) {
        c.header("retry-after", String(failures.retryAfterSec));
        return c.json(
          errorBody(429, "rate_limit_exceeded", "Too many failed authentication attempts"),
          429,
        );
      }
    }
    return c.json(errorBody(401, name, message), 401);
  };

  const requireApiKey = createMiddleware<Env>(async (c, next) => {
    // Both /emails and /emails/* register this; skip the second pass.
    if (c.get("auth")) return next();
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const prefix = token ? extractTokenPrefix(token) : null;
    if (!token || !prefix) {
      return authFailure(c, "missing_api_key", "Missing or malformed API key");
    }
    const auth = await authenticateApiKey(deps.db, token);
    if (!auth) {
      return authFailure(c, "invalid_api_key", "API key is invalid");
    }
    c.set("auth", auth);
    await next();
  });

  // SECURITY: a "sending_access" key is confined to the send surface
  // (/emails*). Every management group mounts this after requireApiKey, so a
  // sending key hitting contacts/segments/broadcasts/topics is 403, not a
  // silent success. "full_access" keys pass through.
  const requireFullAccess = createMiddleware<Env>(async (c, next) => {
    if (c.get("auth")?.permission === "sending_access") {
      return c.json(errorBody(403, "restricted_api_key", "This API key can only send emails"), 403);
    }
    return next();
  });

  const countTeamRequest = fixedWindowCounter();
  const enforceRateLimit = createMiddleware<Env>(async (c, next) => {
    // Exact + wildcard middleware registrations can both match one request.
    if (c.get("rateLimited")) return next();
    c.set("rateLimited", true);
    const auth = c.get("auth");
    // OAuth (MCP) callers have no api_keys row to bucket on; the /mcp gate
    // rate-limits them per user instead.
    if (!auth || auth.apiKeyId === null) return next();
    const bucket = schema.apiRateLimits;
    const windowStart = sql<Date>`date_trunc('minute', now())`;
    const [row] = await deps.db
      .insert(bucket)
      .values({ apiKeyId: auth.apiKeyId, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: bucket.apiKeyId,
        set: {
          windowStart,
          count: sql`case when ${bucket.windowStart} = ${windowStart} then ${bucket.count} + 1 else 1 end`,
        },
      })
      .returning({
        count: bucket.count,
        retryAfter: sql<number>`greatest(1, ceil(extract(epoch from (${bucket.windowStart} + interval '1 minute' - now()))))::int`,
      });
    const limit = deps.rateLimitPerMinute ?? 600;
    if ((row?.count ?? 0) > limit) {
      c.header("retry-after", String(row?.retryAfter ?? 60));
      return c.json(errorBody(429, "rate_limit_exceeded", "Too many requests"), 429);
    }
    // The team bucket spans every key, so minting keys cannot multiply the cap.
    const team = countTeamRequest(`team:${auth.teamId}`);
    if (team.count > (deps.teamRateLimitPerMinute ?? 3000)) {
      c.header("retry-after", String(team.retryAfterSec));
      return c.json(errorBody(429, "rate_limit_exceeded", "Too many requests"), 429);
    }
    return next();
  });

  app.use("/emails", requireApiKey, enforceRateLimit);
  app.use("/emails/*", requireApiKey, enforceRateLimit);

  app.use("/contacts", requireApiKey, enforceRateLimit, requireFullAccess);
  app.use("/contacts/*", requireApiKey, enforceRateLimit, requireFullAccess);
  // Legacy audiences aliases (contacts nested under /audiences/{id}) are
  // registered by registerContactRootRoutes and share the contacts policy.
  app.use("/audiences/*", requireApiKey, enforceRateLimit, requireFullAccess);
  registerContactRootRoutes(app, deps.db);

  app.use("/contact-properties", requireApiKey, enforceRateLimit, requireFullAccess);
  app.use("/contact-properties/*", requireApiKey, enforceRateLimit, requireFullAccess);
  registerContactPropertyRoutes(app, deps.db);

  app.use("/segments", requireApiKey, enforceRateLimit, requireFullAccess);
  app.use("/segments/*", requireApiKey, enforceRateLimit, requireFullAccess);
  registerSegmentRoutes(app, deps.db);

  app.use("/broadcasts", requireApiKey, enforceRateLimit, requireFullAccess);
  app.use("/broadcasts/*", requireApiKey, enforceRateLimit, requireFullAccess);
  registerBroadcastRoutes(app, deps);

  app.use("/topics", requireApiKey, enforceRateLimit, requireFullAccess);
  app.use("/topics/*", requireApiKey, enforceRateLimit, requireFullAccess);
  registerTopicRoutes(app, deps.db);

  app.use("/domains", requireApiKey, enforceRateLimit, requireFullAccess);
  app.use("/domains/*", requireApiKey, enforceRateLimit, requireFullAccess);
  if (deps.ses) registerDomainRoutes(app, deps, deps.ses);

  app.use("/api-keys", requireApiKey, enforceRateLimit, requireFullAccess);
  app.use("/api-keys/*", requireApiKey, enforceRateLimit, requireFullAccess);
  registerApiKeyRoutes(app, deps.db);

  app.use("/webhooks", requireApiKey, enforceRateLimit, requireFullAccess);
  app.use("/webhooks/*", requireApiKey, enforceRateLimit, requireFullAccess);
  registerWebhookRoutes(app, deps.db, deps.keyring);

  app.use("/suppressions", requireApiKey, enforceRateLimit, requireFullAccess);
  app.use("/suppressions/*", requireApiKey, enforceRateLimit, requireFullAccess);
  registerSuppressionRoutes(app, deps.db);

  app.use("/templates", requireApiKey, enforceRateLimit, requireFullAccess);
  app.use("/templates/*", requireApiKey, enforceRateLimit, requireFullAccess);
  registerTemplateRoutes(app, deps.db);

  app.use("/deliverability", requireApiKey, enforceRateLimit, requireFullAccess);

  app.use("/usage", requireApiKey, enforceRateLimit, requireFullAccess);
  registerUsageRoutes(app, deps);

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
      403: {
        content: { "application/json": { schema: errorSchema } },
        description: "Restricted API key",
      },
      404: {
        content: { "application/json": { schema: errorSchema } },
        description: "Not found",
      },
      409: {
        content: { "application/json": { schema: errorSchema } },
        description: "Idempotency conflict",
      },
      422: {
        content: { "application/json": { schema: errorSchema } },
        description: "Validation error",
      },
      429: {
        content: { "application/json": { schema: errorSchema } },
        description: "Daily quota exceeded",
      },
    },
  });

  app.openapi(sendRoute, async (c) => {
    const auth = c.get("auth");
    const body = c.req.valid("json");

    // Same boundary as broadcasts: a topic reference outside the caller's
    // team must not leak into the send.
    if (body.topic_id != null && !(await findTeamTopic(deps.db, auth.teamId, body.topic_id))) {
      return c.json(errorBody(404, "not_found", "Topic not found"), 404);
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
    if (keyForbidsSendingDomain(auth, domain.domainId)) {
      return c.json(errorBody(403, "restricted_api_key", RESTRICTED_DOMAIN_MESSAGE), 403);
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
      const paused = await sendingPausedError(deps, auth);
      if (paused) {
        if (idemKey) await releaseIdempotent(deps.db, { teamId: auth.teamId, key: idemKey });
        return c.json(paused, 403);
      }
      const result = await acceptEmail(deps, auth, toAcceptPayload(body, domain.domainId), {
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
      });
      if (!result.ok) {
        if (idemKey) await releaseIdempotent(deps.db, { teamId: auth.teamId, key: idemKey });
        const rejection = acceptRejection(result);
        return c.json(rejection.body, rejection.status);
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

  const jsonErr = (description: string) => ({
    content: { "application/json": { schema: errorSchema } },
    description,
  });

  const batchRoute = createRoute({
    method: "post",
    path: "/emails/batch",
    request: {
      body: { content: { "application/json": { schema: batchEmailRequestSchema } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: batchEmailResponseSchema } },
        description: "Batch accepted",
      },
      403: jsonErr("Restricted API key"),
      404: jsonErr("Not found"),
      409: jsonErr("Idempotency conflict"),
      422: jsonErr("Validation error"),
      429: jsonErr("Daily quota exceeded"),
    },
  });

  // One batch item's full validation (wire shape + business rules), no
  // writes. A failure carries the strict-mode status so strict can answer
  // with it verbatim while permissive downgrades it to a per-index error.
  type BatchItemVerdict =
    | { payload: AcceptEmailPayload }
    | { status: 403 | 404 | 422; name: string; message: string };

  const validateBatchItem = async (auth: ApiKeyAuth, raw: unknown): Promise<BatchItemVerdict> => {
    const parsed = sendEmailRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { status: 422, name: "validation_error", message: validationMessage(parsed.error) };
    }
    const body = parsed.data;
    if (body.topic_id != null && !(await findTeamTopic(deps.db, auth.teamId, body.topic_id))) {
      return { status: 404, name: "not_found", message: "Topic not found" };
    }
    const domain = await verifySenderDomain(deps.db, auth.teamId, body.from);
    if (!domain.ok) {
      return {
        status: 422,
        name: "validation_error",
        message:
          domain.reason === "invalid_sender"
            ? "from must be a single address"
            : `The ${domain.fromDomain} domain is not verified for this team`,
      };
    }
    if (keyForbidsSendingDomain(auth, domain.domainId)) {
      return { status: 403, name: "restricted_api_key", message: RESTRICTED_DOMAIN_MESSAGE };
    }
    if (estimateAttachmentBytes(body.attachments ?? []) > MAX_ATTACHMENT_BYTES) {
      const { body: rejected } = acceptRejection({
        ok: false,
        reason: "attachments_too_large",
        maxBytes: MAX_ATTACHMENT_BYTES,
      });
      return { status: 422, name: "validation_error", message: rejected.message };
    }
    // Suppression (and topic opt-outs, which drop identically) is resolved
    // up front too, so an all-suppressed item fails at validation instead of
    // leaving earlier items accepted.
    const recipients = [...new Set([...body.to, ...(body.cc ?? []), ...(body.bcc ?? [])])];
    const suppressed = await findSuppressed(deps.db, auth.teamId, recipients);
    if (body.topic_id != null) {
      const optedOut = await findTopicOptOuts(deps.db, auth.teamId, body.topic_id, recipients);
      for (const r of optedOut) suppressed.add(r);
    }
    if (body.to.every((r) => suppressed.has(r))) {
      return { status: 422, name: "validation_error", message: "All recipients are suppressed" };
    }
    return { payload: toAcceptPayload(body, domain.domainId) };
  };

  app.openapi(batchRoute, async (c) => {
    const auth = c.get("auth");
    const items = c.req.valid("json");
    // Resend's x-batch-validation switch: strict (default) fails the whole
    // batch on the first invalid item; permissive accepts the valid subset
    // and reports the rest as per-index errors.
    const permissive = c.req.header("x-batch-validation")?.toLowerCase() === "permissive";

    // Pass 1 — validate every item with no writes.
    const payloads: { payload: AcceptEmailPayload; index: number }[] = [];
    const itemErrors: { index: number; message: string }[] = [];
    for (const [i, raw] of items.entries()) {
      const verdict = await validateBatchItem(auth, raw);
      if ("payload" in verdict) {
        payloads.push({ payload: verdict.payload, index: i });
      } else if (permissive) {
        itemErrors.push({ index: i, message: verdict.message });
      } else {
        return c.json(
          errorBody(verdict.status, verdict.name, `emails.${i}: ${verdict.message}`),
          verdict.status,
        );
      }
    }

    const idemKey = c.req.header("idempotency-key") ?? null;
    if (idemKey) {
      const begin = await beginIdempotent(deps.db, {
        teamId: auth.teamId,
        key: idemKey,
        bodyHash: canonicalBodyHash(items),
      });
      if (begin.kind === "replay") {
        return c.json({ data: begin.emailIds.map((id) => ({ id })) }, 200);
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

    // Pass 2 — accept every validated item in ONE transaction so the batch is
    // all-or-nothing, like single-send: a failure after item k rolls back
    // items 1..k, so a retry can never re-send what a prior attempt already
    // committed. Idempotency completion is recorded in the same transaction;
    // enqueue happens only after commit (reconcile re-enqueues any lost job).
    try {
      const paused = await sendingPausedError(deps, auth);
      if (paused) {
        if (idemKey) await releaseIdempotent(deps.db, { teamId: auth.teamId, key: idemKey });
        return c.json(paused, 403);
      }
      const accepted = await deps.db.transaction(async (dbTx) => {
        const txDb = dbTx as unknown as Db;
        const out: { id: string; parked: boolean; startAfter?: Date }[] = [];
        for (const { payload, index } of payloads) {
          const result = await acceptEmail(deps, auth, payload, { tx: txDb });
          if (!result.ok) throw new AcceptRejectedError(result, index);
          out.push({
            id: result.id,
            parked: result.parked,
            ...(payload.scheduledAt ? { startAfter: payload.scheduledAt } : {}),
          });
        }
        if (idemKey) {
          const recorded = await completeIdempotent(txDb, {
            teamId: auth.teamId,
            key: idemKey,
            emailIds: out.map((o) => o.id),
          });
          // Another owner recorded first: abort so this batch commits nothing.
          if (!recorded) throw new IdempotencyTakeoverError();
        }
        return out;
      });
      for (const item of accepted) {
        if (item.parked) continue;
        try {
          await deps.enqueueEmailSend(
            item.id,
            item.startAfter ? { startAfter: item.startAfter } : {},
          );
        } catch (err) {
          console.error("batch email.send enqueue failed; reconcile sweep will recover", err);
        }
      }
      return c.json(
        {
          data: accepted.map((o) => ({ id: o.id })),
          // The SDK's permissive response type requires `errors`, empty or not.
          ...(permissive ? { errors: itemErrors } : {}),
        },
        200,
      );
    } catch (err) {
      if (err instanceof IdempotencyTakeoverError && idemKey) {
        const replay = await beginIdempotent(deps.db, {
          teamId: auth.teamId,
          key: idemKey,
          bodyHash: canonicalBodyHash(items),
        });
        if (replay.kind === "replay") {
          return c.json({ data: replay.emailIds.map((id) => ({ id })) }, 200);
        }
        return c.json(
          errorBody(409, "concurrent_idempotent_requests", "Request superseded by a retry"),
          409,
        );
      }
      // The single transaction rolled back, so nothing was committed; releasing
      // the key lets a clean retry replay the whole batch without double-sending.
      if (idemKey) {
        await releaseIdempotent(deps.db, { teamId: auth.teamId, key: idemKey }).catch(() => {});
      }
      if (err instanceof AcceptRejectedError) {
        const rejection = acceptRejection(err.result);
        return c.json(
          { ...rejection.body, message: `emails.${err.index}: ${rejection.body.message}` },
          rejection.status,
        );
      }
      throw err;
    }
  });

  const cancelRoute = createRoute({
    method: "post",
    path: "/emails/{id}/cancel",
    request: { params: z.object({ id: z.uuid() }) },
    responses: {
      200: {
        content: { "application/json": { schema: cancelEmailResponseSchema } },
        description: "Email canceled",
      },
      404: jsonErr("Not found"),
      422: jsonErr("Not cancelable"),
    },
  });

  app.openapi(cancelRoute, async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");
    const [email] = await deps.db
      .select({ id: schema.emails.id })
      .from(schema.emails)
      .where(
        and(
          eq(schema.emails.id, id),
          eq(schema.emails.teamId, auth.teamId),
          ...emailScopeConditions(auth),
        ),
      );
    // Cross-team / out-of-scope / unknown id is a 404 (never reveals another
    // team's email).
    if (!email) return c.json(errorBody(404, "not_found", "Email not found"), 404);
    // Atomic flip guarded like the send handler's claim (not-yet-sendable AND
    // sent_at IS NULL): a cancel racing the send loses cleanly — whichever
    // update commits first, the other's WHERE no longer matches. A scheduled
    // email parked over quota sits in queued_quota until the nightly drain, so
    // both pre-send states are cancelable. Requiring scheduled_at excludes
    // immediate sends, which Resend cannot cancel.
    const [row] = await deps.db
      .update(schema.emails)
      .set({ latestStatus: "canceled" })
      .where(
        and(
          eq(schema.emails.id, id),
          eq(schema.emails.teamId, auth.teamId),
          inArray(schema.emails.latestStatus, ["queued", "queued_quota"]),
          isNull(schema.emails.sentAt),
          isNotNull(schema.emails.scheduledAt),
        ),
      )
      .returning({ id: schema.emails.id });
    if (!row) {
      return c.json(
        errorBody(
          422,
          "validation_error",
          "Only scheduled emails that have not been sent can be canceled",
        ),
        422,
      );
    }
    return c.json({ object: "email" as const, id: row.id }, 200);
  });

  const updateEmailRoute = createRoute({
    method: "patch",
    path: "/emails/{id}",
    request: {
      params: z.object({ id: z.uuid() }),
      body: { content: { "application/json": { schema: updateEmailRequestSchema } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: updateEmailResponseSchema } },
        description: "Email rescheduled",
      },
      404: jsonErr("Not found"),
      422: jsonErr("Not reschedulable"),
    },
  });

  app.openapi(updateEmailRoute, async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const [email] = await deps.db
      .select({ id: schema.emails.id, createdAt: schema.emails.createdAt })
      .from(schema.emails)
      .where(
        and(
          eq(schema.emails.id, id),
          eq(schema.emails.teamId, auth.teamId),
          ...emailScopeConditions(auth),
        ),
      );
    // Cross-team / out-of-scope / unknown id is a 404 (never reveals another
    // team's email).
    if (!email) return c.json(errorBody(404, "not_found", "Email not found"), 404);
    // Schema-validated, so this always resolves (the guard only satisfies the
    // type); re-resolved here because the wire value may be relative.
    const scheduledAt = parseScheduledAt(body.scheduled_at);
    if (!scheduledAt) {
      return c.json(
        errorBody(422, "validation_error", `scheduled_at must be ${SCHEDULED_AT_FORMS}`),
        422,
      );
    }
    // The 30-day cap is anchored at creation, not at each reschedule: chained
    // reschedules must not keep a body out of the retention purge forever.
    if (scheduledAt.getTime() > email.createdAt.getTime() + 30 * DAY_MS) {
      return c.json(
        errorBody(
          422,
          "validation_error",
          "scheduled_at cannot be more than 30 days after the email was created",
        ),
        422,
      );
    }
    // Same state gate as cancel: only a scheduled email nothing has claimed
    // can move — a reschedule racing the send loses cleanly (the WHERE no
    // longer matches once the sender claims sentAt).
    const [row] = await deps.db
      .update(schema.emails)
      .set({ scheduledAt })
      .where(
        and(
          eq(schema.emails.id, id),
          eq(schema.emails.teamId, auth.teamId),
          inArray(schema.emails.latestStatus, ["queued", "queued_quota"]),
          isNull(schema.emails.sentAt),
          isNotNull(schema.emails.scheduledAt),
        ),
      )
      .returning({ id: schema.emails.id, latestStatus: schema.emails.latestStatus });
    if (!row) {
      return c.json(
        errorBody(
          422,
          "validation_error",
          "Only scheduled emails that have not been sent can be rescheduled",
        ),
        422,
      );
    }
    // Best-effort nudge at the new due time; quota-parked rows wait for the
    // midnight drain instead, like at accept. While the original job is still
    // queued the dedupe key collapses this send, so a move to an EARLIER time
    // takes effect only when that job fires (the row is then already due); a
    // LATER time is exact — the send handler defers to scheduled_at.
    if (row.latestStatus === "queued") {
      try {
        await deps.enqueueEmailSend(row.id, { startAfter: scheduledAt });
      } catch (err) {
        console.error("email reschedule enqueue failed; reconcile sweep will recover", err);
      }
    }
    return c.json({ object: "email" as const, id: row.id }, 200);
  });

  // SECURITY: reads return decrypted bodies and the whole team archive, so
  // they are management surface — a sending_access key gets a 403 here even
  // though the rest of /emails is open to it.
  const getRoute = createRoute({
    method: "get",
    path: "/emails/{id}",
    middleware: [requireFullAccess],
    request: { params: z.object({ id: z.uuid() }) },
    responses: {
      200: {
        content: { "application/json": { schema: getEmailResponseSchema } },
        description: "Email",
      },
      403: jsonErr("Restricted API key"),
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
          { teamId: auth.teamId, rowId: email.id },
        );
        html = body.html;
        text = body.text;
      } catch {
        // Corrupt or purged body must not 500 the metadata read.
      }
    }
    const insights = await findEmailInsights(deps.db, auth.teamId, email);
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
        score: insights ? insights.scoreTenths / 10 : null,
      },
      200,
    );
  });

  const getInsightsRoute = createRoute({
    method: "get",
    path: "/emails/{id}/insights",
    middleware: [requireFullAccess],
    request: { params: z.object({ id: z.uuid() }) },
    responses: {
      200: {
        content: { "application/json": { schema: emailInsightsResponseSchema } },
        description: "Best-practice check results and score computed when the email was sent",
      },
      403: jsonErr("Restricted API key"),
      404: jsonErr("Not found"),
    },
  });

  app.openapi(getInsightsRoute, async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");
    const [email] = await deps.db
      .select({ id: schema.emails.id, broadcastId: schema.emails.broadcastId })
      .from(schema.emails)
      .where(and(eq(schema.emails.id, id), eq(schema.emails.teamId, auth.teamId)));
    if (!email) return c.json(errorBody(404, "not_found", "Email not found"), 404);
    const insights = await findEmailInsights(deps.db, auth.teamId, email);
    if (!insights) {
      return c.json(
        errorBody(404, "not_found", "Insights are not available for this email yet"),
        404,
      );
    }
    return c.json(
      {
        object: "email_insights" as const,
        email_id: email.id,
        score: insights.scoreTenths / 10,
        score_version: insights.scoreVersion,
        band: scoreBand(insights.scoreTenths),
        marketing: insights.marketing,
        html_size_bytes: insights.htmlSizeBytes,
        computed_at: insights.computedAt.toISOString(),
        checks: insights.checks.map((check) => ({
          id: check.id,
          severity: check.severity,
          status: check.status,
          penalty: check.penaltyHundredths / 100,
          ...(check.detail ? { detail: check.detail } : {}),
        })),
      },
      200,
    );
  });

  const deliverabilityRoute = createRoute({
    method: "get",
    path: "/deliverability",
    responses: {
      200: {
        content: { "application/json": { schema: deliverabilityResponseSchema } },
        description: "Account deliverability score over the trailing 30 days",
      },
      403: jsonErr("Restricted API key"),
    },
  });

  app.openapi(deliverabilityRoute, async (c) => {
    const auth = c.get("auth");
    // Plan flows like sendingPausedError: cloud enforces plan floors,
    // self-host uses the defaults.
    const score = await fetchAccountScore(
      deps.db,
      auth.teamId,
      deps.isCloud ? { plan: auth.plan } : {},
    );
    const tenths = (v: number | null) => (v === null ? null : v / 10);
    return c.json(
      {
        object: "deliverability" as const,
        score: tenths(score.scoreTenths),
        band: score.band,
        content_score: tenths(score.contentScoreTenths),
        outcome_score: tenths(score.outcomeScoreTenths),
        complaint_rate: score.complaintRate,
        hard_bounce_rate: score.hardBounceRate,
        emails_sent: score.sent,
        scored_recipients: score.contentRecipients,
        window_days: score.windowDays,
        insufficient_outcome_data: score.insufficientOutcomeData,
        guardrail_status: score.guardrailStatus,
        score_version: score.scoreVersion,
      },
      200,
    );
  });

  const listEmailsRoute = createRoute({
    method: "get",
    path: "/emails",
    middleware: [requireFullAccess],
    request: { query: listQuerySchema },
    responses: {
      200: {
        content: { "application/json": { schema: listEmailsResponseSchema } },
        description: "Emails",
      },
      403: jsonErr("Restricted API key"),
      422: {
        content: { "application/json": { schema: errorSchema } },
        description: "Validation error",
      },
    },
  });

  app.openapi(listEmailsRoute, async (c) => {
    const auth = c.get("auth");
    const t = schema.emails;
    const page = await keysetPage({
      query: c.req.valid("query"),
      createdAt: t.createdAt,
      id: t.id,
      loadCursor: async (id) =>
        (
          await deps.db
            .select({ createdAt: t.createdAt, id: t.id })
            .from(t)
            .where(and(eq(t.id, id), eq(t.teamId, auth.teamId)))
        )[0],
      loadRows: (cond, descending, take) =>
        deps.db
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
        data: page.rows.map((email) => ({
          id: email.id,
          from: email.from,
          to: email.to,
          cc: email.cc ?? null,
          bcc: email.bcc ?? null,
          reply_to: email.replyTo ?? null,
          subject: email.subject,
          created_at: email.createdAt.toISOString(),
          scheduled_at: email.scheduledAt?.toISOString() ?? null,
          // Internal quota-parking is invisible on the wire (same as GET /emails/{id}).
          last_event: email.latestStatus === "queued_quota" ? "queued" : email.latestStatus,
        })),
        has_more: page.hasMore,
      },
      200,
    );
  });

  const deleteEmailRoute = createRoute({
    method: "delete",
    path: "/emails/{id}",
    middleware: [requireFullAccess],
    request: { params: z.object({ id: z.uuid() }) },
    responses: {
      200: {
        content: { "application/json": { schema: removeEmailResponseSchema } },
        description: "Email deleted, including its events",
      },
      403: jsonErr("Restricted API key"),
      404: jsonErr("Not found"),
    },
  });

  app.openapi(deleteEmailRoute, async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");
    // Hard delete: events cascade with the row. A queued email whose row
    // vanishes is skipped by the send handler, so deletion is safe in any
    // state. Not part of Resend's surface.
    const [row] = await deps.db
      .delete(schema.emails)
      .where(
        and(
          eq(schema.emails.id, id),
          eq(schema.emails.teamId, auth.teamId),
          ...emailScopeConditions(auth),
        ),
      )
      .returning({ id: schema.emails.id });
    if (!row) return c.json(errorBody(404, "not_found", "Email not found"), 404);
    return c.json({ object: "email" as const, id: row.id, deleted: true as const }, 200);
  });

  // MCP needs APP_BASE_URL twice over: it is the OAuth issuer and the base
  // the canonical resource URL derives from. Without it there is no /mcp.
  if (deps.appBaseUrl) registerMcp(app, deps, deps.appBaseUrl);

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
