import { z } from "@hono/zod-openapi";
import { DAY_MS, extractAddrSpec, parseSingleSender } from "@millionsend/core";

/**
 * Wire-compatible with Resend's documented /emails surface
 * (docs/resend-compatibility.md): field names, shapes, and error format must
 * not drift — the contract test runs the official `resend` SDK against us.
 */

const emailAddress = z.string().refine((v) => z.email().safeParse(extractAddrSpec(v)).success, {
  message: "must be a valid email address (display names allowed)",
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

const recipientList = z
  .union([emailAddress, z.array(emailAddress).min(1).max(50)])
  .transform((v) => (Array.isArray(v) ? v : [v]));

export const sendEmailRequestSchema = z
  .object({
    from: fromAddress.openapi({ example: "Acme <onboarding@acme.dev>" }),
    to: recipientList.openapi({ example: ["delivered@resend.dev"] }),
    subject: z.string().min(1),
    html: z.string().optional(),
    text: z.string().optional(),
    cc: recipientList.optional(),
    bcc: recipientList.optional(),
    reply_to: recipientList.optional(),
    // Capped at 30 days ahead (Resend's own limit). Also keeps a scheduled
    // send from outliving the default body-retention window.
    scheduled_at: z.iso
      .datetime({ offset: true })
      .refine((v) => new Date(v).getTime() <= Date.now() + 30 * DAY_MS, {
        message: "scheduled_at cannot be more than 30 days in the future",
      })
      .optional(),
    tags: z.array(z.object({ name: z.string().min(1), value: z.string() })).optional(),
    // Accepted into the schema so we can reject loudly instead of silently
    // stripping — "never an incompatible subset" (docs/resend-compatibility.md).
    attachments: z.array(z.unknown()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    topic_id: z.string().nullable().optional(),
  })
  .refine((v) => v.html !== undefined || v.text !== undefined, {
    message: "Either html or text must be provided",
  })
  .openapi("SendEmailRequest");

export type SendEmailRequest = z.infer<typeof sendEmailRequestSchema>;

export const sendEmailResponseSchema = z.object({ id: z.uuid() }).openapi("SendEmailResponse");

/**
 * Batch send (resend.batch.send → POST /emails/batch). The SDK posts a bare
 * array of email options (attachments unsupported in batch); we reuse the
 * single-send schema per item and cap at Resend's 100-email limit — an
 * over-cap array is a 422. Strict validation only: any invalid item fails the
 * whole batch up front (x-batch-validation defaults to 'strict').
 */
export const batchEmailRequestSchema = z
  .array(sendEmailRequestSchema)
  .min(1)
  .max(100)
  .openapi("BatchEmailRequest");

export const batchEmailResponseSchema = z
  .object({ data: z.array(z.object({ id: z.uuid() })) })
  .openapi("BatchEmailResponse");

export const cancelEmailResponseSchema = z
  .object({ object: z.literal("email"), id: z.uuid() })
  .openapi("CancelEmailResponse");

export const getEmailResponseSchema = z
  .object({
    object: z.literal("email"),
    id: z.uuid(),
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()).nullable(),
    bcc: z.array(z.string()).nullable(),
    reply_to: z.array(z.string()).nullable(),
    subject: z.string(),
    html: z.string().nullable(),
    text: z.string().nullable(),
    created_at: z.string(),
    scheduled_at: z.string().nullable(),
    // RFC 5322 Message-ID ('<id@host>'); a placeholder until the send records
    // the provider message id.
    message_id: z.string(),
    last_event: z.string(),
  })
  .openapi("GetEmailResponse");

/**
 * Resend SDK pagination (buildPaginationQuery): ?limit=&after= / ?before=,
 * limit 1-100 (default 20), cursors are item ids, after and before are
 * mutually exclusive.
 */
export const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    after: z.uuid().optional(),
    before: z.uuid().optional(),
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

export const createContactRequestSchema = z
  .object({
    // Bare addr-spec only — a contact record is an address, not a mailbox
    // with display name.
    email: z.email(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    unsubscribed: z.boolean().optional(),
    // Kept as unknown values so the handler can coerce scalars to strings and
    // reject nested objects/arrays with a precise 422 message.
    properties: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("CreateContactRequest");

export const updateContactRequestSchema = z
  .object({
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    unsubscribed: z.boolean().optional(),
    // Kept as unknown values so the handler can coerce scalars to strings and
    // reject nested objects/arrays with a precise 422 message.
    properties: z.record(z.string(), z.unknown()).optional(),
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

export const getContactResponseSchema = contactSchema
  // `properties` is required by the SDK's GetContactResponseSuccess. Stored as
  // a flat string→string map (Resend property values are strings).
  .extend({ object: z.literal("contact"), properties: z.record(z.string(), z.string()) })
  .openapi("GetContactResponse");

export const listContactsResponseSchema = z
  .object({ object: z.literal("list"), data: z.array(contactSchema), has_more: z.boolean() })
  .openapi("ListContactsResponse");

export const removeContactResponseSchema = z
  .object({ object: z.literal("contact"), contact: z.uuid(), deleted: z.literal(true) })
  .openapi("RemoveContactResponse");

/**
 * Broadcasts. Targeting is an optional segment_id and/or topic_id; neither
 * set means every contact of the team. Unsupported knobs (preview_text,
 * send-on-create) are accepted into the schema and rejected loudly — "never
 * an incompatible subset" (docs/resend-compatibility.md).
 */

const replyToList = z
  .union([emailAddress, z.array(emailAddress).min(1).max(50)])
  .transform((v) => (Array.isArray(v) ? v : [v]));

export const createBroadcastRequestSchema = z
  .object({
    name: z.string().optional(),
    segment_id: z.uuid().optional(),
    from: fromAddress,
    subject: z.string().min(1),
    html: z.string().optional(),
    text: z.string().optional(),
    reply_to: replyToList.optional(),
    preview_text: z.string().optional(),
    topic_id: z.uuid().nullable().optional(),
    send: z.boolean().optional(),
    scheduled_at: z.string().optional(),
  })
  .refine((v) => v.html !== undefined || v.text !== undefined, {
    message: "Either html or text must be provided",
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
    // ISO only — natural-language schedules ("in 2 days") are not supported.
    scheduled_at: z.iso
      .datetime({ offset: true })
      .refine((v) => new Date(v).getTime() <= Date.now() + 30 * DAY_MS, {
        message: "scheduled_at cannot be more than 30 days in the future",
      })
      .optional(),
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
    filter: segmentFilterInputSchema,
  })
  .openapi("CreateSegmentRequest");

export const updateSegmentRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    filter: segmentFilterInputSchema.optional(),
  })
  .openapi("UpdateSegmentRequest");

const segmentBaseSchema = z.object({
  object: z.literal("segment"),
  id: z.uuid(),
  name: z.string(),
  filter: segmentFilterInputSchema,
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
 */

const subscriptionEnum = z.enum(["opt_in", "opt_out"]);

export const createTopicRequestSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    default_subscription: subscriptionEnum,
  })
  .openapi("CreateTopicRequest");

export const topicIdResponseSchema = z.object({ id: z.uuid() }).openapi("TopicIdResponse");

const topicSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().optional(),
  default_subscription: subscriptionEnum,
  created_at: z.string(),
});

export const topicResponseSchema = topicSchema.openapi("TopicResponse");

// ListTopicsResponseSuccess is a bare { data: Topic[] } — no keyset pagination.
export const listTopicsResponseSchema = z
  .object({ data: z.array(topicSchema) })
  .openapi("ListTopicsResponse");

export const removeTopicResponseSchema = z
  .object({ id: z.uuid(), object: z.literal("topic"), deleted: z.literal(true) })
  .openapi("RemoveTopicResponse");

// PATCH /contacts/{id}/topics: the SDK sends the topics array as the bare
// request body (contact-topics.ts posts `payload.topics`).
export const updateContactTopicsRequestSchema = z
  .array(z.object({ id: z.uuid(), subscription: subscriptionEnum }))
  .openapi("UpdateContactTopicsRequest");

export const updateContactTopicsResponseSchema = z
  .object({ id: z.uuid() })
  .openapi("UpdateContactTopicsResponse");
