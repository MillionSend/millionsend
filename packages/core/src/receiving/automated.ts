/**
 * Why an automatic answer to a received message must not go out (RFC 3834
 * section 2 and the de facto auto-reply headers), or null; checked in this
 * order, the subject last because section 3.1.5 calls it no reliable marker.
 * Stored as received_emails.automated, so a reply to it drafts instead of
 * sending and two agents stop after one round.
 */

const AUTO_SUBJECT =
  /^(?:auto:|automatic reply|auto-reply|out of (?:the )?office|resposta autom[aá]tica|ausente\b|aus[eê]ncia\b|respuesta autom[aá]tica|fuera de la oficina|abwesenheitsnotiz|r[ée]ponse automatique)/i;
const NO_REPLY_LOCAL =
  /^(?:mailer-daemon|postmaster|no-?reply|do-?not-?reply|nao-?responda|noresponder|bounces?|notifications?)(?:[+._-]|$)/i;

export type AutomatedReason =
  | "null_sender"
  | "auto_submitted"
  | "precedence"
  | "mailing_list"
  | "suppress_requested"
  | "auto_reply"
  | "report"
  | "no_reply_address"
  | "auto_reply_subject";

export function automatedReason(p: {
  /** Lowercase header names to one-line values; a header present with no value maps to "". */
  headers: Readonly<Record<string, string>>;
  /** The envelope sender, "" for <>. */
  mailFrom: string;
  from: string;
  subject: string;
}): AutomatedReason | null {
  const h = (name: string) => (p.headers[name] ?? "").trim().toLowerCase();
  const has = (name: string) => p.headers[name] !== undefined;
  if (p.mailFrom === "") return "null_sender";
  if (h("auto-submitted") && h("auto-submitted") !== "no") return "auto_submitted";
  if (/^(?:bulk|list|junk|auto_reply)$/.test(h("precedence"))) return "precedence";
  if (["list-id", "list-unsubscribe", "list-post", "list-help"].some(has)) return "mailing_list";
  if (/\b(?:all|autoreply|oof)\b/.test(h("x-auto-response-suppress"))) return "suppress_requested";
  if (["x-autoreply", "x-autorespond", "x-autoreply-from", "x-mail-autoreply"].some(has)) {
    return "auto_reply";
  }
  if (h("content-type").startsWith("multipart/report") || has("feedback-type")) return "report";
  if (p.from && NO_REPLY_LOCAL.test(p.from.slice(0, p.from.lastIndexOf("@")))) {
    return "no_reply_address";
  }
  if (AUTO_SUBJECT.test(p.subject.trim())) return "auto_reply_subject";
  return null;
}

/** The headers automatedReason reads, so a parse keeps only these. */
export const AUTOMATED_HEADERS = [
  "auto-submitted",
  "precedence",
  "list-id",
  "list-unsubscribe",
  "list-post",
  "list-help",
  "x-auto-response-suppress",
  "x-autoreply",
  "x-autorespond",
  "x-autoreply-from",
  "x-mail-autoreply",
  "content-type",
  "feedback-type",
] as const;
