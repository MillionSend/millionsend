import { z } from "@hono/zod-openapi";
import {
  CONTACT_PROPERTY_KEY_MAX_LENGTH,
  CONTACT_PROPERTY_MAX_KEYS,
  CONTACT_PROPERTY_VALUE_MAX_LENGTH,
  DAY_MS,
  formatMailbox,
  parseMailbox,
  parseScheduledAt,
  parseSingleSender,
  SCHEDULED_AT_FORMS,
  SEGMENT_FILTER_MAX_CONDITIONS,
  SEGMENT_FILTER_VALUE_MAX_LENGTH,
  WEBHOOK_EVENT_TYPES,
} from "@millionsend/core";

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
  // RFC 2369/8058 one-click unsubscribe pair: a sender running its own opt-out
  // endpoint may point recipients at it. Values are checked below so only
  // https/mailto targets go out; on a topic send they replace the generated pair.
  "list-unsubscribe",
  "list-unsubscribe-post",
]);

// RFC 2369: one or more <https://…> or <mailto:…> targets, comma-separated.
const LIST_UNSUBSCRIBE_RE =
  /^\s*<(?:https:\/\/|mailto:)[^<>\s]+>(?:\s*,\s*<(?:https:\/\/|mailto:)[^<>\s]+>)*\s*$/i;
const LIST_UNSUBSCRIBE_POST_VALUE = "List-Unsubscribe=One-Click";

/** Value rule for the two unsubscribe headers; null when the value is acceptable. */
function unsubscribeHeaderIssue(name: string, value: string): string | null {
  const lower = name.toLowerCase();
  if (lower === "list-unsubscribe" && !LIST_UNSUBSCRIBE_RE.test(value)) {
    return "List-Unsubscribe must be one or more <https://…> or <mailto:…> targets";
  }
  if (
    lower === "list-unsubscribe-post" &&
    value.trim().toLowerCase() !== LIST_UNSUBSCRIBE_POST_VALUE.toLowerCase()
  ) {
    return `List-Unsubscribe-Post must be "${LIST_UNSUBSCRIBE_POST_VALUE}"`;
  }
  return null;
}

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
    const unsubscribeIssue = unsubscribeHeaderIssue(name, value);
    if (unsubscribeIssue) ctx.addIssue({ code: "custom", path: [name], message: unsubscribeIssue });
  }
  // RFC 8058: one-click needs both headers and an https target. Half a pair
  // would either ship without one-click or, on a topic send, collide with the
  // generated pair — so the two come together or not at all.
  const names = Object.keys(headers).map((n) => n.toLowerCase());
  const hasList = names.includes("list-unsubscribe");
  const hasPost = names.includes("list-unsubscribe-post");
  if (hasList !== hasPost) {
    ctx.addIssue({
      code: "custom",
      path: [hasList ? "List-Unsubscribe" : "List-Unsubscribe-Post"],
      message: "List-Unsubscribe and List-Unsubscribe-Post must be sent together",
    });
  }
  const listValue = Object.entries(headers).find(
    ([n]) => n.toLowerCase() === "list-unsubscribe",
  )?.[1];
  if (listValue !== undefined && !/<https:\/\//i.test(listValue)) {
    ctx.addIssue({
      code: "custom",
      path: ["List-Unsubscribe"],
      message:
        "List-Unsubscribe must include an <https://…> target (RFC 8058); mailto may only accompany it",
    });
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

export const TEMPLATE_UNSUPPORTED_MESSAGE =
  "template is not supported yet — send html/text; template-based sending is coming";

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
    // Declared so the key survives parsing and can be refused loudly; other
    // unknown keys stay silently dropped for Resend compatibility.
    template: z
      .unknown()
      .optional()
      .describe("Not supported yet: any value is a 422. Send html/text instead"),
  })
  .refine((v) => v.template === undefined, {
    message: TEMPLATE_UNSUPPORTED_MESSAGE,
    path: ["template"],
    abort: true,
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
    // Best-practice score (0-10, one decimal); null when no insights row
    // exists (emails sent before the feature landed, or never sent).
    score: z.number().nullable(),
  })
  .openapi("GetEmailResponse");

const scoreBandEnum = z.enum(["excellent", "good", "needs_attention", "at_risk"]);

// GET /emails/{id}/insights: the pre-send best-practice report computed when
// the email was sent. Check ids, severities, statuses and bands are the frozen
// wire enums from @millionsend/core CHECKS.
export const emailInsightsResponseSchema = z
  .object({
    object: z.literal("email_insights"),
    email_id: z.uuid(),
    score: z.number().describe("Best-practice score, 0-10, one decimal"),
    score_version: z.number().int(),
    band: scoreBandEnum,
    marketing: z.boolean(),
    html_size_bytes: z.number().int().nullable(),
    computed_at: z.string(),
    checks: z.array(
      z.object({
        id: z.string().describe("Check id from the @millionsend/core check catalog"),
        severity: z.enum(["critical", "major", "minor", "info"]),
        status: z.enum(["pass", "fail", "passed_by_design", "not_applicable", "unknown"]),
        penalty: z.number().describe("Points deducted from the score; 0 unless status is fail"),
        detail: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
  })
  .openapi("EmailInsightsResponse");

// GET /deliverability: the account score over the trailing 30 days. Scores
// are 0-10 with one decimal; null means not enough data to compute.
export const deliverabilityResponseSchema = z
  .object({
    object: z.literal("deliverability"),
    score: z.number().nullable(),
    band: scoreBandEnum.nullable(),
    content_score: z.number().nullable(),
    outcome_score: z.number().nullable(),
    complaint_rate: z.number(),
    hard_bounce_rate: z.number(),
    emails_sent: z.number().int(),
    scored_recipients: z.number().int(),
    window_days: z.number().int(),
    insufficient_outcome_data: z.boolean(),
    guardrail_status: z.enum(["ok", "warning", "paused"]),
    score_version: z.number().int(),
  })
  .openapi("DeliverabilityResponse");

/**
 * GET /usage (MillionSend extension): the plan and quota picture a client
 * needs before bulk work. Plan and limits are null off Cloud, where no plan
 * applies.
 */
export const usageResponseSchema = z
  .object({
    object: z.literal("usage"),
    cloud: z.boolean().describe("True on MillionSend Cloud, where plan limits apply"),
    plan: z.enum(["free", "pro", "scale"]).nullable().describe("Effective plan; null self-hosted"),
    limits: z.object({
      emails_per_day: z.number().int().nullable().describe("null = unlimited or self-hosted"),
      domains: z.number().int().nullable().describe("null = unlimited or self-hosted"),
    }),
    today: z.object({
      emails_sent: z.number().int().describe("Emails accepted so far this UTC day"),
      resets_at: z.string().describe("Next UTC midnight, when the daily counter resets"),
    }),
    team: z.object({ id: z.uuid(), name: z.string() }),
    app_url: z
      .string()
      .nullable()
      .describe("Dashboard origin, for building links; null when unset"),
  })
  .openapi("UsageResponse");

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

// Kept as unknown values so the handler can coerce scalars to strings and
// reject nested objects/arrays (and over-long values) with a precise 422.
const contactPropertiesInputSchema = z
  .record(z.string().max(CONTACT_PROPERTY_KEY_MAX_LENGTH), z.unknown())
  .refine((map) => Object.keys(map).length <= CONTACT_PROPERTY_MAX_KEYS, {
    message: `at most ${CONTACT_PROPERTY_MAX_KEYS} properties`,
  });

export const createContactRequestSchema = z
  .object({
    // Bare addr-spec only — a contact record is an address, not a mailbox
    // with display name.
    email: z.email().describe("Bare email address (no display name); unique per team"),
    first_name: z.string().optional().describe("First name"),
    last_name: z.string().optional().describe("Last name"),
    unsubscribed: z.boolean().optional().describe("Global opt-out from all marketing sends"),
    properties: contactPropertiesInputSchema
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
    properties: contactPropertiesInputSchema
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
 * POST /contacts/batch (MillionSend extension; Resend imports contacts only
 * via CSV). Items are untyped here for the same reason as BatchEmailRequest:
 * the handler validates each against CreateContactRequest itself so the
 * x-batch-validation header can decide between failing the whole batch
 * (strict) and per-index errors (permissive).
 */
export const batchContactsRequestSchema = z
  .array(z.unknown().describe("A CreateContactRequest item"))
  .min(1)
  .max(1000)
  .describe("1-1000 CreateContactRequest items")
  .openapi("BatchContactsRequest");

export const batchContactsQuerySchema = z.object({
  on_conflict: z
    .enum(["error", "skip", "upsert"])
    .default("error")
    .describe(
      "What to do with an item whose email (case-insensitive) already belongs to a contact: " +
        "`error` fails the item, `skip` leaves the contact untouched and reports its id, " +
        "`upsert` merges the item into it. Also decides how an email repeated inside the batch " +
        "is handled: `error` fails the later occurrence, `skip` keeps the first, `upsert` " +
        "collapses them into one write (later scalar fields win, associations are unioned).",
    ),
});

export const batchContactsHeadersSchema = z.object({
  "x-batch-validation": z
    .preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.enum(["strict", "permissive"]).optional(),
    )
    .describe(
      "`strict` (default): any invalid item rejects the whole batch with that item's status " +
        "and a `contacts.{index}: ` message prefix, writing nothing. `permissive`: invalid " +
        "items are listed in `errors` and the valid subset is written.",
    ),
});

export const batchContactsResponseSchema = z
  .object({
    data: z
      .array(
        z.object({
          object: z.literal("contact"),
          index: z.number().int().describe("Position of the item in the request array"),
          id: z.uuid().describe("The contact's id (the existing one for skipped/updated)"),
          status: z.enum(["created", "updated", "skipped"]),
        }),
      )
      .describe("One entry per successful item, in request order"),
    counts: z
      .object({
        created: z.number().int(),
        updated: z.number().int(),
        skipped: z.number().int(),
        failed: z.number().int(),
      })
      .describe("Per-status totals over the request items; they sum to the request length"),
    errors: z
      .array(z.object({ index: z.number().int(), message: z.string() }))
      .optional()
      .describe("Permissive mode only: the failed items by request index"),
  })
  .openapi("BatchContactsResponse");

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
    key: z.string().trim().min(1).max(CONTACT_PROPERTY_KEY_MAX_LENGTH),
    type: contactPropertyTypeSchema,
    fallback_value: z
      .union([z.string().max(CONTACT_PROPERTY_VALUE_MAX_LENGTH), z.number()])
      .nullable()
      .optional(),
  })
  .openapi("CreateContactPropertyRequest");

// Only fallback_value is updatable — the SDK never sends key/type on update.
export const updateContactPropertyRequestSchema = z
  .object({
    fallback_value: z
      .union([z.string().max(CONTACT_PROPERTY_VALUE_MAX_LENGTH), z.number()])
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
    conditions: z
      .array(
        z.object({
          field: z.string(),
          op: z.string(),
          // Present but nullable; presence ops (is_set/is_not_set) send null.
          value: z.string().max(SEGMENT_FILTER_VALUE_MAX_LENGTH).nullable(),
        }),
      )
      .max(SEGMENT_FILTER_MAX_CONDITIONS),
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

const CLICK_TRACKING_DESC =
  "Rewrite links to redirect through the tracking subdomain and record email.clicked events. Off by default.";
const OPEN_TRACKING_DESC =
  "Inject a tracking pixel served from the tracking subdomain and record email.opened events. Off by default.";
const TRACKING_SUBDOMAIN_DESC =
  'DNS label of the branded tracking host, e.g. "links" for links.<domain>. Setting it adds a Tracking CNAME to records[]; links are tracked through it once that CNAME resolves. Required on MillionSend Cloud to turn tracking on.';

/**
 * Built per deployment so `region` lists only what it serves: SES
 * configuration sets, SNS topics and tenants are all regional, so an identity
 * anywhere else would hand out DNS records but never send or report events.
 * The narrowed enum is what MCP clients and the live /openapi.json read, and
 * an unserved region fails validation (422) before any SES call.
 */
export const createDomainRequestSchema = (regions: readonly [string, ...string[]]) =>
  z
    .object({
      name: z
        .string()
        .trim()
        .refine((v) => HOSTNAME_RE.test(v), "must be a lowercase hostname"),
      region: z
        .enum(regions)
        .optional()
        .describe(
          "SES region of the identity. Each deployment serves one region and rejects any other with 422; omit to use it.",
        ),
      custom_return_path: z
        .string()
        .trim()
        .refine((v) => SUBDOMAIN_RE.test(v), "must be a lowercase DNS label")
        .default("send"),
      // Optional and additive: Resend's create has no tracking fields, so a
      // Resend-shaped call that omits them behaves exactly as before.
      open_tracking: z.boolean().optional().describe(OPEN_TRACKING_DESC),
      click_tracking: z.boolean().optional().describe(CLICK_TRACKING_DESC),
      tracking_subdomain: z
        .string()
        .trim()
        .refine((v) => SUBDOMAIN_RE.test(v), "must be a lowercase DNS label")
        .optional()
        .describe(TRACKING_SUBDOMAIN_DESC),
    })
    .openapi("CreateDomainRequest");

export const updateDomainRequestSchema = z
  .object({
    click_tracking: z.boolean().optional().describe(CLICK_TRACKING_DESC),
    open_tracking: z.boolean().optional().describe(OPEN_TRACKING_DESC),
    // Empty string or null clears the branded tracking subdomain.
    tracking_subdomain: z
      .string()
      .trim()
      .refine((v) => v === "" || SUBDOMAIN_RE.test(v), "must be a lowercase DNS label")
      .nullable()
      .optional()
      .describe(`${TRACKING_SUBDOMAIN_DESC} Empty string or null clears it.`),
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
    signing_secret: z
      .string()
      .optional()
      .describe(
        "Signing secret to use instead of minting one: whsec_ followed by base64 of 24-64 bytes, the format Resend/Svix issue. Carry over an existing secret so the receiver keeps verifying unchanged; omit to generate a new one.",
      ),
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

export const listContactTopicsResponseSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        description: z.string().nullable(),
        subscription: subscriptionEnum.describe(
          "Effective choice: the contact's explicit one, else the topic's default",
        ),
        explicit: z
          .boolean()
          .describe(
            "True when the contact or the API chose this; false when it is the topic's default",
          ),
      }),
    ),
    has_more: z.literal(false),
  })
  .openapi("ListContactTopicsResponse");

/**
 * Suppressions — wire-compatible with the resend SDK's suppressions surface
 * (incl. `suppressions.batch`). `origin` is the wire name of the internal
 * reason enum; `unsubscribe` is a documented superset value (the retained RFC
 * 8058 one-click opt-out) that Resend has no equivalent for.
 */

export const SUPPRESSION_ORIGIN_BY_REASON = {
  hard_bounce: "bounce",
  complaint: "complaint",
  manual: "manual",
  one_click_unsubscribe: "unsubscribe",
} as const;

export type SuppressionReason = keyof typeof SUPPRESSION_ORIGIN_BY_REASON;
export type SuppressionOrigin = (typeof SUPPRESSION_ORIGIN_BY_REASON)[SuppressionReason];

const suppressionOriginSchema = z.enum(["bounce", "complaint", "manual", "unsubscribe"]);

/** Resend caps batch bodies at 100 addresses; accepting 1000 is a documented superset. */
export const SUPPRESSION_BATCH_MAX = 1000;

export const listSuppressionsQuerySchema = listQuerySchema.extend({
  origin: suppressionOriginSchema
    .optional()
    .describe("Only suppressions of this origin: bounce, complaint, manual or unsubscribe"),
});

/**
 * Origin a caller may record on a new suppression: an import from another
 * provider keeps its bounce/complaint history, and a migrated opt-out list
 * keeps `unsubscribe` — which then behaves like a one-click opt-out (only an
 * explicit re-subscribe clears it).
 */
const suppressionWriteOriginSchema = suppressionOriginSchema
  .optional()
  .describe(
    "Origin recorded on rows this request creates (default manual): bounce, complaint, manual or unsubscribe; an address already suppressed keeps its origin",
  );

export const createSuppressionRequestSchema = z
  .object({
    email: z.email().describe("Bare email address to block; stored normalized (lowercase)"),
    origin: suppressionWriteOriginSchema,
  })
  .openapi("CreateSuppressionRequest");

export const batchAddSuppressionsRequestSchema = z
  .object({
    emails: z
      .array(z.email())
      .min(1)
      .max(SUPPRESSION_BATCH_MAX)
      .describe(`Addresses to block, up to ${SUPPRESSION_BATCH_MAX}; duplicates collapse`),
    origin: suppressionWriteOriginSchema,
  })
  .openapi("BatchAddSuppressionsRequest");

export const batchRemoveSuppressionsRequestSchema = z
  .object({
    emails: z
      .array(z.email())
      .min(1)
      .max(SUPPRESSION_BATCH_MAX)
      .optional()
      .describe(`Addresses to unblock, up to ${SUPPRESSION_BATCH_MAX}`),
    ids: z
      .array(z.uuid())
      .min(1)
      .max(SUPPRESSION_BATCH_MAX)
      .optional()
      .describe(`Suppression ids to remove, up to ${SUPPRESSION_BATCH_MAX}`),
  })
  .refine((v) => (v.emails === undefined) !== (v.ids === undefined), {
    message: "provide exactly one of emails or ids",
  })
  .openapi("BatchRemoveSuppressionsRequest");

const suppressionListItemSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  origin: suppressionOriginSchema,
  source_id: z.uuid().nullable().describe("Email id whose bounce/complaint created the entry"),
  created_at: z.string(),
});

export const suppressionIdResponseSchema = z
  .object({ object: z.literal("suppression"), id: z.uuid() })
  .openapi("SuppressionIdResponse");

export const getSuppressionResponseSchema = suppressionListItemSchema
  .extend({ object: z.literal("suppression") })
  .openapi("GetSuppressionResponse");

export const listSuppressionsResponseSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(suppressionListItemSchema),
    has_more: z.boolean(),
  })
  .openapi("ListSuppressionsResponse");

export const removeSuppressionResponseSchema = z
  .object({ object: z.literal("suppression"), id: z.uuid(), deleted: z.literal(true) })
  .openapi("RemoveSuppressionResponse");

export const batchAddSuppressionsResponseSchema = z
  .object({ data: z.array(suppressionIdResponseSchema) })
  .openapi("BatchAddSuppressionsResponse");

export const batchRemoveSuppressionsResponseSchema = z
  .object({ data: z.array(removeSuppressionResponseSchema) })
  .openapi("BatchRemoveSuppressionsResponse");

/**
 * Templates — wire-compatible with the resend SDK's templates surface.
 * MillionSend templates have no draft/publish cycle and no version history
 * (every save is live), so on the wire `status` is always "published",
 * `published_at` is created_at, `current_version_id` is the template id and
 * `has_unpublished_versions` is false. `from`, `reply_to` and `variables` are
 * not modelled: a value on write is a 422, reads emit null/null/[] so the key
 * set matches the SDK's Template type.
 */

export const TEMPLATE_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// A uuid-shaped alias would be unreachable: GET /templates/{id} resolves a
// uuid by id first.
const templateAliasSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(TEMPLATE_ALIAS_PATTERN, {
    message: "alias must be letters, digits, '.', '_' or '-', starting with a letter or digit",
  })
  .refine((a) => !z.uuid().safeParse(a).success, { message: "alias must not be a UUID" })
  .describe("Case-sensitive handle, unique per team; GET /templates/{alias} resolves it");

// Same limits as the dashboard editor.
const templateNameSchema = z.string().trim().min(1).max(200);
const templateSubjectSchema = z
  .string()
  .trim()
  .max(998)
  .nullable()
  .describe('"" or null clears the subject');
const templateBodySchema = z.string().max(500_000);

// Declared so a caller's value reaches the handler (which 422s it) instead of
// being stripped as an unknown key.
const unsupportedTemplateFields = {
  from: z.string().nullable().optional().describe("Not supported yet: any value is a 422"),
  reply_to: z
    .union([z.string(), z.array(z.string())])
    .nullable()
    .optional()
    .describe("Not supported yet: any value is a 422"),
  variables: z
    .array(z.unknown())
    .optional()
    .describe("Not supported yet: a non-empty list is a 422"),
};

export const createTemplateRequestSchema = z
  .object({
    name: templateNameSchema,
    subject: templateSubjectSchema.optional(),
    html: templateBodySchema.min(1).describe("Stored as sent; the dashboard sanitizes at render"),
    text: templateBodySchema.nullable().optional().describe('"" or null clears the text part'),
    alias: templateAliasSchema.nullable().optional(),
    ...unsupportedTemplateFields,
  })
  .openapi("CreateTemplateRequest");

export const updateTemplateRequestSchema = z
  .object({
    name: templateNameSchema.optional(),
    subject: templateSubjectSchema.optional(),
    html: templateBodySchema.min(1).optional(),
    text: templateBodySchema.nullable().optional(),
    alias: templateAliasSchema.nullable().optional().describe("null clears the alias"),
    ...unsupportedTemplateFields,
  })
  .openapi("UpdateTemplateRequest");

const templateListItemSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  alias: z.string().nullable(),
  status: z.literal("published"),
  published_at: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const templateIdResponseSchema = z
  .object({ object: z.literal("template"), id: z.uuid() })
  .openapi("TemplateIdResponse");

export const getTemplateResponseSchema = templateListItemSchema
  .extend({
    object: z.literal("template"),
    current_version_id: z.uuid(),
    from: z.null(),
    subject: z.string().nullable(),
    reply_to: z.null(),
    html: z.string(),
    text: z.string().nullable(),
    variables: z.array(z.unknown()).describe("Always empty"),
    has_unpublished_versions: z.literal(false),
  })
  .openapi("GetTemplateResponse");

export const listTemplatesResponseSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(templateListItemSchema),
    has_more: z.boolean(),
  })
  .openapi("ListTemplatesResponse");

export const removeTemplateResponseSchema = z
  .object({ object: z.literal("template"), id: z.uuid(), deleted: z.literal(true) })
  .openapi("RemoveTemplateResponse");
