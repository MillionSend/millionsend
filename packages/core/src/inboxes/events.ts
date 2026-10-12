import type { TeamWebhookEvent, WebhookEventType } from "../webhooks.js";
import type {
  DraftWire,
  InboundThreadEmailWire,
  InboxWire,
  OutboundThreadEmailWire,
  QuarantineReason,
  SenderTrust,
  ThreadEmailWire,
  ThreadFolder,
  ThreadLabelWire,
  ThreadSummaryWire,
} from "./types.js";

// The inbox.* webhook builders. Envelope and data follow Resend: data opens
// with source and inbox_id, keys that do not apply are left out (never
// null), and no email or draft carries html, text, codes or links. Objects
// are snapshots taken when the event happens.

export type InboxEventSource = "api" | "dashboard" | "system";

/** A thread email as webhooks carry it: no html, text or extracted text. */
export type EventEmailWire =
  | Omit<InboundThreadEmailWire, "html" | "text" | "extracted_text">
  | Omit<OutboundThreadEmailWire, "html" | "text">;

export type EventDraftWire = Omit<DraftWire, "html" | "text">;

export function eventEmail(email: ThreadEmailWire): EventEmailWire {
  if (email.direction === "inbound") {
    const { html, text, extracted_text, ...metadata } = email;
    return metadata;
  }
  const { html, text, ...metadata } = email;
  return metadata;
}

export function eventDraft(draft: DraftWire): EventDraftWire {
  const { html, text, ...metadata } = draft;
  return metadata;
}

function inboxEventOf(
  type: WebhookEventType,
  source: InboxEventSource,
  inboxId: string,
  data: Record<string, unknown>,
  occurredAt: Date | undefined,
): TeamWebhookEvent {
  return {
    type,
    occurredAt: occurredAt ?? new Date(),
    data: { source, inbox_id: inboxId, ...data },
    inboxIds: [inboxId],
  };
}

/** inbox.created, inbox.updated, or inbox.expired with the state before deletion (source system). */
export function inboxEvent(
  type: "inbox.created" | "inbox.updated" | "inbox.expired",
  p: { source: InboxEventSource; inbox: InboxWire; occurredAt?: Date | undefined },
): TeamWebhookEvent {
  return inboxEventOf(type, p.source, p.inbox.id, { inbox: p.inbox }, p.occurredAt);
}

export function inboxDeletedEvent(p: {
  source: InboxEventSource;
  inboxId: string;
  occurredAt?: Date | undefined;
}): TeamWebhookEvent {
  return inboxEventOf("inbox.deleted", p.source, p.inboxId, {}, p.occurredAt);
}

/**
 * inbox.thread.created (a thread's first delivered inbound or first outbound
 * message), inbox.email.received (every delivered or released inbound) and
 * inbox.email.sent (at accept). Resend always reports these as system.
 */
export function threadEmailEvent(
  type: "inbox.thread.created" | "inbox.email.received" | "inbox.email.sent",
  p: {
    inboxId: string;
    thread: ThreadSummaryWire;
    email: ThreadEmailWire;
    occurredAt?: Date | undefined;
  },
): TeamWebhookEvent {
  return inboxEventOf(
    type,
    "system",
    p.inboxId,
    { thread_id: p.thread.id, email_id: p.email.id, thread: p.thread, email: eventEmail(p.email) },
    p.occurredAt,
  );
}

export function threadFolderEvent(p: {
  source: InboxEventSource;
  inboxId: string;
  thread: ThreadSummaryWire;
  from: ThreadFolder;
  to: ThreadFolder;
  occurredAt?: Date | undefined;
}): TeamWebhookEvent {
  return inboxEventOf(
    "inbox.thread.folder.updated",
    p.source,
    p.inboxId,
    { from: p.from, to: p.to, thread_id: p.thread.id, thread: p.thread },
    p.occurredAt,
  );
}

/** One label per event, in exactly one of the two lists. */
export function threadLabelsEvent(
  p: {
    source: InboxEventSource;
    inboxId: string;
    thread: ThreadSummaryWire;
    occurredAt?: Date | undefined;
  } & ({ added: ThreadLabelWire } | { removed: ThreadLabelWire }),
): TeamWebhookEvent {
  return inboxEventOf(
    "inbox.thread.labels.updated",
    p.source,
    p.inboxId,
    {
      added: "added" in p ? [p.added] : [],
      removed: "removed" in p ? [p.removed] : [],
      thread_id: p.thread.id,
      thread: p.thread,
    },
    p.occurredAt,
  );
}

/** MillionSend's: a held message, metadata only. `from` is the bare address. */
export function emailQuarantinedEvent(p: {
  inboxId: string;
  threadId: string;
  emailId: string;
  reason: QuarantineReason;
  senderTrust: SenderTrust;
  from: string;
  subject: string | null;
  receivedAt: Date;
  occurredAt?: Date | undefined;
}): TeamWebhookEvent {
  return inboxEventOf(
    "inbox.email.quarantined",
    "system",
    p.inboxId,
    {
      thread_id: p.threadId,
      email_id: p.emailId,
      reason: p.reason,
      sender_trust: p.senderTrust,
      from: p.from,
      subject: p.subject,
      received_at: p.receivedAt.toISOString(),
    },
    p.occurredAt,
  );
}

/** thread_id and thread ride on reply drafts only. */
export function draftEvent(
  type: "inbox.draft.created" | "inbox.draft.updated",
  p: {
    source: InboxEventSource;
    inboxId: string;
    draft: DraftWire;
    thread: ThreadSummaryWire | null;
    occurredAt?: Date | undefined;
  },
): TeamWebhookEvent {
  return inboxEventOf(
    type,
    p.source,
    p.inboxId,
    {
      draft_id: p.draft.id,
      draft: eventDraft(p.draft),
      ...(p.thread ? { thread_id: p.thread.id, thread: p.thread } : {}),
    },
    p.occurredAt,
  );
}

/** Fires before the inbox.email.sent of the same send. */
export function draftSentEvent(p: {
  source: InboxEventSource;
  inboxId: string;
  draft: DraftWire;
  thread: ThreadSummaryWire;
  emailId: string;
  occurredAt?: Date | undefined;
}): TeamWebhookEvent {
  return inboxEventOf(
    "inbox.draft.sent",
    p.source,
    p.inboxId,
    {
      thread_id: p.thread.id,
      email_id: p.emailId,
      draft_id: p.draft.id,
      thread: p.thread,
      draft: eventDraft(p.draft),
    },
    p.occurredAt,
  );
}

/** Also a rejection and an expiry. No draft object, as at Resend. */
export function draftDeletedEvent(p: {
  source: InboxEventSource;
  inboxId: string;
  draftId: string;
  thread: ThreadSummaryWire | null;
  occurredAt?: Date | undefined;
}): TeamWebhookEvent {
  return inboxEventOf(
    "inbox.draft.deleted",
    p.source,
    p.inboxId,
    { draft_id: p.draftId, ...(p.thread ? { thread_id: p.thread.id, thread: p.thread } : {}) },
    p.occurredAt,
  );
}
