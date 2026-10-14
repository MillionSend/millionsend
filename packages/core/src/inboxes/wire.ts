import type { schema } from "@millionsend/db";
import type { ReceivedHiddenText } from "@millionsend/db/schema";
import { formatMailbox } from "../sender-address.js";
import type {
  DraftListItemWire,
  DraftWire,
  InboundThreadEmailWire,
  InboxListItemWire,
  InboxWire,
  LabelWire,
  OutboundThreadEmailWire,
  ScreeningWire,
  SentEmailWire,
  ThreadEmailAttachmentWire,
  ThreadLabelWire,
  ThreadSummaryWire,
  WireLastEvent,
} from "./types.js";

// Row → wire serializers every surface (REST, tRPC, webhooks) shares, so
// one object reads the same everywhere.

type InboxRow = typeof schema.inboxes.$inferSelect;
type ThreadRow = typeof schema.inboxThreads.$inferSelect;
type LabelRow = typeof schema.inboxLabels.$inferSelect;
type MembershipRow = typeof schema.receivedEmailInboxes.$inferSelect;
type DraftRow = typeof schema.inboxDrafts.$inferSelect;
type ReceivedRow = typeof schema.receivedEmails.$inferSelect;
type EmailRow = typeof schema.emails.$inferSelect;

const iso = (at: Date | null): string | null => at?.toISOString() ?? null;

/** Stored '' (no subject) reads as null, as Resend's subject does. */
const subjectOf = (subject: string): string | null => (subject === "" ? null : subject);

/**
 * The Message-ID header of an SES send. SES's domain varies by region
 * (<id@<region>.amazonses.com>); this one is what the API has always
 * rendered, so threading matches a reply on the local part only.
 */
export function sesMessageIdHeader(sesMessageId: string): string {
  return sesMessageId.startsWith("<") ? sesMessageId : `<${sesMessageId}@email.amazonses.com>`;
}

export function wireLastEvent(status: EmailRow["latestStatus"]): WireLastEvent {
  return status === "queued_quota" ? "queued" : status;
}

/** Whether the read pipeline removed anything a person could not see. */
export function hiddenTextRemoved(hidden: ReceivedHiddenText | null): boolean {
  return hidden !== null && (hidden.chars - hidden.preview_chars > 0 || hidden.invisible_chars > 0);
}

export interface InboxCounts {
  /** Threads with an unread delivered message. */
  unread: number;
  /** Unsent drafts (draft and pending_approval). */
  drafts: number;
  quarantined: number;
  pendingApproval: number;
  /** The latest thread activity, or null without threads. */
  lastReceived: Date | null;
}

type InboxFields = Pick<
  InboxRow,
  | "id"
  | "kind"
  | "name"
  | "emailAddress"
  | "domainId"
  | "sharedDomainId"
  | "receivingAddress"
  | "fromName"
  | "expiresAt"
  | "createdAt"
>;

export function inboxWire(row: InboxFields, counts: InboxCounts): InboxWire {
  const domainId = row.domainId ?? row.sharedDomainId;
  if (domainId === null) throw new Error(`inbox ${row.id} has no domain`);
  return {
    object: "inbox",
    id: row.id,
    name: row.name,
    email_address: row.emailAddress,
    domain_id: domainId,
    receiving_address: row.receivingAddress,
    from_name: row.fromName,
    unread: counts.unread,
    drafts: counts.drafts,
    last_received: iso(counts.lastReceived),
    created_at: row.createdAt.toISOString(),
    kind: row.kind,
    shared: row.domainId === null,
    expires_at: iso(row.expiresAt),
    quarantined: counts.quarantined,
    pending_approval: counts.pendingApproval,
  };
}

export function inboxListItemWire(
  row: Pick<
    InboxRow,
    "id" | "kind" | "name" | "emailAddress" | "domainId" | "fromName" | "expiresAt"
  >,
  counts: Pick<InboxCounts, "unread" | "lastReceived">,
): InboxListItemWire {
  return {
    id: row.id,
    name: row.name,
    email_address: row.emailAddress,
    from_name: row.fromName,
    unread: counts.unread,
    last_received: iso(counts.lastReceived),
    kind: row.kind,
    shared: row.domainId === null,
    expires_at: iso(row.expiresAt),
  };
}

export function labelWire(row: Pick<LabelRow, "id" | "name" | "color" | "createdAt">): LabelWire {
  return { id: row.id, name: row.name, color: row.color, created_at: row.createdAt.toISOString() };
}

export function threadLabelWire(row: Pick<LabelRow, "id" | "name" | "color">): ThreadLabelWire {
  return { id: row.id, name: row.name, color: row.color };
}

export function threadSummaryWire(
  row: Pick<ThreadRow, "id" | "subject" | "folder">,
  p: { labels: ThreadLabelWire[]; read: boolean; quarantined: number },
): ThreadSummaryWire {
  return {
    object: "inbox_thread",
    id: row.id,
    subject: subjectOf(row.subject),
    folder: row.folder,
    labels: p.labels,
    read: p.read,
    quarantined: p.quarantined,
  };
}

export function screeningWire(
  m: Pick<
    MembershipRow,
    "verdict" | "senderTrust" | "quarantineReason" | "reasons" | "injectionScore" | "phishingScore"
  >,
  hidden: ReceivedHiddenText | null,
): ScreeningWire {
  return {
    verdict: m.verdict,
    sender_trust: m.senderTrust,
    quarantine_reason:
      m.verdict === "quarantined" || m.verdict === "released" ? m.quarantineReason : null,
    reasons: m.reasons,
    injection_score: m.injectionScore,
    phishing_score: m.phishingScore,
    hidden_text_removed: hiddenTextRemoved(hidden),
  };
}

/** The parts of a message read out of its content, which the caller opens. */
export interface MessageContent {
  html: string | null;
  text: string | null;
  attachments: ThreadEmailAttachmentWire[];
}

export function inboundThreadEmailWire(
  row: Pick<
    ReceivedRow,
    | "id"
    | "from"
    | "fromName"
    | "to"
    | "cc"
    | "bcc"
    | "replyTo"
    | "subject"
    | "messageId"
    | "createdAt"
    | "hiddenText"
    | "spamVerdict"
    | "virusVerdict"
  >,
  membership: Parameters<typeof screeningWire>[0] & Pick<MembershipRow, "readAt">,
  content: MessageContent & { extractedText: string | null },
): InboundThreadEmailWire {
  return {
    id: row.id,
    direction: "inbound",
    from: formatMailbox({ name: row.fromName, address: row.from }),
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    reply_to: row.replyTo,
    subject: subjectOf(row.subject),
    message_id: row.messageId,
    html: content.html,
    text: content.text,
    attachments: content.attachments,
    read: membership.readAt !== null,
    received_at: row.createdAt.toISOString(),
    extracted_text: content.extractedText,
    screening: screeningWire(membership, row.hiddenText),
    spam_verdict: row.spamVerdict,
    virus_verdict: row.virusVerdict,
  };
}

type OutboundFields = Pick<
  EmailRow,
  | "id"
  | "from"
  | "to"
  | "cc"
  | "bcc"
  | "replyTo"
  | "subject"
  | "sesMessageId"
  | "latestStatus"
  | "createdAt"
>;

export function outboundThreadEmailWire(
  row: OutboundFields,
  content: MessageContent,
): OutboundThreadEmailWire {
  return {
    id: row.id,
    direction: "outbound",
    from: row.from,
    to: row.to,
    cc: row.cc ?? [],
    bcc: row.bcc ?? [],
    reply_to: row.replyTo ?? [],
    subject: subjectOf(row.subject),
    message_id: row.sesMessageId ? sesMessageIdHeader(row.sesMessageId) : null,
    html: content.html,
    text: content.text,
    attachments: content.attachments,
    read: true,
    received_at: row.createdAt.toISOString(),
    status: wireLastEvent(row.latestStatus),
  };
}

export function sentEmailWire(
  row: OutboundFields,
  content: MessageContent,
  p: { threadId: string | null; inboxId: string | null },
): SentEmailWire {
  return {
    ...outboundThreadEmailWire(row, content),
    reply_to: [],
    message_id: null,
    email_id: row.id,
    thread_id: p.threadId,
    inbox_id: p.inboxId,
  };
}

type DraftFields = Pick<
  DraftRow,
  | "id"
  | "type"
  | "to"
  | "cc"
  | "bcc"
  | "subject"
  | "threadId"
  | "replyToEmailId"
  | "updatedAt"
  | "status"
  | "approvalReasons"
>;

export function draftWire(
  row: DraftFields &
    Pick<DraftRow, "emailId" | "createdAt" | "forward" | "decidedBy" | "decidedAt" | "expiresAt">,
  body: { html: string | null; text: string | null },
): DraftWire {
  return {
    object: "inbox_draft",
    id: row.id,
    type: row.type,
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    subject: row.subject,
    html: body.html,
    text: body.text,
    thread_id: row.threadId,
    reply_to_email_id: row.replyToEmailId,
    email_id: row.emailId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    status: row.status,
    approval_reasons: row.approvalReasons,
    forward: row.forward,
    decided_by: row.decidedBy,
    decided_at: iso(row.decidedAt),
    expires_at: iso(row.expiresAt),
  };
}

export function draftListItemWire(row: DraftFields, snippet: string | null): DraftListItemWire {
  return {
    id: row.id,
    type: row.type,
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    subject: row.subject,
    snippet,
    thread_id: row.threadId,
    reply_to_email_id: row.replyToEmailId,
    updated_at: row.updatedAt.toISOString(),
    status: row.status,
    approval_reasons: row.approvalReasons,
  };
}
