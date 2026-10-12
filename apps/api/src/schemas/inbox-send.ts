import { z } from "@hono/zod-openapi";

// Shapes only: the rules (addresses, subject lines, recipient counts, the
// draft PATCH merge) live in core, which the dashboard calls too.

const recipients = z
  .union([z.string(), z.array(z.string()).max(50)])
  .describe('An address or a list of them; "Name <address>" works too');

const note = {
  html: z.string().optional().describe("HTML body"),
  text: z.string().optional().describe("Plain-text body"),
};

const subject = z
  .string()
  .optional()
  .describe("1-2000 characters on one line; defaults to the thread subject with Re: or Fwd:");

const requiresApproval = z
  .boolean()
  .optional()
  .describe(
    "MillionSend extension: hold the email as a draft that a person approves (202 with the Draft)",
  );

export const inboxReplyRequestSchema = z
  .object({
    ...note,
    subject,
    cc: recipients.optional(),
    bcc: recipients.optional(),
    reply_all: z
      .boolean()
      .optional()
      .describe("Also copy the message's other recipients (cc), never its bcc"),
    requires_approval: requiresApproval,
  })
  .openapi("InboxReplyRequest");

export const inboxForwardRequestSchema = z
  .object({
    to: recipients,
    cc: recipients.optional(),
    bcc: recipients.optional(),
    ...note,
    subject,
    requires_approval: requiresApproval,
  })
  .openapi("InboxForwardRequest");

const answerFrom = {
  from: z
    .string()
    .optional()
    .describe(
      "Sender on a verified team domain; defaults to the inbox address the email reached, else the first address it was received for",
    ),
  inbox_id: z.uuid().optional().describe("The inbox to answer from, among those the email reached"),
};

export const receivingReplyRequestSchema = inboxReplyRequestSchema
  .extend(answerFrom)
  .openapi("ReceivedEmailReplyRequest");

export const receivingForwardRequestSchema = inboxForwardRequestSchema
  .extend({
    ...answerFrom,
    mode: z
      .enum(["inline", "attachment"])
      .optional()
      .describe(
        "inline (default) quotes the original under the note; attachment sends it as forwarded_message.eml",
      ),
  })
  .openapi("ReceivedEmailForwardRequest");

const draftFields = {
  to: recipients.nullable().optional(),
  cc: recipients.nullable().optional(),
  bcc: recipients.nullable().optional(),
  subject: z.string().nullable().optional(),
  html: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
};

export const createDraftRequestSchema = z
  .object({
    ...draftFields,
    thread_id: z.uuid().optional().describe("With reply_to_email_id: a reply draft in this thread"),
    reply_to_email_id: z.uuid().optional().describe("The email of the thread the draft answers"),
  })
  .openapi("CreateInboxDraftRequest");

export const updateDraftRequestSchema = z.object(draftFields).openapi("UpdateInboxDraftRequest");

const attachment = z.object({
  id: z.string(),
  filename: z.string().nullable(),
  size: z.number().nullable(),
});

export const sentEmailSchema = z
  .object({
    id: z.uuid(),
    direction: z.literal("outbound"),
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    bcc: z.array(z.string()),
    reply_to: z.array(z.string()),
    subject: z.string().nullable(),
    message_id: z.string().nullable().describe("Always null on a send"),
    html: z.string().nullable(),
    text: z.string().nullable(),
    attachments: z.array(attachment),
    read: z.boolean(),
    received_at: z.string(),
    status: z.string(),
    email_id: z.uuid(),
    thread_id: z.uuid().nullable(),
    inbox_id: z.uuid().nullable(),
  })
  .openapi("InboxSentEmail");

const draftStatus = z.enum(["draft", "pending_approval", "sent", "rejected", "expired"]);

export const draftSchema = z
  .object({
    object: z.literal("inbox_draft"),
    id: z.uuid(),
    type: z.enum(["standalone", "reply"]),
    to: z.array(z.string()).nullable(),
    cc: z.array(z.string()),
    bcc: z.array(z.string()),
    subject: z.string().nullable(),
    html: z.string().nullable(),
    text: z.string().nullable(),
    thread_id: z.uuid().nullable(),
    reply_to_email_id: z.uuid().nullable(),
    email_id: z.uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    status: draftStatus,
    approval_reasons: z.array(z.string()),
    forward: z.boolean(),
    decided_by: z.string().nullable(),
    decided_at: z.string().nullable(),
    expires_at: z.string().nullable(),
  })
  .openapi("InboxDraft");

export const listDraftsResponseSchema = z
  .object({
    object: z.literal("list"),
    has_more: z.boolean(),
    data: z.array(
      z.object({
        id: z.uuid(),
        type: z.enum(["standalone", "reply"]),
        to: z.array(z.string()).nullable(),
        cc: z.array(z.string()),
        bcc: z.array(z.string()),
        subject: z.string().nullable(),
        snippet: z.string().nullable(),
        thread_id: z.uuid().nullable(),
        reply_to_email_id: z.uuid().nullable(),
        updated_at: z.string(),
        status: draftStatus,
        approval_reasons: z.array(z.string()),
      }),
    ),
  })
  .openapi("ListInboxDraftsResponse");

export const sendDraftResponseSchema = z
  .object({
    object: z.literal("inbox_draft"),
    id: z.uuid(),
    thread_id: z.uuid().nullable(),
    email_id: z.uuid(),
  })
  .openapi("SendInboxDraftResponse");

export const deleteDraftResponseSchema = z
  .object({ object: z.literal("inbox_draft"), id: z.uuid(), deleted: z.literal(true) })
  .openapi("DeleteInboxDraftResponse");

export const receivingSendResponseSchema = z
  .object({
    object: z.literal("email"),
    id: z.uuid(),
    thread_id: z.uuid().nullable(),
    inbox_id: z.uuid().nullable(),
  })
  .openapi("ReceivedEmailSendResponse");
