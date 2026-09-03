import type { SourceBroadcast, SourceDomain, SourceTemplate } from "./model.js";

/*
 * Pure Resend → MillionSend shape translation. The bundle has no runtime
 * dependencies, so the target's vocabularies are mirrored here instead of
 * imported: keep them identical to their sources.
 */

/** Mirror of packages/core/src/webhooks.ts WEBHOOK_EVENT_TYPES. */
export const TARGET_WEBHOOK_EVENTS = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.opened",
  "email.clicked",
] as const;
export type TargetWebhookEvent = (typeof TARGET_WEBHOOK_EVENTS)[number];

/** Mirror of apps/web/src/lib/merge-fields.ts MERGE_NAME_RE — the token grammar the send worker resolves. */
const MERGE_NAME_RE = /^[A-Za-z0-9_]+$/;
const TRIPLE_BRACE_RE = /\{\{\{([\s\S]*?)\}\}\}/g;

// RESEND_UNSUBSCRIBE_URL stays as-is: the worker accepts it as an alias.
const MERGE_ALIASES: Record<string, string> = {
  "contact.first_name": "FIRST_NAME",
  "contact.last_name": "LAST_NAME",
  "contact.email": "EMAIL",
  unsubscribe_url: "UNSUBSCRIBE_URL",
  UNSUBSCRIBE_URL: "UNSUBSCRIBE_URL",
  RESEND_UNSUBSCRIBE_URL: "RESEND_UNSUBSCRIBE_URL",
};

/**
 * Rewrites `{{{contact.<key>|fallback}}}` tokens to the target grammar. A
 * token that still does not fit the grammar is left untouched and reported.
 */
export function translateMergeTags(html: string): { html: string; untranslated: string[] } {
  const untranslated = new Set<string>();
  const out = html.replace(TRIPLE_BRACE_RE, (token: string, inner: string) => {
    const pipe = inner.indexOf("|");
    const rawName = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    const fallback = pipe === -1 ? null : inner.slice(pipe + 1);
    const name =
      MERGE_ALIASES[rawName] ?? (rawName.startsWith("contact.") ? rawName.slice(8) : rawName);
    if (!MERGE_NAME_RE.test(name) || (fallback !== null && /[{}]/.test(fallback))) {
      untranslated.add(token);
      return token;
    }
    return `{{{${name}${fallback === null ? "" : `|${fallback}`}}}}`;
  });
  return { html: out, untranslated: [...untranslated] };
}

export interface SegmentCondition {
  field: string;
  op: string;
  value: string | null;
}

/** The target's saved-filter shape (packages/core/src/segment-filter.ts). */
export interface SegmentFilter {
  match: "all" | "any";
  conditions: SegmentCondition[];
}

const MATCH_ALIASES: Record<string, "all" | "any"> = {
  all: "all",
  and: "all",
  any: "any",
  or: "any",
};

const TEXT_OP_ALIASES: Record<string, string> = {
  equals: "equals",
  eq: "equals",
  is: "equals",
  "=": "equals",
  not_equals: "not_equals",
  neq: "not_equals",
  is_not: "not_equals",
  "!=": "not_equals",
  contains: "contains",
  starts_with: "starts_with",
  ends_with: "ends_with",
  is_set: "is_set",
  exists: "is_set",
  is_not_empty: "is_set",
  is_not_set: "is_not_set",
  not_exists: "is_not_set",
  is_empty: "is_not_set",
};

const DATE_OP_ALIASES: Record<string, string> = {
  before: "before",
  lt: "before",
  less_than: "before",
  after: "after",
  gt: "after",
  greater_than: "after",
};

const BUILTIN_TEXT_FIELDS = new Set(["email", "first_name", "last_name"]);
const PROPERTY_PREFIX_RE = /^(?:propert(?:y|ies)[.:]|contact\.)(.+)$/;

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const scalarString = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : null;

function translateCondition(raw: unknown): SegmentCondition | string {
  const c = asRecord(raw);
  if (!c || typeof c.field !== "string") return "condition without a field";
  const opRaw = c.op ?? c.operator;
  if (typeof opRaw !== "string") return `condition on "${c.field}" without an operator`;
  const op = opRaw.toLowerCase();
  const value = scalarString(c.value);
  const property = PROPERTY_PREFIX_RE.exec(c.field)?.[1];
  const field = property ? `property:${property}` : c.field;

  if (property || BUILTIN_TEXT_FIELDS.has(field)) {
    const mapped = TEXT_OP_ALIASES[op];
    if (!mapped) return `operator "${opRaw}" on "${c.field}"`;
    const presence = mapped === "is_set" || mapped === "is_not_set";
    if (!presence && value === null) return `operator "${opRaw}" on "${c.field}" needs a value`;
    return { field, op: mapped, value: presence ? null : value };
  }
  if (field === "unsubscribed") {
    const truthy = value === "true" || value === "1";
    const falsy = value === "false" || value === "0";
    if (op === "is_true" || ((op === "equals" || op === "eq" || op === "is") && truthy))
      return { field, op: "is_true", value: null };
    if (op === "is_false" || ((op === "equals" || op === "eq" || op === "is") && falsy))
      return { field, op: "is_false", value: null };
    return `operator "${opRaw}" on "unsubscribed"`;
  }
  if (field === "created_at") {
    const mapped = DATE_OP_ALIASES[op];
    if (!mapped) return `operator "${opRaw}" on "created_at"`;
    if (value === null || Number.isNaN(Date.parse(value)))
      return `operator "${opRaw}" on "created_at" needs an ISO date`;
    return { field, op: mapped, value };
  }
  return `field "${c.field}"`;
}

/**
 * Best-effort mapping of a Resend segment filter (an undocumented object) to
 * the target shape. Anything not recognised yields `filter: null` and a reason;
 * the segment is still created and its memberships imported.
 */
export function translateSegmentFilter(filter: unknown): {
  filter: SegmentFilter | null;
  reason: string | null;
} {
  const f = asRecord(filter);
  if (!f) return { filter: null, reason: "filter is not an object" };
  const matchRaw = f.match ?? f.operator ?? f.logic ?? f.combinator ?? "all";
  const match = typeof matchRaw === "string" ? MATCH_ALIASES[matchRaw.toLowerCase()] : undefined;
  if (!match) return { filter: null, reason: `unknown match mode "${String(matchRaw)}"` };
  const rawConditions = f.conditions ?? f.filters ?? f.rules;
  if (!Array.isArray(rawConditions)) return { filter: null, reason: "filter has no conditions" };
  const conditions: SegmentCondition[] = [];
  for (const raw of rawConditions) {
    const result = translateCondition(raw);
    if (typeof result === "string") return { filter: null, reason: `unsupported ${result}` };
    conditions.push(result);
  }
  return { filter: { match, conditions }, reason: null };
}

/** Keeps the events the target emits (deduplicated, in input order); the rest are `dropped`. */
export function translateWebhookEvents(events: readonly string[]): {
  events: TargetWebhookEvent[];
  dropped: string[];
} {
  const kept = new Set<TargetWebhookEvent>();
  const dropped = new Set<string>();
  for (const event of events) {
    if ((TARGET_WEBHOOK_EVENTS as readonly string[]).includes(event)) {
      kept.add(event as TargetWebhookEvent);
    } else {
      dropped.add(event);
    }
  }
  return { events: [...kept], dropped: [...dropped] };
}

/**
 * No region: the target provisions every domain in the one SES region its
 * instance serves, and DNS records are regenerated regardless (DKIM keys are
 * per provider), so the Resend region has nothing to carry over.
 */
export interface DomainCreateInput {
  name: string;
  custom_return_path?: string;
}

/** PATCH /domains/{id} body applied right after the create. */
export interface DomainTrackingInput {
  open_tracking: boolean;
  click_tracking: boolean;
  tracking_subdomain?: string;
}

/**
 * Resend names the SPF/MX rows after the return-path label ("send", or
 * "bounces.updates" for updates.example.com); the target wants that first label.
 */
function returnPathLabel(domain: SourceDomain): string | null {
  if (domain.customReturnPath) return domain.customReturnPath;
  const spf = domain.records.find((r) => r.record === "SPF");
  if (!spf) return null;
  let name = spf.name.toLowerCase();
  if (name.endsWith(`.${domain.name.toLowerCase()}`)) name = name.slice(0, -domain.name.length - 1);
  const label = name.split(".")[0] ?? "";
  return label === "" || label === domain.name.toLowerCase() ? null : label;
}

export function domainCreateInput(domain: SourceDomain): {
  input: DomainCreateInput;
  tracking: DomainTrackingInput;
} {
  const tracking: DomainTrackingInput = {
    open_tracking: domain.openTracking,
    click_tracking: domain.clickTracking,
    ...(domain.trackingSubdomain ? { tracking_subdomain: domain.trackingSubdomain } : {}),
  };
  const label = returnPathLabel(domain);
  const input: DomainCreateInput = {
    name: domain.name,
    ...(label && label !== "send" ? { custom_return_path: label } : {}),
  };
  return { input, tracking };
}

export interface TemplateCreateInput {
  name: string;
  alias?: string;
  subject?: string;
  html: string;
  text?: string;
}

const listTokens = (tokens: string[]): string => tokens.join(", ");

export function templateCreateInput(t: SourceTemplate): {
  input: TemplateCreateInput | null;
  notes: string[];
  reason: string | null;
} {
  const notes: string[] = [];
  if (t.from) notes.push(`from ${t.from} is not stored on templates; pass it when sending`);
  if (t.replyTo?.length)
    notes.push(`reply_to ${t.replyTo.join(", ")} is not stored on templates; pass it when sending`);
  if (t.variables.length > 0)
    notes.push(
      `variables ${t.variables.map((v) => v.key).join(", ")} are not stored; merge fields resolve from contact properties`,
    );
  if (!t.html) return { input: null, notes, reason: "template has no html body" };
  const html = translateMergeTags(t.html);
  const subject = t.subject ? translateMergeTags(t.subject) : null;
  const text = t.text ? translateMergeTags(t.text) : null;
  const untranslated = [
    ...new Set([
      ...html.untranslated,
      ...(subject?.untranslated ?? []),
      ...(text?.untranslated ?? []),
    ]),
  ];
  if (untranslated.length > 0) notes.push(`merge tags left as-is: ${listTokens(untranslated)}`);
  const input: TemplateCreateInput = {
    name: t.name,
    ...(t.alias ? { alias: t.alias } : {}),
    ...(subject ? { subject: subject.html } : {}),
    html: html.html,
    ...(text ? { text: text.html } : {}),
  };
  return { input, notes, reason: null };
}

export interface BroadcastCreateInput {
  name: string;
  from: string;
  subject: string;
  html?: string;
  text?: string;
  reply_to?: string[];
  preview_text?: string;
  segment_id?: string;
  topic_id?: string;
}

/** Every broadcast lands as a draft; `ids` are the target's segment/topic ids when already known. */
export function broadcastCreateInput(
  b: SourceBroadcast,
  ids: { segmentId: string | null; topicId: string | null },
): { input: BroadcastCreateInput | null; notes: string[]; reason: string | null } {
  const notes: string[] = [];
  if (b.status === "sent") notes.push("already sent on Resend; imported as a draft");
  else if (b.status === "scheduled" || b.scheduledAt)
    notes.push(
      `scheduled on Resend${b.scheduledAt ? ` for ${b.scheduledAt}` : ""}; imported as a draft — schedule it again`,
    );
  else if (b.status !== "draft") notes.push(`status ${b.status} on Resend; imported as a draft`);
  if (!b.html && !b.text) return { input: null, notes, reason: "broadcast has no body" };
  const html = b.html ? translateMergeTags(b.html) : null;
  const text = b.text ? translateMergeTags(b.text) : null;
  const subject = translateMergeTags(b.subject);
  const untranslated = [
    ...new Set([
      ...(html?.untranslated ?? []),
      ...(text?.untranslated ?? []),
      ...subject.untranslated,
    ]),
  ];
  if (untranslated.length > 0) notes.push(`merge tags left as-is: ${listTokens(untranslated)}`);
  const input: BroadcastCreateInput = {
    name: b.name,
    from: b.from,
    subject: subject.html,
    ...(html ? { html: html.html } : {}),
    ...(text ? { text: text.html } : {}),
    ...(b.replyTo?.length ? { reply_to: b.replyTo } : {}),
    ...(b.previewText ? { preview_text: b.previewText } : {}),
    ...(ids.segmentId ? { segment_id: ids.segmentId } : {}),
    ...(ids.topicId ? { topic_id: ids.topicId } : {}),
  };
  return { input, notes, reason: null };
}
