import { isNull } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
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

/**
 * The MX's unfolded results for trust decisions (core authDetailSchema);
 * Resend-shaped reads never echo them. Null from an MX that predates them.
 */
export interface ReceivedAuthDetail {
  spf: { result: string; domain: string | null };
  /** Passing DKIM signatures aligned with From, at most 3 domains. */
  dkim: { aligned: string[] };
  dmarc: {
    /** Never folded under p=none, unlike authentication.dmarc. */
    result: string;
    policy: "none" | "quarantine" | "reject" | null;
    /** The author (From) domain. */
    domain: string | null;
  };
}

/** What the read pipeline removed as hidden: counts and flags only, never content. */
export interface ReceivedHiddenText {
  chars: number;
  preview_chars: number;
  invisible_chars: number;
  flags: string[];
}

/** Who a sender is to the team, strongest first; failed beats every other rule. */
export const senderTrustEnum = pgEnum("sender_trust", [
  "owner",
  "allowlisted",
  "known_thread",
  "external",
  "unauthenticated",
  "failed",
]);

export const receivedSpamVerdictEnum = pgEnum("received_spam_verdict", ["pass", "gray", "fail"]);

export const receivedVirusVerdictEnum = pgEnum("received_virus_verdict", [
  "pass",
  "fail",
  "processing_failed",
]);

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
    // From display name, one visible line.
    fromName: text("from_name").notNull().default(""),
    // Threading headers as msg-ids (each <= 998 chars, at most 50), plus bare
    // ms1. thread tokens that some clients write without angle brackets.
    inReplyTo: text("in_reply_to"),
    references: jsonb("references").$type<string[]>().notNull().default([]),
    // From fields in the header and mailboxes in them: anything but one and
    // one is never trusted above unauthenticated.
    fromFields: smallint("from_fields").notNull().default(1),
    fromMailboxes: smallint("from_mailboxes").notNull().default(1),
    // Why an automatic answer must not go out (RFC 3834), or null.
    automated: text("automated"),
    authDetail: jsonb("auth_detail").$type<ReceivedAuthDetail>(),
    // The row tier: team owners only, no allowlist, no thread proof. Each
    // inbox membership keeps its own.
    senderTrust: senderTrustEnum("sender_trust").notNull().default("unauthenticated"),
    // Null: not computed (rows from before verdicts existed).
    spamVerdict: receivedSpamVerdictEnum("spam_verdict"),
    spamScore: smallint("spam_score"),
    spamReasons: text("spam_reasons").array().notNull().default([]),
    // Null: not scanned.
    virusVerdict: receivedVirusVerdictEnum("virus_verdict"),
    virusSignature: text("virus_signature"),
    hiddenText: jsonb("hidden_text").$type<ReceivedHiddenText>(),
    // Metadata, so finding a code never opens a seal.
    extractedKinds: text("extracted_kinds")
      .array()
      .$type<("code" | "link")[]>()
      .notNull()
      .default([]),
    // Content: the sealed read (text, quoted, signature, code, link), envelope
    // kind received_extracted, nulled by the content purge with the raw message.
    extracted: text("extracted"),
    // At least one recipient landed without an inbox.
    catchAll: boolean("catch_all").notNull().default(true),
    // When email.received was enqueued; its only emitter sets it once.
    announcedAt: timestamp("announced_at", { withTimezone: true }),
    // A virus-held catch-all row released by a person.
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedBy: text("released_by"),
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
    // Threading: a reply's References name an earlier message of the team.
    index("received_emails_team_message_id_idx").on(t.teamId, t.messageId),
  ],
);
