import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import {
  decryptPayload,
  type EncryptedBody,
  type EnvelopeOwner,
  encryptPayload,
} from "./crypto/envelope.js";
import type { Keyring } from "./crypto/keyring.js";

/**
 * Standard Webhooks (the spec Resend/Svix implement): secrets are
 * `whsec_<base64>`, the signed content is `msgId.timestamp.payload`, and the
 * signature travels in `webhook-signature: v1,<base64 hmac>` alongside
 * `webhook-id` and `webhook-timestamp` headers.
 */

export const WEBHOOK_EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.opened",
  "email.clicked",
  // Team-level standing events: no email in the payload.
  "deliverability.warning",
  "deliverability.paused",
  "quota.warning",
  "quota.reached",
  "quota.paused",
  // Audience events: `data` is the contact in Resend's contact.* shape plus
  // `source` (api, dashboard, hosted_page, one_click); the topic pair adds
  // topic_id and topic_name. Resend emits only created/updated/deleted.
  "contact.created",
  "contact.updated",
  "contact.deleted",
  "contact.unsubscribed",
  "contact.resubscribed",
  "contact.topic_opt_in",
  "contact.topic_opt_out",
  "suppression.added",
  "suppression.removed",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

const SECRET_PREFIX = "whsec_";
const SECRET_MIN_BYTES = 24;
const SECRET_MAX_BYTES = 64;

export function generateWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(SECRET_MIN_BYTES).toString("base64");
}

/**
 * Key bytes of a `whsec_` secret, or null unless it is canonical base64 of
 * 24–64 bytes. Canonical = re-encodes to the same string: a secret that only
 * decodes leniently (base64url, missing padding) would sign deliveries that a
 * strict receiver-side library cannot verify.
 */
export function parseWebhookSecret(secret: string): Buffer | null {
  if (!secret.startsWith(SECRET_PREFIX)) return null;
  const encoded = secret.slice(SECRET_PREFIX.length);
  const key = Buffer.from(encoded, "base64");
  if (key.length < SECRET_MIN_BYTES || key.length > SECRET_MAX_BYTES) return null;
  return key.toString("base64") === encoded ? key : null;
}

function secretKey(secret: string): Buffer {
  const key = parseWebhookSecret(secret);
  if (!key) throw new Error("invalid webhook secret");
  return key;
}

/**
 * One signature, two header names: `webhook-*` per Standard Webhooks and
 * `svix-*` as Resend/Svix deliver it, so receivers written against either
 * spec verify unchanged. Paired values are always identical.
 */
export interface WebhookSignatureHeaders {
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
  "svix-id": string;
  "svix-timestamp": string;
  "svix-signature": string;
}

/**
 * @param secret one secret, or several (current first) during a rotation's
 * overlap: each signs, and the candidates travel space-delimited in
 * `webhook-signature`, the spec's zero-downtime rotation.
 * @param timestamp unix seconds (Standard Webhooks wire format).
 */
export function signWebhook(
  secret: string | readonly string[],
  params: { msgId: string; timestamp: number; payload: string },
): WebhookSignatureHeaders {
  const secrets = typeof secret === "string" ? [secret] : secret;
  if (secrets.length === 0) throw new Error("no webhook secret to sign with");
  const signedContent = `${params.msgId}.${params.timestamp}.${params.payload}`;
  const timestamp = String(params.timestamp);
  const signature = secrets
    .map((s) => `v1,${createHmac("sha256", secretKey(s)).update(signedContent).digest("base64")}`)
    .join(" ");
  return {
    "webhook-id": params.msgId,
    "webhook-timestamp": timestamp,
    "webhook-signature": signature,
    "svix-id": params.msgId,
    "svix-timestamp": timestamp,
    "svix-signature": signature,
  };
}

const VERIFY_TOLERANCE_SECONDS = 5 * 60;

/**
 * Receiver-side verification (documentation/tests; delivery only signs).
 * Checks timestamp tolerance and any of the space-delimited v1 signatures.
 */
export function verifyWebhookSignature(
  secret: string,
  headers: { id: string; timestamp: string; signature: string },
  payload: string,
  opts: { toleranceSeconds?: number; now?: Date } = {},
): boolean {
  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const timestamp = Number.parseInt(headers.timestamp, 10);
  if (!Number.isFinite(timestamp)) return false;
  const tolerance = opts.toleranceSeconds ?? VERIFY_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - timestamp) > tolerance) return false;

  const expected = createHmac("sha256", secretKey(secret))
    .update(`${headers.id}.${timestamp}.${payload}`)
    .digest();
  return headers.signature.split(" ").some((candidate) => {
    const [version, sig] = candidate.split(",", 2);
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export interface WebhookEmailFacts {
  emailId: string;
  from: string;
  to: string[];
  subject: string;
}

export interface WebhookPayload {
  type: WebhookEventType;
  created_at: string;
  data: Record<string, unknown>;
}

/** Event payload mirroring Resend's webhook event shape. */
export function buildWebhookPayload(
  type: WebhookEventType,
  email: WebhookEmailFacts,
  occurredAt: Date,
  extras: Record<string, unknown> = {},
): WebhookPayload {
  return {
    type,
    created_at: occurredAt.toISOString(),
    data: {
      email_id: email.emailId,
      from: email.from,
      to: email.to,
      subject: email.subject,
      created_at: occurredAt.toISOString(),
      ...extras,
    },
  };
}

/** Svix-style backoff between attempts; length is the attempt cap. */
export const WEBHOOK_RETRY_SCHEDULE_MS = [
  5_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  5 * 3_600_000,
  10 * 3_600_000,
] as const;

export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_SCHEDULE_MS.length;

export async function encryptWebhookSecret(
  secret: string,
  keyring: Keyring,
  owner?: EnvelopeOwner,
): Promise<EncryptedBody> {
  return encryptPayload(
    Buffer.from(secret, "utf8"),
    keyring,
    owner && { ...owner, kind: "webhook_secret" },
  );
}

export async function decryptWebhookSecret(
  encrypted: EncryptedBody,
  keyring: Keyring,
  owner?: EnvelopeOwner,
): Promise<string> {
  return (
    await decryptPayload(encrypted, keyring, owner && { ...owner, kind: "webhook_secret" })
  ).toString("utf8");
}

/**
 * Overlap after a rotation during which the outgoing secret keeps signing:
 * long enough to roll every receiver, short enough that a leaked old secret
 * stops mattering within days.
 */
export const WEBHOOK_ROTATION_DEFAULT_OVERLAP_HOURS = 24;
export const WEBHOOK_ROTATION_MAX_OVERLAP_HOURS = 72;

type WebhookEndpointRow = typeof schema.webhookEndpoints.$inferSelect;
type CurrentSecretColumns = Pick<
  WebhookEndpointRow,
  "secretCiphertext" | "secretIv" | "secretWrappedDek" | "secretKeyVersion"
>;
type PreviousSecretColumns = Pick<
  WebhookEndpointRow,
  | "prevSecretCiphertext"
  | "prevSecretIv"
  | "prevSecretWrappedDek"
  | "prevSecretKeyVersion"
  | "prevSecretExpiresAt"
>;

/** When the outgoing secret stops signing after a rotation, or null for "at once". */
export function rotationOverlapEnd(hours: number, now = new Date()): Date | null {
  return hours > 0 ? new Date(now.getTime() + hours * 3_600_000) : null;
}

/**
 * SET clause for a rotation: the new secret takes the current slot and the
 * outgoing one moves to the previous slot until `expiresAt` (null drops it at
 * once). The previous columns reference the row's own current columns rather
 * than a value read beforehand: Postgres evaluates SET against the pre-update
 * row under its lock, so two rotations racing each other chain (the second's
 * previous is the first's new) instead of both copying one stale snapshot. A
 * rotation inside an open window replaces the previous secret, so at most two
 * ever sign.
 */
export function rotatedWebhookSecretColumns(
  next: { encrypted: EncryptedBody; last4: string },
  expiresAt: Date | null,
): PgUpdateSetSource<typeof schema.webhookEndpoints> {
  const w = schema.webhookEndpoints;
  return {
    secretCiphertext: next.encrypted.ciphertext,
    secretIv: next.encrypted.iv,
    secretWrappedDek: next.encrypted.wrappedDek,
    secretKeyVersion: next.encrypted.keyVersion,
    secretLast4: next.last4,
    prevSecretCiphertext: expiresAt ? sql`${w.secretCiphertext}` : null,
    prevSecretIv: expiresAt ? sql`${w.secretIv}` : null,
    prevSecretWrappedDek: expiresAt ? sql`${w.secretWrappedDek}` : null,
    prevSecretKeyVersion: expiresAt ? sql`${w.secretKeyVersion}` : null,
    prevSecretExpiresAt: expiresAt,
  };
}

/**
 * The secrets a delivery signs with, current first. During a rotation's
 * overlap the previous secret signs too, so the header carries two candidates
 * and a receiver holding either one verifies.
 */
export async function decryptWebhookSigningSecrets(
  endpoint: CurrentSecretColumns & PreviousSecretColumns & { id: string; teamId: string },
  keyring: Keyring,
  now = new Date(),
): Promise<string[]> {
  const owner = { teamId: endpoint.teamId, rowId: endpoint.id };
  const secrets = [
    await decryptWebhookSecret(
      {
        ciphertext: endpoint.secretCiphertext,
        iv: endpoint.secretIv,
        wrappedDek: endpoint.secretWrappedDek,
        keyVersion: endpoint.secretKeyVersion,
      },
      keyring,
      owner,
    ),
  ];
  if (
    endpoint.prevSecretCiphertext &&
    endpoint.prevSecretIv &&
    endpoint.prevSecretWrappedDek &&
    endpoint.prevSecretKeyVersion !== null &&
    endpoint.prevSecretExpiresAt &&
    endpoint.prevSecretExpiresAt > now
  ) {
    secrets.push(
      await decryptWebhookSecret(
        {
          ciphertext: endpoint.prevSecretCiphertext,
          iv: endpoint.prevSecretIv,
          wrappedDek: endpoint.prevSecretWrappedDek,
          keyVersion: endpoint.prevSecretKeyVersion,
        },
        keyring,
        owner,
      ),
    );
  }
  return secrets;
}

/** A delivery row just written, with the endpoint it belongs to (the queue's fairness group). */
export interface QueuedWebhookDelivery {
  id: string;
  endpointId: string;
}

/**
 * Hands freshly written delivery rows to the queue: one call per fan-out
 * however many endpoints matched, so a burst is one statement, not one per
 * endpoint.
 */
export type WebhookEnqueue = (deliveries: readonly QueuedWebhookDelivery[]) => Promise<void>;

/**
 * Rows per INSERT. postgres.js binds one parameter per value and Postgres
 * caps a statement at 65,534, so a fan-out of contacts × endpoints is sliced
 * well under that.
 */
const INSERT_CHUNK = 2000;

/**
 * Fan an email event out to the owning team's enabled endpoints: one
 * delivery row + one job per matching endpoint. Callers invoke this exactly
 * once per event fact (the SNS dedupe / send claim already gate that), so no
 * extra idempotency key is needed here. Endpoints are matched strictly by
 * the email's own teamId — never by anything event-supplied.
 */
export async function enqueueWebhookDeliveries(
  db: Db,
  params: {
    teamId: string;
    email: WebhookEmailFacts;
    type: WebhookEventType;
    occurredAt: Date;
    extras?: Record<string, unknown>;
    enqueue: WebhookEnqueue;
  },
): Promise<void> {
  await insertDeliveries(db, {
    teamId: params.teamId,
    emailId: params.email.emailId,
    type: params.type,
    payload: buildWebhookPayload(params.type, params.email, params.occurredAt, params.extras),
    enqueue: params.enqueue,
  });
}

/**
 * Fan a team-level event (quota, deliverability standing) out the same way;
 * the payload carries no email, so `data` is whatever the event is about.
 */
export async function enqueueTeamWebhookDeliveries(
  db: Db,
  params: {
    teamId: string;
    type: WebhookEventType;
    occurredAt: Date;
    data: Record<string, unknown>;
    enqueue: WebhookEnqueue;
  },
): Promise<void> {
  await enqueueTeamWebhookEvents(db, {
    teamId: params.teamId,
    events: [{ type: params.type, occurredAt: params.occurredAt, data: params.data }],
    enqueue: params.enqueue,
  });
}

export interface TeamWebhookEvent {
  type: WebhookEventType;
  occurredAt: Date;
  data: Record<string, unknown>;
}

/**
 * Several team-level events at once (a batch import creates hundreds of
 * contacts): the endpoints are read once and every matching delivery row
 * lands in one insert.
 */
export async function enqueueTeamWebhookEvents(
  db: Db,
  params: {
    teamId: string;
    events: readonly TeamWebhookEvent[];
    enqueue: WebhookEnqueue;
  },
): Promise<void> {
  if (params.events.length === 0) return;
  const endpoints = await enabledEndpoints(db, params.teamId);
  const values = params.events.flatMap((event) =>
    endpoints
      .filter((e) => e.events === null || e.events.includes(event.type))
      .map((endpoint) => ({
        endpointId: endpoint.id,
        emailId: null,
        messageId: `msg_${randomUUID()}`,
        eventType: event.type,
        payload: {
          type: event.type,
          created_at: event.occurredAt.toISOString(),
          data: event.data,
        } as Record<string, unknown>,
      })),
  );
  await insertDeliveryRows(db, values, params.enqueue);
}

type DeliveryInsert = typeof schema.webhookDeliveries.$inferInsert;

/** Writes delivery rows in bounded slices and hands each slice to the queue. */
async function insertDeliveryRows(
  db: Db,
  values: DeliveryInsert[],
  enqueue: WebhookEnqueue,
): Promise<void> {
  for (let i = 0; i < values.length; i += INSERT_CHUNK) {
    const rows = await db
      .insert(schema.webhookDeliveries)
      .values(values.slice(i, i + INSERT_CHUNK))
      .returning({
        id: schema.webhookDeliveries.id,
        endpointId: schema.webhookDeliveries.endpointId,
      });
    if (rows.length > 0) await enqueue(rows);
  }
}

function enabledEndpoints(db: Db, teamId: string) {
  return db
    .select({ id: schema.webhookEndpoints.id, events: schema.webhookEndpoints.events })
    .from(schema.webhookEndpoints)
    .where(
      and(
        eq(schema.webhookEndpoints.teamId, teamId),
        eq(schema.webhookEndpoints.status, "enabled"),
      ),
    );
}

async function insertDeliveries(
  db: Db,
  params: {
    teamId: string;
    emailId: string | null;
    type: WebhookEventType;
    payload: WebhookPayload;
    enqueue: WebhookEnqueue;
  },
): Promise<void> {
  const endpoints = await enabledEndpoints(db, params.teamId);
  const matching = endpoints.filter((e) => e.events === null || e.events.includes(params.type));
  await insertDeliveryRows(
    db,
    matching.map((endpoint) => ({
      endpointId: endpoint.id,
      emailId: params.emailId,
      messageId: `msg_${randomUUID()}`,
      eventType: params.type,
      payload: params.payload as unknown as Record<string, unknown>,
    })),
    params.enqueue,
  );
}
