import { isNull, sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { broadcasts } from "./broadcasts.js";
import { bytea } from "./custom-types.js";
import { domains } from "./domains.js";
import { teams } from "./teams.js";

/**
 * Status values are ordered: updates apply only when the incoming status ranks
 * higher than the stored one (compare-and-set in @millionsend/core), so
 * out-of-order SES events can never regress a delivered email to "sent".
 *
 * "failed" is strictly terminal: retryable send errors keep the email in
 * "queued" (the job requeues); only permanent, non-retryable failure sets
 * "failed" — a failed email can therefore never later be delivered.
 *
 * "canceled" is terminal and ranks highest so applyStatusCas can never
 * regress it: a scheduled email flips to it before its send job runs, and
 * the send handler's queued-only guard then skips it.
 */
export const emailStatusEnum = pgEnum("email_status", [
  "queued_quota",
  "queued",
  "sent",
  "delivery_delayed",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "suppressed",
  "failed",
  "canceled",
]);

/**
 * Event vocabulary is deliberately a separate, unordered enum: it grows with
 * provider events (e.g. rendering_failure) that have no place in the ordered
 * status ladder above.
 */
export const emailEventTypeEnum = pgEnum("email_event_type", [
  "queued",
  "queued_quota",
  "sent",
  "delivery_delayed",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "suppressed",
  "rendering_failure",
  "failed",
]);

/**
 * Lifecycle split (compliance by schema): the plaintext columns here are
 * metadata and live on the events/metadata retention clock; the body*
 * columns are content — AES-256-GCM ciphertext with a per-email wrapped DEK —
 * and are nulled by the retention purge (bodyPurgedAt) without touching the row.
 */
export const emails = pgTable(
  "emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    domainId: uuid("domain_id").references(() => domains.id, { onDelete: "set null" }),
    apiKeyId: uuid("api_key_id"),
    broadcastId: uuid("broadcast_id").references(() => broadcasts.id, { onDelete: "set null" }),
    // No FK: the contact may be deleted later and per-broadcast stats must
    // survive it.
    contactId: uuid("contact_id"),
    sesMessageId: text("ses_message_id"),
    from: text("from").notNull(),
    to: jsonb("to").$type<string[]>().notNull(),
    cc: jsonb("cc").$type<string[]>(),
    bcc: jsonb("bcc").$type<string[]>(),
    replyTo: jsonb("reply_to").$type<string[]>(),
    subject: text("subject").notNull(),
    tags: jsonb("tags").$type<Record<string, string>>(),
    latestStatus: emailStatusEnum("latest_status").notNull().default("queued"),
    bodyCiphertext: bytea("body_ciphertext"),
    bodyIv: bytea("body_iv"),
    bodyWrappedDek: bytea("body_wrapped_dek"),
    bodyKeyVersion: integer("body_key_version"),
    bodyPurgedAt: timestamp("body_purged_at", { withTimezone: true }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    index("emails_team_created_idx").on(t.teamId, t.createdAt),
    // The SES event join key must be unique when present.
    uniqueIndex("emails_ses_message_id_idx")
      .on(t.sesMessageId)
      .where(sql`${t.sesMessageId} is not null`),
    // Partial index drives the retention purge scan (rows whose body still exists).
    index("emails_body_unpurged_idx").on(t.createdAt).where(isNull(t.bodyPurgedAt)),
    // Fan-out idempotency spine: re-running a broadcast fan-out can never
    // insert (and thus never send) a second email to the same contact.
    uniqueIndex("emails_broadcast_contact_idx")
      .on(t.broadcastId, t.contactId)
      .where(sql`${t.broadcastId} is not null`),
  ],
);

export const emailEvents = pgTable(
  "email_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailId: uuid("email_id")
      .notNull()
      .references(() => emails.id, { onDelete: "cascade" }),
    type: emailEventTypeEnum("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    // Durable idempotency key: SNS delivers at-least-once and queue-level
    // dedupe cannot cover post-completion redeliveries, so the SNS MessageId
    // is recorded here and enforced unique. Null for worker-originated events.
    snsMessageId: text("sns_message_id"),
    // Raw provider payload subset (bounce diagnostics, click URL, user agent...).
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("email_events_email_idx").on(t.emailId, t.occurredAt),
    uniqueIndex("email_events_sns_message_id_idx")
      .on(t.snsMessageId)
      .where(sql`${t.snsMessageId} is not null`),
  ],
);
