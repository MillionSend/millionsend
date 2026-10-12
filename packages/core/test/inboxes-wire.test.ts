import { describe, expect, it } from "vitest";
import {
  draftDeletedEvent,
  draftEvent,
  draftSentEvent,
  emailQuarantinedEvent,
  threadEmailEvent,
  threadFolderEvent,
  threadLabelsEvent,
} from "../src/inboxes/events.js";
import {
  draftListItemWire,
  draftWire,
  inboundThreadEmailWire,
  inboxListItemWire,
  inboxWire,
  labelWire,
  outboundThreadEmailWire,
  screeningWire,
  sentEmailWire,
  threadSummaryWire,
} from "../src/inboxes/wire.js";

const AT = new Date("2026-10-12T12:00:00.000Z");
const ids = {
  inbox: "11111111-1111-4111-8111-111111111111",
  domain: "22222222-2222-4222-8222-222222222222",
  shared: "33333333-3333-4333-8333-333333333333",
  thread: "44444444-4444-4444-8444-444444444444",
  email: "55555555-5555-4555-8555-555555555555",
  draft: "66666666-6666-4666-8666-666666666666",
  label: "77777777-7777-4777-8777-777777777777",
};

// Resend's field lists (Resend Inboxes SDK 6.32.1-preview-inboxes.6), then
// MillionSend's extension keys: a serializer drifting from either fails here.
const RESEND = {
  inbox: [
    "object",
    "id",
    "name",
    "email_address",
    "domain_id",
    "receiving_address",
    "from_name",
    "unread",
    "drafts",
    "last_received",
    "created_at",
  ],
  inboxListItem: ["id", "name", "email_address", "from_name", "unread", "last_received"],
  label: ["id", "name", "color", "created_at"],
  threadSummary: ["object", "id", "subject", "folder", "labels", "read"],
  threadEmail: [
    "id",
    "direction",
    "from",
    "to",
    "cc",
    "bcc",
    "reply_to",
    "subject",
    "message_id",
    "html",
    "text",
    "attachments",
    "read",
    "received_at",
  ],
  draft: [
    "object",
    "id",
    "type",
    "to",
    "cc",
    "bcc",
    "subject",
    "html",
    "text",
    "thread_id",
    "reply_to_email_id",
    "email_id",
    "created_at",
    "updated_at",
  ],
  draftListItem: [
    "id",
    "type",
    "to",
    "cc",
    "bcc",
    "subject",
    "snippet",
    "thread_id",
    "reply_to_email_id",
    "updated_at",
  ],
};

const keys = (o: object) => Object.keys(o).sort();
const counts = { unread: 2, drafts: 1, quarantined: 3, pendingApproval: 1, lastReceived: AT };
const inboxRow = {
  id: ids.inbox,
  kind: "agent" as const,
  name: "Signup bot",
  emailAddress: "signup-bot-7f3k@acme.agents.example",
  domainId: null,
  sharedDomainId: ids.shared,
  receivingAddress: null,
  fromName: "Acme",
  expiresAt: AT,
  createdAt: AT,
};
const membership = {
  verdict: "clean" as const,
  senderTrust: "external" as const,
  quarantineReason: null,
  reasons: [],
  injectionScore: 3,
  phishingScore: null,
  readAt: null,
};
const received = {
  id: ids.email,
  from: "ana@sender.example",
  fromName: "Ana Souza",
  to: ["signup-bot-7f3k@acme.agents.example"],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: "Confirm your email",
  messageId: "<abc@sender.example>",
  createdAt: AT,
  hiddenText: { chars: 10, preview_chars: 10, invisible_chars: 0, flags: [] },
  spamVerdict: "pass" as const,
  virusVerdict: null,
};
const outbound = {
  id: ids.email,
  from: "Acme <signup-bot-7f3k@acme.agents.example>",
  to: ["ana@sender.example"],
  cc: null,
  bcc: null,
  replyTo: null,
  subject: "Re: Confirm your email",
  sesMessageId: "0100018f-ses",
  latestStatus: "queued_quota" as const,
  createdAt: AT,
};
const content = { html: "<p>hi</p>", text: "hi", attachments: [] };
const draftRow = {
  id: ids.draft,
  type: "reply" as const,
  to: ["ana@sender.example"],
  cc: [],
  bcc: [],
  subject: "Re: Confirm your email",
  threadId: ids.thread,
  replyToEmailId: ids.email,
  updatedAt: AT,
  status: "pending_approval" as const,
  approvalReasons: ["ramp"],
  emailId: null,
  createdAt: AT,
  forward: false,
  decidedBy: null,
  decidedAt: null,
  expiresAt: AT,
};
const thread = threadSummaryWire(
  { id: ids.thread, subject: "", folder: "inbox" },
  { labels: [], read: false, quarantined: 0 },
);

describe("wire serializers", () => {
  it("Inbox: Resend's fields plus the extensions; a shared inbox reports its shared domain", () => {
    const wire = inboxWire(inboxRow, counts);
    expect(keys(wire)).toEqual(
      [...RESEND.inbox, "kind", "shared", "expires_at", "quarantined", "pending_approval"].sort(),
    );
    expect(wire).toMatchObject({
      object: "inbox",
      domain_id: ids.shared,
      shared: true,
      last_received: AT.toISOString(),
      pending_approval: 1,
    });
    const custom = inboxWire({ ...inboxRow, domainId: ids.domain }, counts);
    expect(custom).toMatchObject({ domain_id: ids.domain, shared: false });
    expect(() => inboxWire({ ...inboxRow, sharedDomainId: null }, counts)).toThrow();
  });

  it("InboxListItem, Label and ThreadSummary", () => {
    expect(keys(inboxListItemWire(inboxRow, counts))).toEqual(
      [...RESEND.inboxListItem, "kind", "shared", "expires_at"].sort(),
    );
    const label = labelWire({ id: ids.label, name: "Billing", color: "#AABBCC", createdAt: AT });
    expect(keys(label)).toEqual([...RESEND.label].sort());
    expect(keys(thread)).toEqual([...RESEND.threadSummary, "quarantined"].sort());
    // No subject is null on the wire.
    expect(thread.subject).toBeNull();
  });

  it("ThreadEmail, both directions, and SentEmail", () => {
    const inbound = inboundThreadEmailWire(received, membership, {
      ...content,
      extractedText: "hi",
    });
    expect(keys(inbound)).toEqual(
      [
        ...RESEND.threadEmail,
        "extracted_text",
        "screening",
        "spam_verdict",
        "virus_verdict",
      ].sort(),
    );
    expect(inbound).toMatchObject({
      from: "Ana Souza <ana@sender.example>",
      read: false,
      screening: { verdict: "clean", quarantine_reason: null, hidden_text_removed: false },
    });
    const out = outboundThreadEmailWire(outbound, content);
    expect(keys(out)).toEqual([...RESEND.threadEmail, "status"].sort());
    expect(out).toMatchObject({
      cc: [],
      reply_to: [],
      read: true,
      message_id: "<0100018f-ses@email.amazonses.com>",
      status: "queued",
    });
    const sent = sentEmailWire(outbound, content, { threadId: ids.thread, inboxId: ids.inbox });
    expect(keys(sent)).toEqual(
      [...RESEND.threadEmail, "status", "email_id", "thread_id", "inbox_id"].sort(),
    );
    expect(sent).toMatchObject({ email_id: ids.email, message_id: null, reply_to: [] });
  });

  it("Screening reports a reason only once held, and removed hidden text", () => {
    const held = screeningWire(
      { ...membership, verdict: "quarantined", quarantineReason: "injection" },
      { chars: 90, preview_chars: 10, invisible_chars: 0, flags: [] },
    );
    expect(held).toMatchObject({ quarantine_reason: "injection", hidden_text_removed: true });
    const stale = screeningWire({ ...membership, quarantineReason: "injection" }, null);
    expect(stale.quarantine_reason).toBeNull();
    expect(
      screeningWire(membership, { chars: 1, preview_chars: 1, invisible_chars: 2, flags: [] })
        .hidden_text_removed,
    ).toBe(true);
  });

  it("Draft and DraftListItem", () => {
    expect(keys(draftWire(draftRow, { html: null, text: "ok" }))).toEqual(
      [
        ...RESEND.draft,
        "status",
        "approval_reasons",
        "forward",
        "decided_by",
        "decided_at",
        "expires_at",
      ].sort(),
    );
    expect(keys(draftListItemWire(draftRow, "ok"))).toEqual(
      [...RESEND.draftListItem, "status", "approval_reasons"].sort(),
    );
  });
});

describe("inbox event builders", () => {
  const inbound = inboundThreadEmailWire(received, membership, {
    ...content,
    extractedText: "Your code is 482913",
  });
  const draft = draftWire(draftRow, { html: "<p>secret</p>", text: "secret" });

  it("carry no html, text or extracted text, and every Resend envelope key", () => {
    const events = [
      threadEmailEvent("inbox.thread.created", { inboxId: ids.inbox, thread, email: inbound }),
      threadEmailEvent("inbox.email.sent", {
        inboxId: ids.inbox,
        thread,
        email: outboundThreadEmailWire(outbound, content),
      }),
      draftEvent("inbox.draft.created", { source: "api", inboxId: ids.inbox, draft, thread }),
      draftSentEvent({ source: "api", inboxId: ids.inbox, draft, thread, emailId: ids.email }),
    ];
    for (const event of events) {
      const serialized = JSON.stringify({
        type: event.type,
        created_at: event.occurredAt,
        data: event.data,
      });
      expect(serialized).not.toMatch(/"(html|text|extracted_text)"/);
      expect(serialized).not.toContain("482913");
      expect(serialized).not.toContain("secret");
      expect(event.inboxIds).toEqual([ids.inbox]);
      expect(Object.keys(event.data).slice(0, 2)).toEqual(["source", "inbox_id"]);
    }
    expect(events[0]?.data).toMatchObject({
      source: "system",
      thread_id: ids.thread,
      email_id: ids.email,
    });
  });

  it("leave out keys that do not apply instead of sending null", () => {
    const standalone = draftDeletedEvent({
      source: "dashboard",
      inboxId: ids.inbox,
      draftId: ids.draft,
      thread: null,
    });
    expect(standalone.data).toEqual({
      source: "dashboard",
      inbox_id: ids.inbox,
      draft_id: ids.draft,
    });
    const labels = threadLabelsEvent({
      source: "api",
      inboxId: ids.inbox,
      thread,
      added: { id: ids.label, name: "Billing", color: "#AABBCC" },
    });
    expect(labels.data).toMatchObject({ added: [{ id: ids.label }], removed: [] });
    const moved = threadFolderEvent({
      source: "system",
      inboxId: ids.inbox,
      thread,
      from: "archive",
      to: "inbox",
    });
    expect(moved.data).toMatchObject({ from: "archive", to: "inbox", thread_id: ids.thread });
    const held = emailQuarantinedEvent({
      inboxId: ids.inbox,
      threadId: ids.thread,
      emailId: ids.email,
      reason: "not_allowlisted",
      senderTrust: "external",
      from: "ana@sender.example",
      subject: "Hi",
      receivedAt: AT,
    });
    expect(held.type).toBe("inbox.email.quarantined");
    expect(held.data).toMatchObject({ source: "system", reason: "not_allowlisted" });
  });
});
