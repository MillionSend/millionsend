import { escapeHtml, visibleText } from "../html.js";
import { extractLinks } from "../links.js";
import { extractAddrSpec, normalizeAddress } from "../suppressions.js";

/** RFC 5322's line limit, which also bounds one msg-id. */
const MSG_ID_MAX = 998;
/** References an inbox send carries: the thread token, then the newest parents. */
export const REFERENCES_MAX = 20;

/** The `<…>` msg-ids in header values, in order, each once. */
export function msgIds(values: string | readonly string[] | null | undefined): string[] {
  const text = typeof values === "string" ? values : (values ?? []).join(" ");
  const ids = text.match(/<[^<>\s]+>/g) ?? [];
  return [...new Set(ids.filter((id) => id.length <= MSG_ID_MAX))];
}

/** Lowercase bare address of a mailbox, the form recipients are compared in. */
export function addressKey(mailbox: string): string {
  return normalizeAddress(extractAddrSpec(mailbox));
}

/** Header names compare without case; one value per name, the latest kept. */
export function setHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): Record<string, string> {
  const out = Object.fromEntries(
    Object.entries(headers).filter(([k]) => k.toLowerCase() !== name.toLowerCase()),
  );
  out[name] = value;
  return out;
}

export function headerValue(
  headers: Readonly<Record<string, string>> | null | undefined,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  return Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === lower)?.[1];
}

/**
 * In-Reply-To and References for a reply to `parent` (RFC 5322 §3.6.4):
 * its References and Message-ID, newest last, leaving room for the thread
 * token the accept puts first.
 */
export function replyHeaders(parent: {
  messageId: string | null;
  references: readonly string[];
}): Record<string, string> {
  const messageId = msgIds(parent.messageId)[0];
  const refs = msgIds([...parent.references, ...(messageId ? [messageId] : [])]).slice(
    -(REFERENCES_MAX - 1),
  );
  return {
    ...(messageId ? { "In-Reply-To": messageId } : {}),
    ...(refs.length > 0 ? { References: refs.join(" ") } : {}),
  };
}

/** References led by the thread token, so a reply from any client proves its thread. */
export function withThreadToken(
  headers: Readonly<Record<string, string>>,
  token: string,
): Record<string, string> {
  const rest = msgIds(headerValue(headers, "References"))
    .filter((id) => id !== token)
    .slice(-(REFERENCES_MAX - 1));
  return setHeader({ ...headers }, "References", [token, ...rest].join(" "));
}

export function replySubject(subject: string | null): string {
  const s = (subject ?? "").trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`.trim();
}

export function forwardSubject(subject: string | null): string {
  const s = (subject ?? "").trim();
  return /^fwd?:/i.test(s) ? s : `Fwd: ${s}`.trim();
}

/** "Wed, Aug 5, 2026 at 2:03 PM", the style forwarded headers use; in UTC. */
export function forwardDate(at: Date): string {
  const part = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(at);
  return `${part({ weekday: "short" })}, ${part({ month: "short", day: "numeric", year: "numeric" })} at ${part({ hour: "numeric", minute: "2-digit", hour12: true })}`;
}

export const FORWARD_MARKER = "---------- Forwarded message ---------";

/** One message as a forward quotes it. */
export interface ForwardedOriginal {
  from: string;
  date: Date;
  subject: string | null;
  to: readonly string[];
  html: string | null;
  text: string | null;
}

/**
 * A forward's body: the note, then the original under Gmail's marker and
 * its From, Date, Subject and To lines. The HTML part exists when either
 * side has HTML; text bodies are escaped into it.
 */
export function forwardedMessage(
  note: { html: string | null; text: string | null },
  original: ForwardedOriginal,
): { html: string | null; text: string } {
  const lines = [
    FORWARD_MARKER,
    `From: ${original.from}`,
    `Date: ${forwardDate(original.date)}`,
    `Subject: ${original.subject ?? ""}`,
    `To: ${original.to.join(", ")}`,
  ];
  const noteText = note.text ?? (note.html ? visibleText(note.html) : "");
  const originalText = original.text ?? (original.html ? visibleText(original.html) : "");
  const text = `${noteText ? `${noteText}\n\n` : ""}${lines.join("\n")}\n\n${originalText}`;
  if (note.html === null && original.html === null) return { html: null, text };
  const asHtml = (value: string) => escapeHtml(value).replaceAll("\n", "<br>");
  const noteHtml = note.html ?? (note.text ? asHtml(note.text) : "");
  const html = `${noteHtml ? `${noteHtml}<br><br>` : ""}<div class="gmail_quote">${lines.map(asHtml).join("<br>")}<br><br>${original.html ?? asHtml(originalText)}</div>`;
  return { html, text };
}

/**
 * Who a reply goes to, Resend's rule: the answered message's Reply-To, else
 * its sender, or for mail the inbox sent, its recipients. reply_all copies
 * the other recipients into cc (the inbox's own addresses aside); bcc never.
 * The first field to name an address keeps it.
 */
export function replyRecipients(p: {
  target:
    | {
        direction: "inbound";
        from: string;
        replyTo: readonly string[];
        to: readonly string[];
        cc: readonly string[];
      }
    | { direction: "outbound"; to: readonly string[]; cc: readonly string[] };
  replyAll: boolean;
  own: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
}): { to: string[]; cc: string[]; bcc: string[] } {
  const { target } = p;
  const to =
    target.direction === "inbound"
      ? target.replyTo.length > 0
        ? target.replyTo
        : [target.from]
      : target.to;
  const own = new Set(p.own.map(addressKey));
  const copied = !p.replyAll
    ? []
    : target.direction === "inbound"
      ? [...target.to, ...target.cc]
      : target.cc;
  const seen = new Set<string>();
  const keep = (list: readonly string[]) =>
    list.filter((m) => {
      const key = addressKey(m);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return {
    to: keep(to),
    cc: keep([...copied.filter((m) => !own.has(addressKey(m))), ...p.cc]),
    bcc: keep(p.bcc),
  };
}

// The values a sent message could carry that the team received as a code,
// sign-in link or token, normalized the way received_secrets stores them:
// codes uppercase without separators, links without their fragment, tokens
// as the path segments and query values they are.
const CODE_CANDIDATE =
  /(?<![\p{L}\p{N}_@./:%$#-])([A-Z]-)?(\d{3}[ -]\d{3}|\d{4}[ -]\d{4}|\d{4,8}|[A-Z0-9]{4,8}|[A-Z0-9]{3,4}-[A-Z0-9]{3,4})(?![\p{L}\p{N}_@%]|[.,:/-]\p{N})/gu;
const TOKEN_RUN = /[A-Za-z0-9_.~%-]{20,}/g;
/** Bounds the MAC lookups one send costs; a body past it is checked on its first values. */
const SECRET_VALUES_MAX = 2000;

const tokenLike = (v: string) =>
  v.length >= 20 && /^[A-Za-z0-9_.~%-]+$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v);

function codeValue(raw: string): string | null {
  const v = raw.replace(/[ -]/g, "").toUpperCase();
  if (v.length < 4 || v.length > 8) return null;
  return /^\d+$/.test(v) || (/\d/.test(v) && /[A-Z]/.test(v)) ? v : null;
}

export function outgoingSecretValues(p: {
  subject: string;
  text: string | null;
  html: string | null;
}): string[] {
  const out = new Set<string>();
  const add = (v: string | null) => {
    if (v && out.size < SECRET_VALUES_MAX) out.add(v);
  };
  const prose = [p.subject, p.text ?? "", p.html ? visibleText(p.html) : ""].join("\n");
  for (const m of prose.matchAll(CODE_CANDIDATE)) add(codeValue(m[2] ?? ""));
  for (const m of prose.matchAll(TOKEN_RUN)) if (tokenLike(m[0])) add(m[0]);
  for (const link of extractLinks(p.html, [p.subject, p.text ?? ""].join("\n"))) {
    for (const value of [link.raw, link.href]) {
      if (!value || !/^https?:\/\//i.test(value)) continue;
      add(value.split("#")[0] ?? null);
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        continue;
      }
      for (const part of [...url.pathname.split("/"), ...url.searchParams.values()]) {
        if (tokenLike(part)) add(part);
      }
    }
  }
  return [...out];
}
