import { z } from "@hono/zod-openapi";
import {
  DAY_MS,
  formatMailbox,
  parseMailbox,
  parseScheduledAt,
  parseSingleSender,
  SCHEDULED_AT_FORMS,
  WEBHOOK_EVENT_TYPES,
} from "@millionsend/core";
import { SES_REGIONS } from "@millionsend/ses";

/**
 * Wire-compatible with Resend's documented /emails surface
 * (docs/resend-compatibility.md): field names, shapes, and error format must
 * not drift — the contract test runs the official `resend` SDK against us.
 */

/**
 * SECURITY: every recipient is a trust boundary too — suppression, opt-out
 * and quota checks all key off the parsed address, so an entry the MIME
 * builder would split into several mailboxes ('a@x.com, b@y.com <c@z.com>')
 * must be rejected outright. Stored in the canonical single-mailbox form.
 */
const emailAddress = z.string().transform((v, ctx) => {
  const mailbox = parseMailbox(v);
  if (!mailbox) {
    ctx.addIssue({ code: "custom", message: "must be a single valid email address" });
    return z.NEVER;
  }
  return formatMailbox(mailbox);
});

/**
 * SECURITY: `from` is a trust boundary — multi-mailbox or ambiguous input
 * (e.g. 'Acme <evil@a.test> <ok@b.test>') could pass domain verification for
 * one address yet be emitted as the other, so it must parse as exactly one
 * mailbox (parseSingleSender, the same parser verifySenderDomain uses).
 */
const fromAddress = z.string().refine((v) => parseSingleSender(v) !== null, {
  message: "from must be a single address",
});

// Shape first (string | string[]), addresses second, so a bad entry reports
// its own message instead of the union's generic "Invalid input".
const recipientList = z
  .union([z.string(), z.array(z.string()).min(1).max(50)])
  .transform((v) => (Array.isArray(v) ? v : [v]))
  .pipe(z.array(emailAddress));

/** SES rejects a message with more destinations than this, across to+cc+bcc. */
export const MAX_RECIPIENTS_PER_EMAIL = 50;

// Strict base64: canonical alphabet, correct padding, no whitespace.
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// RFC 7231 media type: type "/" subtype, optional ; token=token|"quoted" parameters.
const MEDIA_TYPE_TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const MEDIA_TYPE_RE = new RegExp(
  `^${MEDIA_TYPE_TOKEN}/${MEDIA_TYPE_TOKEN}(?:\\s*;\\s*${MEDIA_TYPE_TOKEN}=(?:${MEDIA_TYPE_TOKEN}|"[^"\\r\\n]*"))*$`,
);

/**
 * Wire shape from resend's parseEmailToApiOptions. Only inline base64
 * `content` is supported: a `path` URL would have the server fetch an
 * attacker-chosen location (SSRF), so it is rejected and never fetched.
 */
const attachmentSchema = z
  .object({
    filename: z.string().min(1),
    content: z.string().optional(),
    content_type: z.string().optional(),
    content_id: z.string().optional(),
    path: z.string().optional(),
  })
  .superRefine((a, ctx) => {
    if (hasHeaderControlChar(a.filename)) {
      ctx.addIssue({
        code: "custom",
        path: ["filename"],
        message: "filename must not contain control characters",
      });
    }
    if (a.content_type !== undefined && !MEDIA_TYPE_RE.test(a.content_type)) {
      ctx.addIssue({
        code: "custom",
        path: ["content_type"],
        message: "content_type must be a media type like application/pdf",
      });
    }
    if (a.path !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: "path attachments are not supported — inline the file as base64 content",
      });
      return;
    }
    if (a.content_id !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["content_id"],
        message: "content_id (inline attachments) is not supported",
      });
      return;
    }
    if (!a.content) {
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message: "content is required (base64-encoded file bytes)",
      });
      return;
    }
    if (!BASE64_RE.test(a.content)) {
      ctx.addIssue({ code: "custom", path: ["content"], message: "content must be valid base64" });
    }
  });

/**
 * Custom headers are allowlisted, not denylisted: mail leaves through a
 * shared SES identity, so a tenant must not be able to forge authentication
 * verdicts (Authentication-Results, ARC-*, Received-SPF), alternate senders
 * (Resent-*, Sender, Return-Path), read-receipt targets
 * (Disposition-Notification-To, Return-Receipt-To, Errors-To) or list
 * headers the transport owns. Allowed: any X-* header except the X-SES-* and
 * X-MillionSend-* families, plus this vetted set of threading/priority
 * headers. Matched case-insensitively; the worker still reassigns its own
 * headers last (defense in depth).
 */
const ALLOWED_HEADERS = new Set([
  "in-reply-to",
  "references",
  "importance",
  "priority",
  "comments",
  "keywords",
  "organization",
]);

const ALLOWED_HEADERS_HINT = `X-* (except X-SES-*) or ${[...ALLOWED_HEADERS].join(", ")}`;

function isAllowedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith("x-")) {
    return !lower.startsWith("x-ses-") && !lower.startsWith("x-millionsend-");
  }
  return ALLOWED_HEADERS.has(lower);
}

// RFC 5322 field name: printable US-ASCII except colon.
const HEADER_NAME_RE = /^[!-9;-~]+$/;

/** True when the value carries a control char that could smuggle a header. */
function hasHeaderControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}

const customHeadersSchema = z.record(z.string(), z.string()).superRefine((headers, ctx) => {
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME_RE.test(name)) {
      ctx.addIssue({
        code: "custom",
        path: [name],
        message: `"${name}" is not a valid header name`,
      });
    } else if (!isAllowedHeaderName(name)) {
      ctx.addIssue({
        code: "custom",
        path: [name],
        message: `"${name}" is not an allowed header; use ${ALLOWED_HEADERS_HINT}`,
      });
    }
    if (hasHeaderControlChar(value)) {
      ctx.addIssue({
        code: "custom",
        path: [name],
        message: `"${name}" value must not contain control characters`,
      });
    }
  }
});

/**
 * ISO 8601 with offset, or Resend's relative forms ("in 5 mins"). Validated
 * here but kept as the raw string: idempotency hashes the body, and a
 * relative form must hash identically across retries — handlers re-resolve
 * it via parseScheduledAt.
 */
const scheduledAtSchema = z.string().superRefine((v, ctx) => {
  const at = parseScheduledAt(v);
  if (!at) {
    ctx.addIssue({ code: "custom", message: `scheduled_at must be ${SCHEDULED_AT_FORMS}` });
    return;
  }
  // Capped at 30 days ahead (Resend's own limit). Also keeps a scheduled
  // send from outliving the default body-retention window.
  if (at.getTime() > Date.now() + 30 * DAY_MS) {
    ctx.addIssue({
      code: "custom",
      message: "scheduled_at cannot be more than 30 days in the future",
    });
  }
});

export const sendEmailRequestSchema = z
  .object({
    from: fromAddress
      .describe(
        'Sender, "Name <user@domain>" or bare address; the domain must be verified for the team',
      )
      .openapi({ example: "Acme <onboarding@acme.dev>" }),
    to: recipientList
      .describe("Recipient address or list of up to 50")
      .openapi({ example: ["delivered@resend.dev"] }),
    subject: z
      .string()
      .min(1)
      .refine((v) => !hasHeaderControlChar(v), {
        message: "subject must not contain control characters",
      })
      .describe("Subject line"),
    html: z.string().optional().describe("HTML body; at least one of html/text is required"),
    text: z.string().optional().describe("Plain-text body; at least one of html/text is required"),
    cc: recipientList.optional().describe("Cc address or list"),
    bcc: recipientList.optional().describe("Bcc address or list"),
    reply_to: recipientList.optional().describe("Reply-To address or list"),
    scheduled_at: scheduledAtSchema
      .optional()
      .describe(
        `Deliver later: ISO 8601 with offset, or relative like "in 2 hours" (${SCHEDULED_AT_FORMS}); max 30 days ahead`,
      ),
    tags: z
      .array(z.object({ name: z.string().min(1), value: z.string() }))
      .optional()
      .describe("Key/value labels attached to the email for filtering"),
    // Topic-scoped send: recipients opted out of the topic (explicit
    // subscription row, else the topic's default) are dropped at accept
    // exactly like suppression-list hits.
    topic_id: z
      .uuid()
      .nullable()
      .optional()
      .describe(
        "Topic id: recipients opted out of the topic are skipped and an unsubscribe link is added",
      ),
    attachments: z
      .array(attachmentSchema)
      .optional()
      .describe("Attachments with base64 content (no remote paths)"),
    headers: customHeadersSchema
      .optional()
      .describe("Extra message headers (transport headers are rejected)"),
  })
  .refine((v) => v.html !== undefined || v.text !== undefined, {
    message: "Either html or text must be provided",
  })
  .refine(
    (v) => v.to.length + (v.cc?.length ?? 0) + (v.bcc?.length ?? 0) <= MAX_RECIPIENTS_PER_EMAIL,
    { message: `to, cc and bcc together cannot exceed ${MAX_RECIPIENTS_PER_EMAIL} recipients` },
  )
  .openapi("SendEmailRequest");

export type SendEmailRequest = z.infer<typeof sendEmailRequestSchema>;

export const sendEmailResponseSchema = z.object({ id: z.uuid() }).openapi("SendEmailResponse");

/**
 * Batch send (resend.batch.send → POST /emails/batch). The SDK posts a bare
 * array of email options, capped at Resend's 100-email limit — an over-cap
 * array is a 422. Items are deliberately untyped here: the handler validates
 * each against sendEmailRequestSchema itself (so batch items carry
 * attachments/headers too — Resend omits attachments only at the type
 * level), because the x-batch-validation header decides whether one invalid
 * item fails the whole batch (strict, the default) or becomes a per-index
 * error while the valid subset is accepted (permissive).
 */
export const batchEmailRequestSchema = z
  .array(z.unknown())
  .min(1)
  .max(100)
  .openapi("BatchEmailRequest");

export const batchEmailResponseSchema = z
  .object({
    data: z.array(z.object({ id: z.uuid() })),
    // Present only in permissive mode: per-item failures by input index.
    errors: z.array(z.object({ index: z.number().int(), message: z.string() })).optional(),
  })
  .openapi("BatchEmailResponse");

export const cancelEmailResponseSchema = z
  .object({ object: z.literal("email"), id: z.uuid() })
  .openapi("CancelEmailResponse");

// PATCH /emails/{id} (resend.emails.update): reschedule a not-yet-sent
// scheduled email.
export const updateEmailRequestSchema = z
  .object({ scheduled_at: scheduledAtSchema })
  .openapi("UpdateEmailRequest");

export const updateEmailResponseSchema = z
  .object({ object: z.literal("email"), id: z.uuid() })
  .openapi("UpdateEmailResponse");

export const removeEmailResponseSchema = z
  .object({ object: z.literal("email"), id: z.uuid(), deleted: z.literal(true) })
  .openapi("RemoveEmailResponse");

const emailListItemSchema = z.object({
  id: z.uuid(),
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()).nullable(),
  bcc: z.array(z.string()).nullable(),
  reply_to: z.array(z.string()).nullable(),
  subject: z.string(),
  created_at: z.string(),
  scheduled_at: z.string().nullable(),
  last_event: z.string(),
});

export const listEmailsResponseSchema = z
  .object({ object: z.literal("list"), data: z.array(emailListItemSchema), has_more: z.boolean() })
  .openapi("ListEmailsResponse");

export const getEmailResponseSchema = emailListItemSchema
  .extend({
    object: z.literal("email"),
    html: z.string().nullable(),
    text: z.string().nullable(),
    // RFC 5322 Message-ID ('<id@host>'); a placeholder until the send records
    // the provider message id.
    message_id: z.string(),
  })
  .openapi("GetEmailResponse");

/**
 * Resend SDK pagination (buildPaginationQuery): ?limit=&after= / ?before=,
 * limit 1-100 (default 20), cursors are item ids, after and before are
 * mutually exclusive.
 */
export const listQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Page size, 1-100 (default 20)"),
    after: z.uuid().optional().describe("Cursor: id of the last item of the previous page"),
    before: z
      .uuid()
      .optional()
      .describe("Cursor: id of the first item of the next page (page backwards)"),
  })
  .refine((q) => !(q.after && q.before), {
    message: "after and before cannot be used together",
  });

export type ListQuery = z.infer<typeof listQuerySchema>;

export const errorSchema = z
  .object({
    statusCode: z.number(),
    name: z.string(),
    message: z.string(),
  })
  .openapi("ErrorResponse");

/**
 * Contacts are team-global (one row per (team, lower(email))); the resend SDK
 * (v6+) reaches this surface through the top-level /contacts paths.
 */

const subscriptionEnum = z.enum(["opt_in", "opt_out"]);

export const createContactRequestSchema = z
  .object({
    // Bare addr-spec only — a contact record is an address, not a mailbox
    // with display name.
    email: z.email().describe("Bare email address (no display name); unique per team"),
    first_name: z.string().optional().describe("First name"),
    last_name: z.string().optional().describe("Last name"),
    unsubscribed: z.boolean().optional().describe("Global opt-out from all marketing sends"),
    // Kept as unknown values so the handler can coerce scalars to strings and
    // reject nested objects/arrays with a precise 422 message.
    properties: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Flat map of custom properties (string or number values)"),
    // Initial associations, written in the same transaction as the contact.
    segments: z
      .array(z.object({ id: z.uuid() }))
      .optional()
      .describe("Segments to add the contact to on creation"),
    topics: z
      .array(z.object({ id: z.uuid(), subscription: subscriptionEnum }))
      .optional()
      .describe("Initial per-topic subscription choices"),
  })
  .openapi("CreateContactRequest");

export type CreateContactRequest = z.infer<typeof createContactRequestSchema>;

export const updateContactRequestSchema = z
  .object({
    first_name: z.string().nullable().optional().describe("First name; null clears it"),
    last_name: z.string().nullable().optional().describe("Last name; null clears it"),
    unsubscribed: z.boolean().optional().describe("Global opt-out from all marketing sends"),
    // Kept as unknown values so the handler can coerce scalars to strings and
    // reject nested objects/arrays with a precise 422 message.
    properties: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Custom properties to set (merged); null removes a key"),
  })
  .openapi("UpdateContactRequest");

export const contactIdResponseSchema = z
  .object({ object: z.literal("contact"), id: z.uuid() })
  .openapi("ContactIdResponse");

const contactSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  created_at: z.string(),
  unsubscribed: z.boolean(),
});

// The SDK's GetContactResponseSuccess types each property as a {type, value}
// wrapper (ContactPropertyValue): number for keys registered as 'number' in
// the team's property definitions, string otherwise.
const contactPropertyValueSchema = z.union([
  z.object({ type: z.literal("string"), value: z.string() }),
  z.object({ type: z.literal("number"), value: z.number() }),
]);

export const getContactResponseSchema = contactSchema
  .extend({
    object: z.literal("contact"),
    properties: z.record(z.string(), contactPropertyValueSchema),
  })
  .openapi("GetContactResponse");

export const listContactsResponseSchema = z
  .object({ object: z.literal("list"), data: z.array(contactSchema), has_more: z.boolean() })
  .openapi("ListContactsResponse");

export const removeContactResponseSchema = z
  .object({ object: z.literal("contact"), contact: z.uuid(), deleted: z.literal(true) })
  .openapi("RemoveContactResponse");

// contacts.segments.add/remove (SDK AddContactSegmentResponseSuccess /
// RemoveContactSegmentResponseSuccess): id is the contact, audienceId the
// segment (audiences are a pure alias of segments in resend v6).
export const addContactSegmentResponseSchema = z
  .object({ id: z.uuid() })
  .openapi("AddContactSegmentResponse");

export const removeContactSegmentResponseSchema = z
  .object({ id: z.uuid(), audienceId: z.uuid(), deleted: z.literal(true) })
  .openapi("RemoveContactSegmentResponse");

/**
 * Contact properties (/contact-properties): typed definitions layered over
 * the free-form contacts.properties map. Wire entity is ApiContactProperty:
 * snake_case, fallback_value typed per `type`.
 */

const contactPropertyTypeSchema = z.enum(["string", "number"]);

// fallback_value is cross-validated against `type` in the handler (a number
// property only accepts values that parse to a finite number).
export const createContactPropertyRequestSchema = z
  .object({
    key: z.string().trim().min(1).max(200),
    type: contactPropertyTypeSchema,
    fallback_value: z
      .union([z.string().max(1000), z.number()])
      .nullable()
      .optional(),
  })
  .openapi("CreateContactPropertyRequest");

// Only fallback_value is updatable — the SDK never sends key/type on update.
export const updateContactPropertyRequestSchema = z
  .object({
    fallback_value: z
      .union([z.string().max(1000), z.number()])
      .nullable()
      .optional(),
  })
  .openapi("UpdateContactPropertyRequest");

const contactPropertyWireSchema = z.object({
  id: z.uuid(),
  created_at: z.string(),
  key: z.string(),
  type: contactPropertyTypeSchema,
  fallback_value: z.union([z.string(), z.number()]).nullable(),
});

export const contactPropertyIdResponseSchema = z
  .object({ object: z.literal("contact_property"), id: z.uuid() })
  .openapi("ContactPropertyIdResponse");

export const getContactPropertyResponseSchema = contactPropertyWireSchema
  .extend({ object: z.literal("contact_property") })
  .openapi("GetContactPropertyResponse");

export const listContactPropertiesResponseSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(contactPropertyWireSchema),
    has_more: z.boolean(),
  })
  .openapi("ListContactPropertiesResponse");

export const removeContactPropertyResponseSchema = z
  .object({ object: z.literal("contact_property"), id: z.uuid(), deleted: z.literal(true) })
  .openapi("RemoveContactPropertyResponse");

/**
 * Broadcasts. Targeting is an optional segment_id and/or topic_id; neither
 * set means every contact of the team.
 */

const replyToList = recipientList;

export const createBroadcastRequestSchema = z
  .object({
    name: z.string().optional().describe("Internal name shown in the dashboard"),
    segment_id: z
      .uuid()
      .optional()
      .describe("Segment to send to; omitted means every contact of the team"),
    from: fromAddress.describe(
      'Sender, "Name <user@domain>"; the domain must be verified for the team',
    ),
    subject: z
      .string()
      .min(1)
      .describe("Subject line; supports {{{FIRST_NAME|there}}} merge fields"),
    html: z
      .string()
      .optional()
      .describe("HTML body; include {{{UNSUBSCRIBE_URL}}} for the opt-out link"),
    text: z.string().optional().describe("Plain-text body; at least one of html/text is required"),
    reply_to: replyToList.optional().describe("Reply-To address or list"),
    preview_text: z.string().optional().describe("Inbox preview (preheader) text"),
    topic_id: z
      .uuid()
      .nullable()
      .optional()
      .describe("Topic id; only contacts subscribed to it receive the broadcast"),
    send: z
      .boolean()
      .optional()
      .describe("true sends (or schedules) immediately instead of saving a draft"),
    scheduled_at: scheduledAtSchema
      .optional()
      .describe(
        'Deliver later (requires send: true): ISO 8601 with offset or relative like "in 1 hour"',
      ),
  })
  .refine((v) => v.html !== undefined || v.text !== undefined, {
    message: "Either html or text must be provided",
  })
  // Mirrors the SDK's type-level constraint: a schedule only makes sense on a
  // create that also sends.
  .refine((v) => v.scheduled_at === undefined || v.send === true, {
    message: "scheduled_at requires send: true",
  })
  .openapi("CreateBroadcastRequest");

export const updateBroadcastRequestSchema = z
  .object({
    name: z.string().optional(),
    segment_id: z.uuid().optional(),
    from: fromAddress.optional(),
    subject: z.string().min(1).optional(),
    html: z.string().optional(),
    text: z.string().optional(),
    reply_to: replyToList.optional(),
    preview_text: z.string().optional(),
    topic_id: z.uuid().nullable().optional(),
  })
  .openapi("UpdateBroadcastRequest");

export const sendBroadcastRequestSchema = z
  .object({
    scheduled_at: scheduledAtSchema
      .optional()
      .describe(
        'Deliver later: ISO 8601 with offset or relative like "in 1 hour"; omitted sends now',
      ),
  })
  .openapi("SendBroadcastRequest");

export const broadcastIdResponseSchema = z.object({ id: z.uuid() }).openapi("BroadcastIdResponse");

const broadcastListItemSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  segment_id: z.uuid().nullable(),
  status: z.string(),
  created_at: z.string(),
  scheduled_at: z.string().nullable(),
  sent_at: z.string().nullable(),
});

export const listBroadcastsResponseSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(broadcastListItemSchema),
    has_more: z.boolean(),
  })
  .openapi("ListBroadcastsResponse");

export const getBroadcastResponseSchema = broadcastListItemSchema
  .extend({
    object: z.literal("broadcast"),
    from: z.string(),
    subject: z.string(),
    reply_to: z.array(z.string()).nullable(),
    preview_text: z.string().nullable(),
    topic_id: z.uuid().nullable(),
    html: z.string().nullable(),
    text: z.string().nullable(),
  })
  .openapi("GetBroadcastResponse");

export const removeBroadcastResponseSchema = z
  .object({ object: z.literal("broadcast"), id: z.uuid(), deleted: z.literal(true) })
  .openapi("RemoveBroadcastResponse");

export const cancelBroadcastResponseSchema = z
  .object({ object: z.literal("broadcast"), id: z.uuid() })
  .openapi("CancelBroadcastResponse");

/**
 * Segments (MillionSend extension, docs/resend-compatibility.md). A segment
 * is a saved filter over the team's contacts. The filter's field/operator
 * semantics are validated by @millionsend/core's `segmentFilterSchema` in the
 * handler (422 on a bad shape); this schema only pins the wire structure for
 * OpenAPI and basic type checks.
 */
const segmentFilterInputSchema = z
  .object({
    match: z.enum(["all", "any"]),
    conditions: z.array(
      z.object({
        field: z.string(),
        op: z.string(),
        // Present but nullable; presence ops (is_set/is_not_set) send null.
        value: z.string().nullable(),
      }),
    ),
  })
  .openapi("SegmentFilter");

export const createSegmentRequestSchema = z
  .object({
    name: z.string().min(1),
    // Omitted = manual segment: membership comes only from segment_members
    // rows (contacts.segments.add / contacts.create segments).
    filter: segmentFilterInputSchema.optional(),
  })
  .openapi("CreateSegmentRequest");

export const updateSegmentRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    // null clears the filter, turning the segment manual-membership-only.
    filter: segmentFilterInputSchema.nullable().optional(),
  })
  .openapi("UpdateSegmentRequest");

const segmentBaseSchema = z.object({
  object: z.literal("segment"),
  id: z.uuid(),
  name: z.string(),
  // Null = manual-membership-only segment (no saved filter).
  filter: segmentFilterInputSchema.nullable(),
  created_at: z.string(),
});

export const segmentResponseSchema = segmentBaseSchema.openapi("SegmentResponse");

// GET carries the live count of matching contacts (the translator's live-count
// consumer); list omits it to stay one query per page.
export const getSegmentResponseSchema = segmentBaseSchema
  .extend({ contact_count: z.number() })
  .openapi("GetSegmentResponse");

export const listSegmentsResponseSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(segmentBaseSchema),
    has_more: z.boolean(),
  })
  .openapi("ListSegmentsResponse");

export const removeSegmentResponseSchema = z
  .object({ object: z.literal("segment"), id: z.uuid(), deleted: z.literal(true) })
  .openapi("RemoveSegmentResponse");

/**
 * Topics. Wire-compatible with the resend SDK's `topics` and
 * `contacts.topics` surfaces: default_subscription is 'opt_in'/'opt_out'
 * (opt_in = subscribed unless the contact opts out) and is fixed at creation.
 * `visibility` is a superset field absent from the SDK's types: private
 * topics show on the unsubscribe page only via their own topic link, public
 * topics always show there.
 */

const topicVisibilityEnum = z.enum(["private", "public"]);

export const createTopicRequestSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    default_subscription: subscriptionEnum,
    visibility: topicVisibilityEnum.optional(),
  })
  .openapi("CreateTopicRequest");

export const topicIdResponseSchema = z.object({ id: z.uuid() }).openapi("TopicIdResponse");

// PATCH /topics/{id}: the SDK posts its whole payload, leaking `id` into the
// body — non-strict parsing drops it. default_subscription is immutable and
// absent from the SDK's update surface, so it is not accepted here either
// (an unknown key, silently dropped).
export const updateTopicRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    visibility: topicVisibilityEnum.optional(),
  })
  .openapi("UpdateTopicRequest");

const topicSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().optional(),
  default_subscription: subscriptionEnum,
  visibility: topicVisibilityEnum,
  created_at: z.string(),
});

export const topicResponseSchema = topicSchema.openapi("TopicResponse");

// The SDK's ListTopicsResponseSuccess types a bare { data: Topic[] };
// object/has_more ride along additively so every list shares one envelope
// (topics are never paginated — has_more is always false).
export const listTopicsResponseSchema = z
  .object({ object: z.literal("list"), data: z.array(topicSchema), has_more: z.literal(false) })
  .openapi("ListTopicsResponse");

export const removeTopicResponseSchema = z
  .object({ id: z.uuid(), object: z.literal("topic"), deleted: z.literal(true) })
  .openapi("RemoveTopicResponse");

/**
 * Domains — wire-compatible with the resend SDK's domains surface.
 * `custom_return_path` is the MAIL FROM subdomain (Resend's name for it).
 */

// Lowercase registrable hostname / single DNS label. Mirrors
// apps/web/src/server/routers/domains.ts — restated because that module is
// app-private; SES identities are registered exactly as typed, so uppercase
// is rejected instead of normalized.
const HOSTNAME_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const createDomainRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .refine((v) => HOSTNAME_RE.test(v), "must be a lowercase hostname"),
    region: z.enum(SES_REGIONS).optional(),
    custom_return_path: z
      .string()
      .trim()
      .refine((v) => SUBDOMAIN_RE.test(v), "must be a lowercase DNS label")
      .default("send"),
  })
  .openapi("CreateDomainRequest");

export const updateDomainRequestSchema = z
  .object({
    click_tracking: z.boolean().optional(),
    open_tracking: z.boolean().optional(),
    // Empty string or null clears the branded tracking subdomain.
    tracking_subdomain: z
      .string()
      .trim()
      .refine((v) => v === "" || SUBDOMAIN_RE.test(v), "must be a lowercase DNS label")
      .nullable()
      .optional(),
    // Accepted by the SDK but unsupported here; the handler answers 422
    // instead of silently ignoring a security-relevant setting.
    tls: z.unknown().optional(),
    capabilities: z.unknown().optional(),
  })
  .openapi("UpdateDomainRequest");

const domainRecordSchema = z.object({
  record: z.string(),
  name: z.string(),
  type: z.string(),
  ttl: z.string(),
  status: z.string(),
  value: z.string(),
  priority: z.number().optional(),
});

const domainSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.string(),
  created_at: z.string(),
  region: z.string(),
  open_tracking: z.boolean(),
  click_tracking: z.boolean(),
  tracking_subdomain: z.string().nullable(),
  // Sending-only platform; present for SDK-shape parity.
  capabilities: z.object({ sending: z.string(), receiving: z.string() }),
});

export const createDomainResponseSchema = domainSchema
  .extend({ records: z.array(domainRecordSchema) })
  .openapi("CreateDomainResponse");

export const getDomainResponseSchema = domainSchema
  .extend({ object: z.literal("domain"), records: z.array(domainRecordSchema) })
  .openapi("GetDomainResponse");

export const listDomainsResponseSchema = z
  .object({ object: z.literal("list"), data: z.array(domainSchema), has_more: z.boolean() })
  .openapi("ListDomainsResponse");

export const domainIdResponseSchema = z
  .object({ object: z.literal("domain"), id: z.uuid() })
  .openapi("DomainIdResponse");

export const removeDomainResponseSchema = z
  .object({ object: z.literal("domain"), id: z.uuid(), deleted: z.literal(true) })
  .openapi("RemoveDomainResponse");

/**
 * Webhooks — wire-compatible with the resend SDK's webhooks surface: the
 * endpoint URL field is `endpoint` (stored as webhook_endpoints.url), the
 * signing secret is `signing_secret` (returned on create and get, never in
 * list rows), and status only speaks enabled/disabled.
 */

// The SDK's WebhookEvent union is wider (contact.*, domain.*, …); only events
// this platform actually emits are accepted — anything else is a loud 422
// instead of a subscription that never fires.
const webhookEventSchema = z.enum(WEBHOOK_EVENT_TYPES);

const webhookWireStatusSchema = z.enum(["enabled", "disabled"]);

// https-only, mirroring the dashboard: a webhook target receives signed
// customer event data and must not travel plaintext.
const webhookEndpointUrl = z
  .url()
  .max(2048)
  .refine((value) => new URL(value).protocol === "https:", {
    message: "endpoint must be an https:// URL",
  });

export const createWebhookRequestSchema = z
  .object({
    endpoint: webhookEndpointUrl,
    events: z.array(webhookEventSchema).min(1),
  })
  .openapi("CreateWebhookRequest");

export const updateWebhookRequestSchema = z
  .object({
    endpoint: webhookEndpointUrl.optional(),
    events: z.array(webhookEventSchema).min(1).optional(),
    status: webhookWireStatusSchema.optional(),
  })
  .openapi("UpdateWebhookRequest");

// events is nullable on the wire: null = subscribed to every event type
// (dashboard-created endpoints; the public API always writes an explicit list).
const webhookListItemSchema = z.object({
  id: z.uuid(),
  endpoint: z.string(),
  created_at: z.string(),
  status: webhookWireStatusSchema,
  events: z.array(z.string()).nullable(),
});

export const createWebhookResponseSchema = z
  .object({ object: z.literal("webhook"), id: z.uuid(), signing_secret: z.string() })
  .openapi("CreateWebhookResponse");

export const getWebhookResponseSchema = webhookListItemSchema
  .extend({ object: z.literal("webhook"), signing_secret: z.string() })
  .openapi("GetWebhookResponse");

export const listWebhooksResponseSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(webhookListItemSchema),
    has_more: z.boolean(),
  })
  .openapi("ListWebhooksResponse");

export const webhookIdResponseSchema = z
  .object({ object: z.literal("webhook"), id: z.uuid() })
  .openapi("WebhookIdResponse");

export const removeWebhookResponseSchema = z
  .object({ object: z.literal("webhook"), id: z.uuid(), deleted: z.literal(true) })
  .openapi("RemoveWebhookResponse");

/** API keys — wire-compatible with the resend SDK's apiKeys surface. */

export const createApiKeyRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    permission: z.enum(["full_access", "sending_access"]).default("full_access"),
    // Omitted = any verified domain; a uuid scopes the key to one domain.
    domain_id: z.uuid().nullish(),
  })
  .openapi("CreateApiKeyRequest");

export const createApiKeyResponseSchema = z
  .object({ id: z.uuid(), token: z.string() })
  .openapi("CreateApiKeyResponse");

export const listApiKeysResponseSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        created_at: z.string(),
        last_used_at: z.string().nullable(),
      }),
    ),
    has_more: z.boolean(),
  })
  .openapi("ListApiKeysResponse");

export const removeApiKeyResponseSchema = z
  .object({ object: z.literal("api_key"), id: z.uuid(), deleted: z.literal(true) })
  .openapi("RemoveApiKeyResponse");

// PATCH /contacts/{id}/topics: the SDK sends the topics array as the bare
// request body (contact-topics.ts posts `payload.topics`).
export const updateContactTopicsRequestSchema = z
  .array(z.object({ id: z.uuid(), subscription: subscriptionEnum }))
  .openapi("UpdateContactTopicsRequest");

export const updateContactTopicsResponseSchema = z
  .object({ id: z.uuid() })
  .openapi("UpdateContactTopicsResponse");
