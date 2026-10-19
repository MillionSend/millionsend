import { schema } from "@millionsend/db";
import type { InboxSafety } from "./safety.js";

export const INBOX_NOT_FOUND_MESSAGE = "Inbox not found.";
export const CURSOR_NOT_FOUND_MESSAGE =
  "The pagination cursor references an object that does not exist. See https://resend.com/docs/api-reference/pagination for more information.";
export const EMAIL_QUARANTINED_MESSAGE =
  "This email is quarantined; a person can release it in the dashboard";
export const INBOX_KEY_SCOPE_MESSAGE = "This API key is restricted to one inbox";

export const INBOX_KINDS = schema.inboxKindEnum.enumValues;
export type InboxKind = (typeof INBOX_KINDS)[number];

export const THREAD_FOLDERS = schema.inboxThreadFolderEnum.enumValues;
export type ThreadFolder = (typeof THREAD_FOLDERS)[number];

/** Where a thread can be moved; sent is assigned, never chosen. */
export const MOVE_FOLDERS = [
  "inbox",
  "archive",
  "spam",
  "trash",
] as const satisfies readonly ThreadFolder[];
export type MoveFolder = (typeof MOVE_FOLDERS)[number];

export const SENDER_TRUSTS = schema.senderTrustEnum.enumValues;
export type SenderTrust = (typeof SENDER_TRUSTS)[number];

export const SCREENING_VERDICTS = schema.inboxScreeningVerdictEnum.enumValues;
export type ScreeningVerdict = (typeof SCREENING_VERDICTS)[number];

export const QUARANTINE_REASONS = schema.inboxQuarantineReasonEnum.enumValues;
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

export type DraftType = (typeof schema.inboxDraftTypeEnum.enumValues)[number];
export type DraftStatus = (typeof schema.inboxDraftStatusEnum.enumValues)[number];
export type SpamVerdict = (typeof schema.receivedSpamVerdictEnum.enumValues)[number];
export type VirusVerdict = (typeof schema.receivedVirusVerdictEnum.enumValues)[number];

/** Keyset paging as the list routes parse it: limit 1-100, after/before an item id. */
export interface ListQuery {
  limit?: number | undefined;
  after?: string | undefined;
  before?: string | undefined;
}

/** A refusal in the API's error shape; routes answer errorBody(status, name, message) with it. */
export interface InboxError {
  status: 403 | 404 | 409 | 422 | 429 | 503;
  name: string;
  message: string;
  retryAfterSec?: number | undefined;
}

// Wire objects: Resend's fields first, MillionSend's extension keys after.
// Extensions are extra keys only, never new values in a Resend enum.

export interface InboxWire {
  object: "inbox";
  id: string;
  name: string;
  email_address: string;
  /** A shared inbox's is its team's shared subdomain: the GET /domains row with shared: true. */
  domain_id: string;
  receiving_address: string | null;
  from_name: string | null;
  unread: number;
  drafts: number;
  last_received: string | null;
  created_at: string;
  kind: InboxKind;
  shared: boolean;
  expires_at: string | null;
  /** Held memberships not yet released. */
  quarantined: number;
  pending_approval: number;
}

export interface InboxListItemWire {
  id: string;
  name: string | null;
  email_address: string;
  from_name: string | null;
  unread: number;
  last_received: string | null;
  kind: InboxKind;
  shared: boolean;
  expires_at: string | null;
}

export interface LabelWire {
  id: string;
  name: string;
  /** Uppercase #RRGGBB. */
  color: string;
  created_at: string;
}

export interface ThreadLabelWire {
  id: string;
  name: string;
  color: string;
}

export interface ThreadSummaryWire {
  object: "inbox_thread";
  id: string;
  subject: string | null;
  folder: ThreadFolder;
  labels: ThreadLabelWire[];
  read: boolean;
  /** Held messages in the thread; owner views only, 0 for agent views. */
  quarantined: number;
}

export interface ThreadListItemWire {
  id: string;
  subject: string | null;
  /** The latest delivered inbound sender ("Name <addr>"), or the inbox address for outbound-only threads. */
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  labels: ThreadLabelWire[];
  message_count: number;
  has_attachment: boolean;
  has_draft: boolean;
  read: boolean;
  /** Held messages not yet released; present only when held mail is listed. */
  quarantined?: number;
  /** The thread's last_message_at. */
  received_at: string;
  folder: ThreadFolder;
}

/** Search covers metadata only, so highlights never name body or attachments. */
export type ThreadSearchHighlightKey = "subject" | "from" | "to" | "cc" | "bcc";

export interface ThreadSearchResultWire extends ThreadListItemWire {
  matched_email_id: string | null;
  /** `**match**` markers around each hit; only the keys that matched. */
  highlights: Partial<Record<ThreadSearchHighlightKey, string[]>>;
}

export interface ScreeningWire {
  verdict: ScreeningVerdict;
  sender_trust: SenderTrust;
  /** Null unless quarantined or released. */
  quarantine_reason: QuarantineReason | null;
  /** The judge's reason keys. */
  reasons: string[];
  injection_score: number | null;
  phishing_score: number | null;
  hidden_text_removed: boolean;
}

export interface ThreadEmailAttachmentWire {
  /** A uuid on inbound mail; the position ("0", "1", …) on mail the inbox sent. */
  id: string;
  filename: string | null;
  size: number | null;
}

interface ThreadEmailFields {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  reply_to: string[];
  subject: string | null;
  message_id: string | null;
  html: string | null;
  /** Inbound: invisible characters removed (newline-preserving); html stays byte-for-byte. */
  text: string | null;
  attachments: ThreadEmailAttachmentWire[];
  read: boolean;
  received_at: string;
}

export interface InboundThreadEmailWire extends ThreadEmailFields {
  direction: "inbound";
  /** The sanitized read: hidden text stripped, quotes and signature cut. */
  extracted_text: string | null;
  screening: ScreeningWire;
  spam_verdict: SpamVerdict | null;
  virus_verdict: VirusVerdict | null;
}

/** Quota parking is internal: Resend's last_event union has no queued_quota. */
export type WireLastEvent = Exclude<
  (typeof schema.emailStatusEnum.enumValues)[number],
  "queued_quota"
>;

export interface OutboundThreadEmailWire extends ThreadEmailFields {
  direction: "outbound";
  /** The email's last_event. */
  status: WireLastEvent;
}

export type ThreadEmailWire = InboundThreadEmailWire | OutboundThreadEmailWire;

/** Reply and forward results: Resend fixes reply_to [], message_id null and read true. */
export interface SentEmailWire extends OutboundThreadEmailWire {
  email_id: string;
  /** Null for a reply to catch-all mail sent outside any inbox. */
  thread_id: string | null;
  inbox_id: string | null;
}

export interface DraftWire {
  object: "inbox_draft";
  id: string;
  type: DraftType;
  to: string[] | null;
  cc: string[];
  bcc: string[];
  subject: string | null;
  html: string | null;
  text: string | null;
  thread_id: string | null;
  reply_to_email_id: string | null;
  email_id: string | null;
  created_at: string;
  updated_at: string;
  status: DraftStatus;
  approval_reasons: string[];
  forward: boolean;
  decided_by: string | null;
  decided_at: string | null;
  expires_at: string | null;
}

export interface DraftListItemWire {
  id: string;
  type: DraftType;
  to: string[] | null;
  cc: string[];
  bcc: string[];
  subject: string | null;
  snippet: string | null;
  thread_id: string | null;
  reply_to_email_id: string | null;
  updated_at: string;
  status: DraftStatus;
  approval_reasons: string[];
}

export interface InboxSafetyWire extends InboxSafety {
  object: "inbox_safety";
  inbox_id: string;
}

export interface QuarantinedItemWire {
  /** The received email's id. */
  id: string;
  /** Null for a virus-held catch-all row, which belongs to no inbox. */
  thread_id: string | null;
  from: string;
  subject: string | null;
  received_at: string;
  quarantine_reason: QuarantineReason;
  sender_trust: SenderTrust;
  injection_score: number | null;
  phishing_score: number | null;
  virus_signature: string | null;
}

export interface InboxReleaseWire {
  object: "inbox_release";
  inbox_id: string;
  email_id: string;
  released_at: string;
  /** The address appended to the allowlist, or null. */
  trusted_sender: string | null;
}

export interface VerificationCodeWire {
  object: "verification_code";
  /** timeout only when the caller waited and nothing arrived; none otherwise. */
  status: "found" | "none" | "ambiguous" | "timeout";
  kind: "otp" | "link" | null;
  code: string | null;
  url: string | null;
  link_domain_matches_sender: boolean | null;
  email_id: string | null;
  from: string | null;
  received_at: string | null;
  sender_trust: SenderTrust | null;
}
