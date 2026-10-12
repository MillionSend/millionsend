import { escapeHtml, visibleText } from "../html.js";
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
