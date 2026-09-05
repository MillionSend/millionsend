import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { inArray } from "drizzle-orm";
import type { ContactActivityRow } from "./contact-activities.js";
import { ERASED_TOMBSTONE } from "./erase-recipient.js";
import { SUPPRESSION_ORIGIN_BY_REASON, type SuppressionReason } from "./suppressions.js";
import {
  enqueueTeamWebhookEvents,
  type WebhookEnqueue,
  type WebhookEventType,
} from "./webhooks.js";

/**
 * Who made a contact or suppression change: the recipient themselves through
 * an RFC 8058 header post (one_click) or the hosted preference page
 * (hosted_page), or the team through the API or the dashboard.
 */
export type ContactEventSource = "one_click" | "hosted_page" | "api" | "dashboard";

/**
 * Provenance plus the queue hand-off for a change's webhook deliveries.
 * Without `enqueue` the delivery rows still land and the webhooks.reconcile
 * sweep sends them within fifteen minutes.
 */
export interface ContactEventContext {
  source: ContactEventSource;
  enqueue?: WebhookEnqueue | undefined;
}

export type ContactSnapshot = Pick<
  typeof schema.contacts.$inferSelect,
  "id" | "email" | "firstName" | "lastName" | "unsubscribed" | "createdAt" | "updatedAt"
>;

/** Resend's contact event `data`, plus whatever the event adds (source, topic). */
export function contactEventData(
  contact: ContactSnapshot,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: contact.id,
    email: contact.email,
    first_name: contact.firstName,
    last_name: contact.lastName,
    unsubscribed: contact.unsubscribed,
    created_at: contact.createdAt.toISOString(),
    updated_at: contact.updatedAt.toISOString(),
    ...extras,
  };
}

const EVENT_BY_ACTIVITY: Partial<Record<ContactActivityRow["type"], WebhookEventType>> = {
  contact_created: "contact.created",
  unsubscribed: "contact.unsubscribed",
  resubscribed: "contact.resubscribed",
  topic_opt_in: "contact.topic_opt_in",
  topic_opt_out: "contact.topic_opt_out",
};

/** The webhook event a timeline row publishes; segment rows stay internal. */
export function webhookEventForActivity(
  type: ContactActivityRow["type"],
): WebhookEventType | undefined {
  return EVENT_BY_ACTIVITY[type];
}

export async function loadContactSnapshots(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, ContactSnapshot>> {
  if (ids.length === 0) return new Map();
  const c = schema.contacts;
  const rows = await db
    .select({
      id: c.id,
      email: c.email,
      firstName: c.firstName,
      lastName: c.lastName,
      unsubscribed: c.unsubscribed,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })
    .from(c)
    .where(inArray(c.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row]));
}

export interface ContactEvent {
  type: WebhookEventType;
  contact: ContactSnapshot;
  extras?: Record<string, unknown> | undefined;
}

/**
 * Publishes contact events to the team's endpoints. Best-effort like the
 * timeline write it usually follows: a failure is logged, never thrown, so
 * an outage on our side cannot fail the mutation that caused the event.
 */
export async function emitContactEvents(
  db: Db,
  params: {
    teamId: string;
    events: readonly ContactEvent[];
    ctx: ContactEventContext;
    occurredAt?: Date;
  },
): Promise<void> {
  if (params.events.length === 0) return;
  const occurredAt = params.occurredAt ?? new Date();
  try {
    await enqueueTeamWebhookEvents(db, {
      teamId: params.teamId,
      events: params.events.map((event) => ({
        type: event.type,
        occurredAt,
        // Deleting a contact is an erasure, so the deleted event never carries
        // the address; receivers key on the id.
        data: contactEventData(
          event.type === "contact.deleted"
            ? { ...event.contact, email: ERASED_TOMBSTONE }
            : event.contact,
          { source: params.ctx.source, ...event.extras },
        ),
      })),
      enqueue: params.ctx.enqueue ?? (async () => {}),
    });
  } catch (err) {
    console.error("contact webhook events failed", err);
  }
}

/** A topic row's snapshot (`{ topicId, name }`) as the event's extra fields. */
function topicExtras(data: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!data || typeof data.topicId !== "string") return {};
  return { topic_id: data.topicId, topic_name: typeof data.name === "string" ? data.name : null };
}

/** Timeline rows → contact events: each contact is loaded once, per team. */
export async function emitActivityEvents(
  db: Db,
  rows: readonly ContactActivityRow[],
  ctx: ContactEventContext,
): Promise<void> {
  const publishable = rows.filter((row) => webhookEventForActivity(row.type) !== undefined);
  if (publishable.length === 0) return;
  try {
    const snapshots = await loadContactSnapshots(db, [
      ...new Set(publishable.map((row) => row.contactId)),
    ]);
    for (const teamId of new Set(publishable.map((row) => row.teamId))) {
      const events: ContactEvent[] = [];
      for (const row of publishable) {
        if (row.teamId !== teamId) continue;
        const type = webhookEventForActivity(row.type);
        const contact = snapshots.get(row.contactId);
        if (type && contact) events.push({ type, contact, extras: topicExtras(row.data) });
      }
      await emitContactEvents(db, { teamId, events, ctx });
    }
  } catch (err) {
    console.error("contact webhook events failed", err);
  }
}

export interface SuppressionEventRow {
  id: string;
  email: string | null;
  reason: SuppressionReason;
  createdAt?: Date | null | undefined;
}

/**
 * Publishes suppression list changes. `source` is absent for rows SES wrote
 * (bounces, complaints); `data.origin` speaks the API's vocabulary.
 */
export async function emitSuppressionEvents(
  db: Db,
  params: {
    teamId: string;
    type: "suppression.added" | "suppression.removed";
    rows: readonly SuppressionEventRow[];
    source?: ContactEventSource | undefined;
    enqueue?: WebhookEnqueue | undefined;
    occurredAt?: Date;
  },
): Promise<void> {
  if (params.rows.length === 0) return;
  const occurredAt = params.occurredAt ?? new Date();
  try {
    await enqueueTeamWebhookEvents(db, {
      teamId: params.teamId,
      events: params.rows.map((row) => ({
        type: params.type,
        occurredAt,
        data: {
          id: row.id,
          // Erased rows keep blocking but have no address; the wire says so.
          email: row.email ?? ERASED_TOMBSTONE,
          origin: SUPPRESSION_ORIGIN_BY_REASON[row.reason],
          source: params.source ?? null,
          created_at: (row.createdAt ?? occurredAt).toISOString(),
        },
      })),
      enqueue: params.enqueue ?? (async () => {}),
    });
  } catch (err) {
    console.error("suppression webhook events failed", err);
  }
}
