import { isNull } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { domains } from "./domains.js";
import { teams } from "./teams.js";

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Status values are ordered: updates apply only when the incoming status ranks
 * higher than the stored one (compare-and-set in @millionsend/core), so
 * out-of-order SES events can never regress a delivered email to "sent".
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
    index("emails_ses_message_id_idx").on(t.sesMessageId),
    // Partial index drives the retention purge scan (rows whose body still exists).
    index("emails_body_unpurged_idx").on(t.createdAt).where(isNull(t.bodyPurgedAt)),
  ],
);

export const emailEvents = pgTable(
  "email_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailId: uuid("email_id")
      .notNull()
      .references(() => emails.id, { onDelete: "cascade" }),
    type: emailStatusEnum("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    // Raw provider payload subset (bounce diagnostics, click URL, user agent...).
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("email_events_email_idx").on(t.emailId, t.occurredAt)],
);
