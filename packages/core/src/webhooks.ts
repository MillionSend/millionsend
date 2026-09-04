import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
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

/** @param timestamp unix seconds (Standard Webhooks wire format). */
export function signWebhook(
  secret: string,
  params: { msgId: string; timestamp: number; payload: string },
): WebhookSignatureHeaders {
  const signedContent = `${params.msgId}.${params.timestamp}.${params.payload}`;
  const hmac = createHmac("sha256", secretKey(secret)).update(signedContent).digest("base64");
  const timestamp = String(params.timestamp);
  const signature = `v1,${hmac}`;
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
    enqueue: (deliveryId: string) => Promise<void>;
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
    enqueue: (deliveryId: string) => Promise<void>;
  },
): Promise<void> {
  await insertDeliveries(db, {
    teamId: params.teamId,
    emailId: null,
    type: params.type,
    payload: { type: params.type, created_at: params.occurredAt.toISOString(), data: params.data },
    enqueue: params.enqueue,
  });
}

async function insertDeliveries(
  db: Db,
  params: {
    teamId: string;
    emailId: string | null;
    type: WebhookEventType;
    payload: WebhookPayload;
    enqueue: (deliveryId: string) => Promise<void>;
  },
): Promise<void> {
  const endpoints = await db
    .select({ id: schema.webhookEndpoints.id, events: schema.webhookEndpoints.events })
    .from(schema.webhookEndpoints)
    .where(
      and(
        eq(schema.webhookEndpoints.teamId, params.teamId),
        eq(schema.webhookEndpoints.status, "enabled"),
      ),
    );
  const matching = endpoints.filter((e) => e.events === null || e.events.includes(params.type));
  for (const endpoint of matching) {
    const [row] = await db
      .insert(schema.webhookDeliveries)
      .values({
        endpointId: endpoint.id,
        emailId: params.emailId,
        messageId: `msg_${randomUUID()}`,
        eventType: params.type,
        payload: params.payload as unknown as Record<string, unknown>,
      })
      .returning({ id: schema.webhookDeliveries.id });
    if (row) await params.enqueue(row.id);
  }
}
