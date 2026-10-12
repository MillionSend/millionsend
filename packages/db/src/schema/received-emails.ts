import { isNull } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea } from "./custom-types.js";
import { teams } from "./teams.js";

/** The MX's SPF, DKIM, DMARC and ARC verdicts, mailauth's lowercase results. */
export interface ReceivedAuthentication {
  spf: string;
  dkim: string;
  dmarc: string;
  arc: string;
}

/** What the MX saw of the SMTP session, recipients aside (they live in received_for). */
export interface ReceivedEnvelope {
  /** The reverse-path, "" for the null sender <>. */
  mailFrom: string;
  clientIp: string;
  helo: string;
  tls: { protocol?: string | undefined; cipher?: string | undefined } | null;
}

/**
 * Inbound mail, one row per (message, team). Same lifecycle split as
 * emails: the plaintext columns are metadata on the metadata retention
 * clock; the raw RFC 822 message and the attachment list are content,
 * sealed with the email envelope scheme (their own envelope kinds) and nulled
 * by the content purge, which stamps contentPurgedAt. HTML, text, headers
 * and attachment bytes are parsed out of the raw message on read.
 */
export const receivedEmails = pgTable(
  "received_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // The team's domains the envelope addressed, for domain-scoped API keys.
    // Plain ids, no foreign key: a deleted domain leaves its mail readable
    // until retention, as emails.domain_id does with SET NULL.
    domainIds: uuid("domain_ids").array().notNull(),
    // sha256 (hex) of the raw message. With team_id it is the idempotency
    // key: the MX retrying a delivery whose 200 it never saw stores nothing new.
    rawSha256: text("raw_sha256").notNull(),
    // Message-ID header as sent (angle brackets kept), or one made up when absent.
    messageId: text("message_id").notNull(),
    // Bare addresses from the headers; the display names live in the raw message.
    from: text("from").notNull(),
    to: jsonb("to").$type<string[]>().notNull().default([]),
    cc: jsonb("cc").$type<string[]>().notNull().default([]),
    bcc: jsonb("bcc").$type<string[]>().notNull().default([]),
    replyTo: jsonb("reply_to").$type<string[]>().notNull().default([]),
    // SECURITY: this team's envelope recipients only. Another team's
    // recipients of the same message (its BCCs above all) never land here.
    receivedFor: jsonb("received_for").$type<string[]>().notNull(),
    subject: text("subject").notNull().default(""),
    envelope: jsonb("envelope").$type<ReceivedEnvelope>().notNull(),
    authentication: jsonb("authentication").$type<ReceivedAuthentication>().notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    attachmentCount: integer("attachment_count").notNull().default(0),
    rawCiphertext: bytea("raw_ciphertext"),
    rawIv: bytea("raw_iv"),
    rawWrappedDek: bytea("raw_wrapped_dek"),
    rawKeyVersion: integer("raw_key_version"),
    // Sealed attachment list (envelope parts inside base64 JSON, like
    // emails.attachments), so lists never open the raw message.
    attachments: text("attachments"),
    contentPurgedAt: timestamp("content_purged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("received_emails_team_raw_idx").on(t.teamId, t.rawSha256),
    // A team's list, keyset-paged on (created_at, id).
    index("received_emails_team_created_idx").on(t.teamId, t.createdAt, t.id),
    // The content purge visits only rows that still hold content.
    index("received_emails_content_unpurged_idx").on(t.createdAt).where(isNull(t.contentPurgedAt)),
    // Metadata retention deletes by age across every team.
    index("received_emails_created_idx").on(t.createdAt),
  ],
);
