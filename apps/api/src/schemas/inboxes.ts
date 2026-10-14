import { z } from "@hono/zod-openapi";
import {
  INBOX_ALLOWLIST_MAX,
  INBOX_FORWARD_TO_MAX,
  INBOX_KINDS,
  INBOX_OWNER_ADDRESSES_MAX,
  type ListQuery,
  MOVE_FOLDERS,
  QUARANTINE_REASONS,
  SCREENING_VERDICTS,
  SENDER_TRUSTS,
  THREAD_FOLDERS,
  type ThreadFolder,
} from "@millionsend/core";
import { INBOX_NAME_MAX } from "@millionsend/core/inbox-username";

/**
 * Resend's Inboxes beta (/inboxes/**), plus MillionSend's extension keys.
 * Every string in a thread email came from whoever sent the message.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const inboxIdParam = z.object({ inbox_id: z.uuid().describe("The inbox ID") });

const inboxKindSchema = z.enum(INBOX_KINDS);

const safetyFields = {
  accept_from: z
    .enum(["anyone", "verified", "allowlist"])
    .describe(
      "Who may write in: anyone; verified (DMARC-aligned senders, known threads, the allowlist); allowlist only. Mail that fails is quarantined.",
    ),
  allowlist: z
    .array(z.string())
    .max(INBOX_ALLOWLIST_MAX)
    .describe(
      '"local@domain" (exact) or "*@domain" (the domain and its subdomains). On the shared domain it only lets mail in',
    ),
  owner_addresses: z
    .array(z.string())
    .max(INBOX_OWNER_ADDRESSES_MAX)
    .describe("Owners besides the team members' login addresses; ignored on the shared domain"),
  screening: z.boolean().describe("Score external mail for prompt injection (agent inboxes only)"),
  extract_codes: z.boolean().describe("Expose extracted codes and sign-in links"),
  send_policy: z
    .enum(["reply_only", "allowlist", "open"])
    .describe(
      'What the inbox may send without a person\'s approval. On the shared domain "allowlist" answers 422, and so does "open" unless the instance lets the team start conversations there (paid plans only)',
    ),
  require_approval: z.boolean().describe("Every send waits for a person"),
  private_codes: z
    .boolean()
    .describe("Received codes and sign-in links can't be sent on to anyone but owners"),
  send_cap: z
    .number()
    .int()
    .nullable()
    .describe("Unattended recipients per UTC day; null: no cap. 1-50 on the shared domain"),
  forward_to: z
    .array(z.string())
    .max(INBOX_FORWARD_TO_MAX)
    .describe(
      "Forward every delivered message to these team member or owner addresses; team members only on the shared domain",
    ),
};

export const inboxSafetyPatchBodySchema = z
  .strictObject({
    accept_from: safetyFields.accept_from.optional(),
    allowlist: safetyFields.allowlist.optional(),
    owner_addresses: safetyFields.owner_addresses.optional(),
    screening: safetyFields.screening.optional(),
    extract_codes: safetyFields.extract_codes.optional(),
    send_policy: safetyFields.send_policy.optional(),
    require_approval: safetyFields.require_approval.optional(),
    private_codes: safetyFields.private_codes.optional(),
    send_cap: safetyFields.send_cap.optional(),
    forward_to: safetyFields.forward_to.optional(),
  })
  .openapi("InboxSafetyPatch");

export const inboxSafetyResponseSchema = z
  .object({ object: z.literal("inbox_safety"), inbox_id: z.uuid(), ...safetyFields })
  .openapi("InboxSafety");

export const createInboxRequestSchema = z
  .object({
    email_address: z
      .string()
      .optional()
      .describe(
        "An address on one of your verified domains; it needs receiving on unless forwarding is true. MillionSend extension: omitted, the inbox gets an address on the shared inbox domain (no DNS), named by username or random.",
      ),
    username: z
      .string()
      .optional()
      .describe(
        "MillionSend extension: with email_address omitted, the part before the @ of the shared-domain address, trimmed and lowercased: 1-64 letters, digits, dots, hyphens and underscores, starting and ending with a letter or digit, never cut short. Reserved names (postmaster, abuse, admin, security, support, noreply, no-reply, billing, hostmaster, webmaster, mailer-daemon, root, compared without dots, hyphens and underscores), the fwd- prefix and brand look-alikes answer 422, and one already in use 409. Where the instance reviews names, a chosen one is reviewed first: 503 with retry-after while that review is unavailable. Omitted: a random one.",
      ),
    name: z
      .string()
      .optional()
      .describe(
        `Internal name, 1-${INBOX_NAME_MAX} characters, so any address fits. Defaults to email_address.`,
      ),
    from_name: z
      .string()
      .optional()
      .describe(
        'The name recipients see, a plain name (not "Name <email>"); "" leaves it unset. On the shared domain it may not imitate a brand, and it is reviewed like username.',
      ),
    forwarding: z
      .boolean()
      .optional()
      .describe(
        "Receive without an MX record: mail forwarded to the inbox's receiving_address lands in it",
      ),
    kind: inboxKindSchema
      .optional()
      .describe(
        "MillionSend extension: agent (default; threads, screening, drafts that wait for approval) or human (a team mailbox)",
      ),
    expires_in: z
      .string()
      .nullable()
      .optional()
      .describe(
        'MillionSend extension: a lifetime counted from now, "1h" to "365d"; omitted or null, the inbox never expires. A shared-domain inbox left unused for 90 days (no mail in or out, no API calls on it) is deleted either way.',
      ),
    safety: inboxSafetyPatchBodySchema
      .optional()
      .describe("MillionSend extension: safety rules over the kind's defaults"),
  })
  .openapi("CreateInboxRequest");

export const updateInboxRequestSchema = z
  .object({
    name: z.string().optional(),
    from_name: z
      .string()
      .optional()
      .describe(
        '"" removes it. On the shared domain a new one may not imitate a brand, and it is reviewed first where the instance reviews names (503 with retry-after while that review is unavailable).',
      ),
    expires_in: z
      .string()
      .nullable()
      .optional()
      .describe(
        'MillionSend extension: a new lifetime counted from now, "1h" to "365d"; null never expires',
      ),
  })
  .openapi("UpdateInboxRequest");

export const inboxSchema = z
  .object({
    object: z.literal("inbox"),
    id: z.uuid(),
    name: z.string(),
    email_address: z.string(),
    domain_id: z
      .uuid()
      .describe("A shared address's is its shared subdomain's id, which /domains does not list"),
    receiving_address: z.string().nullable(),
    from_name: z.string().nullable(),
    unread: z.number().int().describe("Threads with an unread message"),
    drafts: z.number().int().describe("Unsent drafts"),
    last_received: z.string().nullable(),
    created_at: z.string(),
    kind: inboxKindSchema,
    shared: z.boolean().describe("On the shared inbox domain"),
    expires_at: z.string().nullable(),
    quarantined: z.number().int().describe("Held messages not yet released"),
    pending_approval: z.number().int().describe("Drafts waiting for a person"),
  })
  .openapi("Inbox");

const inboxListItemSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  email_address: z.string(),
  from_name: z.string().nullable(),
  unread: z.number().int(),
  last_received: z.string().nullable(),
  kind: inboxKindSchema,
  shared: z.boolean(),
  expires_at: z.string().nullable(),
});

export const listInboxesResponseSchema = z
  .object({ object: z.literal("list"), has_more: z.boolean(), data: z.array(inboxListItemSchema) })
  .openapi("ListInboxesResponse");

export const removeInboxResponseSchema = z
  .object({ object: z.literal("inbox"), id: z.uuid(), deleted: z.literal(true) })
  .openapi("RemoveInboxResponse");

export const inboxAgentResponseSchema = z
  .object({
    object: z.literal("inbox_agent"),
    instructions: z.null(),
    tone: z.null(),
    enabled_actions: z.array(z.string()).max(0),
  })
  .openapi("InboxAgent");

export const updateInboxAgentRequestSchema = z
  .object({
    instructions: z.string().nullable().optional(),
    tone: z.string().nullable().optional(),
    enabled_actions: z.array(z.string()).optional(),
  })
  .openapi("UpdateInboxAgentRequest");

const labelSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  color: z.string().describe("Uppercase #RRGGBB"),
  created_at: z.string(),
});

export const labelResponseSchema = labelSchema
  .extend({ object: z.literal("inbox_label") })
  .openapi("InboxLabel");

export const listLabelsResponseSchema = z
  .object({ object: z.literal("list"), data: z.array(labelSchema) })
  .openapi("ListInboxLabelsResponse");

export const createLabelRequestSchema = z
  .object({
    name: z.string().describe("1-64 characters, unique in the inbox regardless of case"),
    color: z.string().optional().describe("#RRGGBB; a color is picked when omitted"),
  })
  .openapi("CreateInboxLabelRequest");

export const updateLabelRequestSchema = z
  .object({ name: z.string().optional(), color: z.string().optional() })
  .openapi("UpdateInboxLabelRequest");

export const removeLabelResponseSchema = z
  .object({ object: z.literal("inbox_label"), id: z.uuid(), deleted: z.literal(true) })
  .openapi("RemoveInboxLabelResponse");

const threadLabelSchema = z.object({ id: z.uuid(), name: z.string(), color: z.string() });

export const threadSummarySchema = z
  .object({
    object: z.literal("inbox_thread"),
    id: z.uuid(),
    subject: z.string().nullable(),
    folder: z.enum(THREAD_FOLDERS),
    labels: z.array(threadLabelSchema),
    read: z.boolean(),
    quarantined: z
      .number()
      .int()
      .describe("MillionSend extension: held messages; 0 for inbox-scoped keys"),
  })
  .openapi("InboxThread");

const threadListItemSchema = z.object({
  id: z.uuid(),
  subject: z.string().nullable(),
  from: z.string().nullable(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  labels: z.array(threadLabelSchema),
  message_count: z.number().int(),
  has_attachment: z.boolean(),
  has_draft: z.boolean(),
  read: z.boolean(),
  quarantined: z
    .number()
    .int()
    .optional()
    .describe(
      "MillionSend extension, with include_quarantined=true: held messages not yet released; they never count as unread",
    ),
  received_at: z.string(),
  folder: z.enum(THREAD_FOLDERS),
});

export const listThreadsResponseSchema = z
  .object({ object: z.literal("list"), has_more: z.boolean(), data: z.array(threadListItemSchema) })
  .openapi("ListInboxThreadsResponse");

const highlights = z.array(z.string()).optional();

export const searchThreadsResponseSchema = z
  .object({
    object: z.literal("list"),
    has_more: z.boolean(),
    data: z.array(
      threadListItemSchema.extend({
        matched_email_id: z.uuid().nullable(),
        highlights: z
          .object({
            subject: highlights,
            from: highlights,
            to: highlights,
            cc: highlights,
            bcc: highlights,
          })
          .describe("Fragments with **match** markers; only keys that matched; {} without query"),
      }),
    ),
  })
  .openapi("SearchInboxThreadsResponse");

export const removeThreadResponseSchema = z
  .object({ object: z.literal("inbox_thread"), id: z.uuid(), deleted: z.boolean() })
  .openapi("RemoveInboxThreadResponse");

export const updateThreadRequestSchema = z
  .object({
    read: z.boolean().optional().describe("Marks every message read or unread"),
    folder: z.enum(MOVE_FOLDERS).optional().describe("sent is assigned, never chosen"),
    label_id: z.uuid().optional().describe("Applies this label"),
  })
  .openapi("UpdateInboxThreadRequest");

const threadEmailFields = {
  id: z.uuid(),
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  reply_to: z.array(z.string()),
  subject: z.string().nullable(),
  message_id: z.string().nullable(),
  html: z.string().nullable(),
  text: z.string().nullable(),
  attachments: z.array(
    z.object({
      id: z.string(),
      filename: z.string().nullable(),
      size: z.number().int().nullable(),
    }),
  ),
  read: z.boolean(),
  received_at: z.string(),
};

const screeningSchema = z.object({
  verdict: z.enum(SCREENING_VERDICTS),
  sender_trust: z.enum(SENDER_TRUSTS),
  quarantine_reason: z.enum(QUARANTINE_REASONS).nullable(),
  reasons: z.array(z.string()),
  injection_score: z.number().int().nullable(),
  phishing_score: z.number().int().nullable(),
  hidden_text_removed: z.boolean(),
});

export const threadEmailSchema = z
  .union([
    z.object({
      ...threadEmailFields,
      direction: z.literal("inbound"),
      extracted_text: z
        .string()
        .nullable()
        .describe("MillionSend extension: hidden text, quotes and signature removed"),
      screening: screeningSchema,
      spam_verdict: z.enum(["pass", "gray", "fail"]).nullable(),
      virus_verdict: z.enum(["pass", "fail", "processing_failed"]).nullable(),
    }),
    z.object({
      ...threadEmailFields,
      direction: z.literal("outbound"),
      status: z.string().describe("MillionSend extension: the email's last event"),
    }),
  ])
  .openapi("InboxThreadEmail");

export const listThreadEmailsResponseSchema = z
  .object({ object: z.literal("list"), has_more: z.boolean(), data: z.array(threadEmailSchema) })
  .openapi("ListInboxThreadEmailsResponse");

export const listQuarantinedResponseSchema = z
  .object({
    object: z.literal("list"),
    has_more: z.boolean(),
    data: z.array(
      z.object({
        id: z.uuid(),
        thread_id: z.uuid().nullable(),
        from: z.string(),
        subject: z.string().nullable(),
        received_at: z.string(),
        quarantine_reason: z.enum(QUARANTINE_REASONS),
        sender_trust: z.enum(SENDER_TRUSTS),
        injection_score: z.number().int().nullable(),
        phishing_score: z.number().int().nullable(),
        virus_signature: z.string().nullable(),
      }),
    ),
  })
  .openapi("ListQuarantinedEmailsResponse");

export const releaseRequestSchema = z
  .object({
    trust_sender: z
      .boolean()
      .optional()
      .describe("Also add the sender's address to the inbox allowlist"),
  })
  .openapi("ReleaseQuarantinedRequest");

export const releaseResponseSchema = z
  .object({
    object: z.literal("inbox_release"),
    inbox_id: z.uuid(),
    email_id: z.uuid(),
    released_at: z.string(),
    trusted_sender: z.string().nullable(),
  })
  .openapi("InboxRelease");

export const verificationCodeResponseSchema = z
  .object({
    object: z.literal("verification_code"),
    status: z.enum(["found", "none", "ambiguous", "timeout"]),
    kind: z.enum(["otp", "link"]).nullable(),
    code: z.string().nullable(),
    url: z.string().nullable(),
    link_domain_matches_sender: z.boolean().nullable(),
    email_id: z.uuid().nullable(),
    from: z.string().nullable(),
    received_at: z.string().nullable(),
    sender_trust: z.enum(SENDER_TRUSTS).nullable(),
  })
  .openapi("VerificationCode");

const optionalString = (description: string) => z.string().optional().describe(description);

const pagingFields = {
  limit: optionalString("Page size, 1-100 (default 20)"),
  after: optionalString("The id of the last item of the current page; returns the next page"),
  before: optionalString("The id of the first item of the current page; returns the previous page"),
};

export const pagingQuerySchema = z.object(pagingFields);

export const listInboxesQuerySchema = z.object({
  ...pagingFields,
  kind: inboxKindSchema.optional().describe("MillionSend extension: agent or human inboxes only"),
});

const includeQuarantined = optionalString(
  "MillionSend extension: true includes held messages (owner views; a full access key that is not inbox-scoped)",
);

export const threadEmailsQuerySchema = z.object({
  ...pagingFields,
  include_quarantined: includeQuarantined,
});

const threadListFields = {
  ...pagingFields,
  folders: optionalString(
    "Comma-separated: inbox, archive, spam, sent, trash. Defaults to inbox, or inbox,archive,sent with labels",
  ),
  labels: optionalString("Comma-separated label ids (at most 50); threads with any of them"),
  read: optionalString("true: every message read; false: at least one unread"),
  include_quarantined: includeQuarantined,
};

export const listThreadsQuerySchema = z.object(threadListFields);

export const searchThreadsQuerySchema = z.object({
  ...threadListFields,
  query: optionalString(
    'Words that must all match the subject, sender or recipients; "a phrase"; -word excludes. At most 256 characters and 32 words.',
  ),
  from: optionalString("Comma-separated parts of the sender's address or name (at most 20)"),
  to: optionalString("Comma-separated parts of a recipient (at most 20)"),
  cc: optionalString("Comma-separated parts of a CC recipient (at most 20)"),
  bcc: optionalString("Comma-separated parts of a BCC recipient (at most 20)"),
  has_attachment: optionalString("true or false"),
  start_date: optionalString("A date (2026-09-01) or an ISO 8601 timestamp, UTC unless offset"),
  end_date: optionalString("Same forms; a date covers the whole day"),
});

export const codesQuerySchema = z.object({
  from: optionalString("An exact sender address, or a domain covering itself and its subdomains"),
  wait: optionalString("Seconds to wait for a code to arrive, 0-50 (default 0)"),
  max_age: optionalString(
    "How long ago the code may have reached the inbox, in seconds, 60-86400 (default 600); a released code counts from its release",
  ),
  since: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      "Only mail received after this ISO 8601 instant, such as the received_at of a code already used",
    ),
});

/** Resend's pagination messages, shared by every /inboxes list. */
const LIMIT_MESSAGE =
  "The pagination limit must be a number between 1 and 100. See https://resend.com/docs/api-reference/pagination for more information.";
const BOTH_CURSORS_MESSAGE =
  "You can only pass one of `before` or `after` for pagination. See https://resend.com/docs/api-reference/pagination for more information.";

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = (message: string): Parsed<never> => ({ ok: false, message });

/** limit, after and before with Resend's messages; `item` names what the cursors point at. */
export function pagingOf(
  q: { limit?: string | undefined; after?: string | undefined; before?: string | undefined },
  item: "thread" | "email" | "inbox",
): Parsed<ListQuery> {
  const out: ListQuery = {};
  if (q.limit !== undefined && q.limit !== "") {
    const limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return bad(LIMIT_MESSAGE);
    out.limit = limit;
  }
  const after = q.after || undefined;
  const before = q.before || undefined;
  if (after && before) return bad(BOTH_CURSORS_MESSAGE);
  for (const [key, value] of [
    ["after", after],
    ["before", before],
  ] as const) {
    if (value === undefined) continue;
    if (!UUID.test(value)) {
      const byDate =
        item === "thread"
          ? ` To filter by date, use \`GET /inboxes/:id/threads/search\` with \`${key === "after" ? "start_date" : "end_date"}\`.`
          : "";
      return bad(
        `The \`${key}\` parameter must be a${item === "inbox" || item === "email" ? "n" : ""} ${item} ID.${byDate}`,
      );
    }
    out[key] = value.toLowerCase();
  }
  return ok(out);
}

/** A comma-separated query value; an empty value is absent. */
export function csvOf(value: string | undefined): string[] | undefined {
  const parts = (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export function booleanOf(value: string | undefined, key: string): Parsed<boolean | undefined> {
  if (value === undefined || value === "") return ok(undefined);
  if (value === "true" || value === "false") return ok(value === "true");
  return bad(`The \`${key}\` parameter must be \`true\` or \`false\`.`);
}

const isFolder = (value: string): value is ThreadFolder =>
  (THREAD_FOLDERS as readonly string[]).includes(value);

/** folders, labels and read as the thread list and search take them. */
export function threadFiltersOf(q: {
  folders?: string | undefined;
  labels?: string | undefined;
  read?: string | undefined;
}): Parsed<{ folders?: ThreadFolder[]; labels?: string[]; read?: boolean }> {
  const out: { folders?: ThreadFolder[]; labels?: string[]; read?: boolean } = {};
  const folders = csvOf(q.folders);
  if (folders) {
    const unknown = folders.find((f) => !isFolder(f));
    if (unknown !== undefined) {
      return bad(
        `The \`folders\` value "${unknown}" must be one of: ${THREAD_FOLDERS.join(", ")}.`,
      );
    }
    out.folders = folders.filter(isFolder);
  }
  const labels = csvOf(q.labels);
  if (labels) {
    const notUuid = labels.find((id) => !UUID.test(id));
    if (notUuid !== undefined)
      return bad(`The \`labels\` value "${notUuid}" must be a valid UUID.`);
    if (labels.length > 50) {
      return bad(
        `The \`labels\` parameter must contain at most 50 label IDs, but received ${labels.length}.`,
      );
    }
    out.labels = labels;
  }
  const read = booleanOf(q.read, "read");
  if (!read.ok) return read;
  if (read.value !== undefined) out.read = read.value;
  return ok(out);
}

/** from, to, cc or bcc of a search: at most 20 values each. */
export function peopleOf(value: string | undefined, key: string): Parsed<string[] | undefined> {
  const values = csvOf(value);
  if (values && values.length > 20) {
    return bad(
      `The \`${key}\` parameter must contain at most 20 values, but received ${values.length}.`,
    );
  }
  return ok(values);
}

/** An integer query value within bounds, or the message naming them. */
export function boundedInt(
  value: string | undefined,
  key: string,
  min: number,
  max: number,
  fallback: number,
): Parsed<number> {
  if (value === undefined || value === "") return ok(fallback);
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max
    ? ok(n)
    : bad(`${key} must be a whole number between ${min} and ${max}`);
}

/** GET /inboxes/{id} takes an id or, holding an "@", the inbox's address. */
export function inboxRefOf(value: string): Parsed<string> {
  if (value.includes("@")) {
    const at = value.lastIndexOf("@");
    return at > 0 && at < value.length - 1 && !/\s/.test(value)
      ? ok(value)
      : bad("inbox_id must be an inbox ID or an email address");
  }
  return UUID.test(value) ? ok(value) : bad("inbox_id must be an inbox ID or an email address");
}
