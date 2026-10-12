/**
 * Custom headers are allowlisted, not denylisted: mail leaves through a
 * shared SES identity, so a tenant must not be able to forge authentication
 * verdicts (Authentication-Results, ARC-*, Received-SPF), alternate senders
 * (Resent-*, Sender, Return-Path), read-receipt targets
 * (Disposition-Notification-To, Return-Receipt-To, Errors-To) or list
 * headers the transport owns. Allowed: any X-* header except the X-SES-* and
 * X-MillionSend-* families, plus this vetted set of threading/priority
 * headers. Matched case-insensitively; the worker still reassigns its own
 * headers last (defense in depth). Every surface that takes customer headers
 * (POST /emails, the SMTP relay) validates through customHeaderIssues.
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
export function hasHeaderControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}

export interface CustomHeaderIssue {
  /** The header the issue names, as the request spelled it. */
  header: string;
  message: string;
}

/** Why `headers` may not ride a send, in request order; empty when they all may. */
export function customHeaderIssues(headers: Readonly<Record<string, string>>): CustomHeaderIssue[] {
  const issues: CustomHeaderIssue[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME_RE.test(name)) {
      issues.push({ header: name, message: `"${name}" is not a valid header name` });
    } else if (!isAllowedHeaderName(name)) {
      issues.push({
        header: name,
        message: `"${name}" is not an allowed header; use ${ALLOWED_HEADERS_HINT}`,
      });
    }
    if (hasHeaderControlChar(value)) {
      issues.push({ header: name, message: `"${name}" value must not contain control characters` });
    }
    const unsubscribeIssue = unsubscribeHeaderIssue(name, value);
    if (unsubscribeIssue) issues.push({ header: name, message: unsubscribeIssue });
  }
  // RFC 8058: one-click needs both headers and an https target. Half a pair
  // would either ship without one-click or, on a topic send, collide with the
  // generated pair — so the two come together or not at all.
  const names = Object.keys(headers).map((n) => n.toLowerCase());
  const hasList = names.includes("list-unsubscribe");
  const hasPost = names.includes("list-unsubscribe-post");
  if (hasList !== hasPost) {
    issues.push({
      header: hasList ? "List-Unsubscribe" : "List-Unsubscribe-Post",
      message: "List-Unsubscribe and List-Unsubscribe-Post must be sent together",
    });
  }
  const listValue = Object.entries(headers).find(
    ([n]) => n.toLowerCase() === "list-unsubscribe",
  )?.[1];
  if (listValue !== undefined && !/<https:\/\//i.test(listValue)) {
    issues.push({
      header: "List-Unsubscribe",
      message:
        "List-Unsubscribe must include an <https://…> target (RFC 8058); mailto may only accompany it",
    });
  }
  return issues;
}
