import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea } from "./custom-types.js";
import { domains } from "./domains.js";
import { emails } from "./emails.js";
import { receivedEmails, senderTrustEnum } from "./received-emails.js";
import { teams } from "./teams.js";

export const inboxKindEnum = pgEnum("inbox_kind", ["agent", "human"]);

export const inboxThreadFolderEnum = pgEnum("inbox_thread_folder", [
  "inbox",
  "archive",
  "spam",
  "sent",
  "trash",
]);

export const inboxScreeningVerdictEnum = pgEnum("inbox_screening_verdict", [
  "pending",
  "clean",
  "suspicious",
  "quarantined",
  "released",
]);

export const inboxQuarantineReasonEnum = pgEnum("inbox_quarantine_reason", [
  "failed_auth",
  "unauthenticated_sender",
  "not_allowlisted",
  "injection",
  "phishing",
  "virus",
  "unscreened",
  "screening_cap",
]);

export const inboxDraftTypeEnum = pgEnum("inbox_draft_type", ["standalone", "reply"]);

export const inboxDraftStatusEnum = pgEnum("inbox_draft_status", [
  "draft",
  "pending_approval",
  "sent",
  "rejected",
  "expired",
]);

/** An inbox's rules, stored whole (never partial); validated by core inboxSafetySchema. */
export interface InboxSafety {
  accept_from: "anyone" | "verified" | "allowlist";
  /** "local@domain" (exact, lowercase, no plus-stripping) or "*@domain" (the domain and its subdomains). */
  allowlist: string[];
  /** Owners besides the team members' login addresses. */
  owner_addresses: string[];
  /** The inbound judge; always false for kind human. */
  screening: boolean;
  /** Exposes extracted.code/link and codes/latest (secret MACs are recorded regardless). */
  extract_codes: boolean;
  send_policy: "reply_only" | "allowlist" | "open";
  require_approval: boolean;
  private_codes: boolean;
  /** Unattended recipients per UTC day; null = no inbox cap. */
  send_cap: number | null;
  /** Each a team member's login address or one of owner_addresses. */
  forward_to: string[];
}

/** The inbound judge's run on one membership; never the text it read. */
export interface InboxJudgeRecord {
  version: string;
  model: string;
  status: string;
  latency_ms: number;
}

/**
 * A team's subdomain of SHARED_INBOX_DOMAIN. Not a domains row: everything
 * that walks domains (reverification, reaping, SES tenants, warm-up) must
 * never touch a name the platform owns.
 */
export const sharedInboxDomains = pgTable("shared_inbox_domains", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Null once the team is deleted: the row stays so the label is never
  // issued again, or a new team could receive the old team's mail.
  teamId: uuid("team_id")
    .unique()
    .references(() => teams.id, { onDelete: "set null" }),
  // Lowercase FQDN: <label>.<SHARED_INBOX_DOMAIN>.
  name: text("name").notNull().unique(),
  // The region whose SES tenant (named by the team id) has the shared
  // identity associated; null until a shared send associates it. The
  // identity serves every team: nothing done for one team deletes or
  // disassociates it.
  sesTenantRegion: text("ses_tenant_region"),
  // The configuration set associated alongside (null = none was). A shared
  // send names TenantName only while both columns match what it uses.
  sesTenantConfigSet: text("ses_tenant_config_set"),
  // Set by the first inbox that takes an address on the label. Until then
  // (and while no inbox is on it) the label follows the team name and is
  // released on rename or deletion; from then on it never changes, and a
  // deleted team leaves it as a tombstone.
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One address that receives into threads, on a team domain or on the team's
 * shared subdomain. kind and email_address never change after creation.
 */
export const inboxes = pgTable(
  "inboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    kind: inboxKindEnum("kind").notNull(),
    // Lowercase local@domain.
    emailAddress: text("email_address").notNull(),
    localPart: text("local_part").notNull(),
    domainId: uuid("domain_id").references(() => domains.id, { onDelete: "cascade" }),
    // Set for shared addresses, and for the receiving_address of a forwarding inbox.
    sharedDomainId: uuid("shared_domain_id").references(() => sharedInboxDomains.id, {
      onDelete: "cascade",
    }),
    receivingAddress: text("receiving_address"),
    name: text("name").notNull(),
    fromName: text("from_name"),
    safety: jsonb("safety").$type<InboxSafety>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // The first accepted outbound send: day 0 of the new-recipient ramp.
    firstSentAt: timestamp("first_sent_at", { withTimezone: true }),
    // Bumped by use at most once an hour; a shared inbox unused for 90 days
    // is deleted.
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("inboxes_has_domain", sql`${t.domainId} is not null or ${t.sharedDomainId} is not null`),
    check(
      "inboxes_receiving_address_shared",
      sql`${t.receivingAddress} is null or ${t.sharedDomainId} is not null`,
    ),
    uniqueIndex("inboxes_email_address_idx").on(t.emailAddress),
    uniqueIndex("inboxes_receiving_address_idx")
      .on(t.receivingAddress)
      .where(sql`${t.receivingAddress} is not null`),
    index("inboxes_team_created_idx").on(t.teamId, t.createdAt, t.id),
    index("inboxes_domain_idx").on(t.domainId).where(sql`${t.domainId} is not null`),
    // Deleting a label cascades here; without it each delete scans inboxes.
    index("inboxes_shared_domain_idx")
      .on(t.sharedDomainId)
      .where(sql`${t.sharedDomainId} is not null`),
    index("inboxes_expires_idx").on(t.expiresAt).where(sql`${t.expiresAt} is not null`),
  ],
);

/** A conversation in one inbox, inbound and outbound messages alike. */
export const inboxThreads = pgTable(
  "inbox_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    inboxId: uuid("inbox_id")
      .notNull()
      .references(() => inboxes.id, { onDelete: "cascade" }),
    // The first message's subject; '' reads as null on the wire.
    subject: text("subject").notNull().default(""),
    folder: inboxThreadFolderEnum("folder").notNull().default("inbox"),
    // Purged 30 days after the move to trash.
    trashedAt: timestamp("trashed_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    // Lowercase To/Cc/Bcc of our outbound messages: who a reply may come from
    // to count as this thread's (the known_thread tier needs a thread proof too).
    participants: text("participants").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("inbox_threads_inbox_last_idx").on(t.inboxId, t.lastMessageAt, t.id),
    index("inbox_threads_inbox_folder_last_idx").on(t.inboxId, t.folder, t.lastMessageAt, t.id),
    index("inbox_threads_trashed_idx").on(t.trashedAt).where(sql`${t.trashedAt} is not null`),
  ],
);

/**
 * A received message in an inbox: one stored row per message and team, one
 * membership per inbox it reached, each with its own screening state, since
 * trust depends on that inbox's allowlist and owners.
 */
export const receivedEmailInboxes = pgTable(
  "received_email_inboxes",
  {
    receivedEmailId: uuid("received_email_id")
      .notNull()
      .references(() => receivedEmails.id, { onDelete: "cascade" }),
    inboxId: uuid("inbox_id")
      .notNull()
      .references(() => inboxes.id, { onDelete: "cascade" }),
    // Denormalized scope for team-filtered reads; the inbox's cascade covers deletion.
    teamId: uuid("team_id").notNull(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => inboxThreads.id, { onDelete: "cascade" }),
    // The envelope recipient that matched, lowercased.
    address: text("address").notNull(),
    senderTrust: senderTrustEnum("sender_trust").notNull(),
    threadProof: text("thread_proof").$type<"token" | "ses_id">(),
    verdict: inboxScreeningVerdictEnum("verdict").notNull(),
    quarantineReason: inboxQuarantineReasonEnum("quarantine_reason"),
    // The judge's reason keys; never content.
    reasons: text("reasons").array().notNull().default([]),
    injectionScore: smallint("injection_score"),
    phishingScore: smallint("phishing_score"),
    judge: jsonb("judge").$type<InboxJudgeRecord>(),
    // When agents could first see it.
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedBy: text("released_by"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.receivedEmailId, t.inboxId] }),
    index("received_email_inboxes_inbox_created_idx").on(t.inboxId, t.createdAt, t.receivedEmailId),
    index("received_email_inboxes_thread_idx").on(t.threadId, t.createdAt),
    index("received_email_inboxes_unread_idx")
      .on(t.inboxId)
      .where(sql`${t.readAt} is null and ${t.deliveredAt} is not null`),
    index("received_email_inboxes_held_idx")
      .on(t.inboxId, t.quarantinedAt)
      .where(sql`${t.quarantinedAt} is not null and ${t.releasedAt} is null`),
    index("received_email_inboxes_pending_idx")
      .on(t.createdAt)
      .where(sql`${t.verdict} = 'pending'`),
  ],
);

export const inboxLabels = pgTable(
  "inbox_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    inboxId: uuid("inbox_id")
      .notNull()
      .references(() => inboxes.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("inbox_labels_inbox_name_idx").on(t.inboxId, sql`lower(${t.name})`),
    check("inbox_labels_color_hex", sql`${t.color} ~ '^#[0-9A-F]{6}$'`),
  ],
);

export const inboxThreadLabels = pgTable(
  "inbox_thread_labels",
  {
    threadId: uuid("thread_id")
      .notNull()
      .references(() => inboxThreads.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => inboxLabels.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.labelId] }),
    index("inbox_thread_labels_label_idx").on(t.labelId),
  ],
);

/**
 * Unsent mail of an inbox, and sends held for a person's approval. The body
 * is content (sealed {html,text}, envelope kind inbox_draft) on the content
 * clock; the row is metadata.
 */
export const inboxDrafts = pgTable(
  "inbox_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    inboxId: uuid("inbox_id")
      .notNull()
      .references(() => inboxes.id, { onDelete: "cascade" }),
    type: inboxDraftTypeEnum("type").notNull(),
    // A forward held for approval: type reply, its target in reply_to_email_id.
    forward: boolean("forward").notNull().default(false),
    threadId: uuid("thread_id").references(() => inboxThreads.id, { onDelete: "cascade" }),
    // A received_emails.id or emails.id in thread_id, so no foreign key.
    replyToEmailId: uuid("reply_to_email_id"),
    to: jsonb("to").$type<string[]>(),
    cc: jsonb("cc").$type<string[]>().notNull().default([]),
    bcc: jsonb("bcc").$type<string[]>().notNull().default([]),
    subject: text("subject"),
    bodyCiphertext: bytea("body_ciphertext"),
    bodyIv: bytea("body_iv"),
    bodyWrappedDek: bytea("body_wrapped_dek"),
    bodyKeyVersion: integer("body_key_version"),
    bodyPurgedAt: timestamp("body_purged_at", { withTimezone: true }),
    status: inboxDraftStatusEnum("status").notNull().default("draft"),
    approvalReasons: text("approval_reasons").array().notNull().default([]),
    // Encoded actors (core encodeInboxActor).
    createdBy: text("created_by").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    emailId: uuid("email_id").references((): AnyPgColumn => emails.id, { onDelete: "set null" }),
    // Bumped by every update; a write that read an older version lost a race.
    version: integer("version").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("inbox_drafts_reply_pair", sql`(${t.threadId} is null) = (${t.replyToEmailId} is null)`),
    check("inbox_drafts_reply_thread", sql`(${t.type} = 'reply') = (${t.threadId} is not null)`),
    // Resend: one unsent reply draft per target email.
    uniqueIndex("inbox_drafts_reply_target_idx")
      .on(t.inboxId, t.replyToEmailId)
      .where(
        sql`${t.type} = 'reply' and ${t.forward} = false and ${t.status} in ('draft', 'pending_approval')`,
      ),
    index("inbox_drafts_unsent_idx")
      .on(t.inboxId, t.updatedAt, t.id)
      .where(sql`${t.status} in ('draft', 'pending_approval')`),
    index("inbox_drafts_pending_expiry_idx")
      .on(t.expiresAt)
      .where(sql`${t.status} = 'pending_approval'`),
    index("inbox_drafts_body_unpurged_idx").on(t.updatedAt).where(sql`${t.bodyPurgedAt} is null`),
    // The set-null foreign key fires on every email the metadata purge deletes.
    index("inbox_drafts_email_idx").on(t.emailId).where(sql`${t.emailId} is not null`),
  ],
);

/** Per inbox and UTC day: what flood limits, send caps, the ramp and the judge cap count. */
export const inboxUsageDaily = pgTable(
  "inbox_usage_daily",
  {
    inboxId: uuid("inbox_id")
      .notNull()
      .references(() => inboxes.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    received: integer("received").notNull().default(0),
    recipients: integer("recipients").notNull().default(0),
    newRecipients: integer("new_recipients").notNull().default(0),
    judged: integer("judged").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.inboxId, t.day] }),
    index("inbox_usage_daily_day_idx").on(t.day),
  ],
);

/** Addresses an inbox has heard from or written to: the known recipient class and the loop guard's burst window. */
export const inboxCorrespondents = pgTable(
  "inbox_correspondents",
  {
    inboxId: uuid("inbox_id")
      .notNull()
      .references(() => inboxes.id, { onDelete: "cascade" }),
    // Lowercase.
    address: text("address").notNull(),
    firstInAt: timestamp("first_in_at", { withTimezone: true }),
    firstOutAt: timestamp("first_out_at", { withTimezone: true }),
    lastOutAt: timestamp("last_out_at", { withTimezone: true }),
    burstStart: timestamp("burst_start", { withTimezone: true }),
    burstCount: integer("burst_count").notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.inboxId, t.address] }),
    index("inbox_correspondents_last_seen_idx").on(t.lastSeenAt),
  ],
);

/**
 * Keyed MACs of the codes, sign-in links and token-like values a team
 * received in the last day, so a send can tell it is passing one on. Never
 * the value itself: a 6-digit code has a million values, so a plain hash
 * would be reversible.
 */
export const receivedSecrets = pgTable(
  "received_secrets",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    mac: bytea("mac").notNull(),
    receivedEmailId: uuid("received_email_id")
      .notNull()
      .references(() => receivedEmails.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"code" | "link" | "token">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.mac, t.receivedEmailId] }),
    index("received_secrets_created_idx").on(t.createdAt),
  ],
);

/**
 * Every agent and person action on an inbox, decisions included. Its own
 * table because audit_log is append-only and never purged: per-message rows
 * age out on the metadata clock here.
 */
export const inboxActivity = pgTable(
  "inbox_activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // No foreign key: the trail outlives a deleted inbox until retention.
    inboxId: uuid("inbox_id").notNull(),
    // Encoded actor (core encodeInboxActor).
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    threadId: uuid("thread_id"),
    emailId: uuid("email_id"),
    draftId: uuid("draft_id"),
    // Reason codes only: never content, codes or addresses.
    decision: jsonb("decision").$type<{ result: string; reasons: string[] }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("inbox_activity_inbox_created_idx").on(t.inboxId, t.createdAt, t.id),
    // Creation rate limits count a team's inbox.created rows in the last hour.
    index("inbox_activity_team_action_idx").on(t.teamId, t.action, t.createdAt),
    index("inbox_activity_created_idx").on(t.createdAt),
  ],
);
