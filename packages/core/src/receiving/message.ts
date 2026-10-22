import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { asc, eq, getTableColumns, inArray } from "drizzle-orm";
import {
  type AddressObject,
  type Attachment,
  type AttachmentStream,
  type EmailAddress,
  type HeaderLines,
  type Headers,
  MailParser,
  simpleParser,
} from "mailparser";
import { createSemaphore } from "../concurrency.js";
import {
  decryptPayload,
  type EncryptedBody,
  type EnvelopeOwner,
  encryptPayload,
  packEnvelope,
  unpackEnvelope,
} from "../crypto/envelope.js";
import type { Keyring } from "../crypto/keyring.js";
import { dropInvisible, visibleLine } from "../customer-text.js";
import type {
  QuarantineReason,
  ScreeningVerdict,
  ScreeningWire,
  SenderTrust,
  SpamVerdict,
  VirusVerdict,
} from "../inboxes/types.js";
import { hiddenTextRemoved, screeningWire } from "../inboxes/wire.js";
import { routableAddress } from "../sender-address.js";
import { AUTOMATED_HEADERS } from "./automated.js";
import { type DownloadSigning, signReceivedDownload } from "./downloads.js";
import { MAX_RECEIVED_MESSAGE_BYTES } from "./protocol.js";
import { READ_BODY_MAX_CHARS } from "./read.js";

export type ReceivedEmailRow = typeof schema.receivedEmails.$inferSelect;

const { rawCiphertext, rawIv, rawWrappedDek, extracted, ...metaColumns } = getTableColumns(
  schema.receivedEmails,
);

/**
 * Every received_emails column but the sealed raw message (up to 40 MiB a
 * row) and the sealed extracted read: what lists, webhooks and attachment
 * records select. Only a GET of one email and the downloads need the full row.
 */
export const RECEIVED_EMAIL_META_COLUMNS = metaColumns;

export type ReceivedEmailMeta = Omit<
  ReceivedEmailRow,
  "rawCiphertext" | "rawIv" | "rawWrappedDek" | "extracted"
>;

/** One attachment as the sealed list records it. */
export interface ReceivedAttachment {
  /** Stable for the life of the row: derived from the row id and the index. */
  id: string;
  /** Position among the message's attachments in parse order; how the bytes are found again. */
  index: number;
  filename: string | null;
  contentType: string;
  size: number;
  contentDisposition: "inline" | "attachment" | null;
  /** Content-ID without its angle brackets: what `cid:` references in the HTML name. */
  contentId: string | null;
}

/**
 * What ingest reads out of a raw message. Every value is cleaned for storage
 * and echo (one line, no controls or invisible characters, addresses that
 * parse as local@domain), so nothing header-shaped from a stranger reaches a
 * JSON payload, a dashboard cell or a log intact.
 */
export interface ReceivedMetadata {
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  messageId: string | null;
  attachments: Omit<ReceivedAttachment, "id">[];
  /** The From display name, one visible line. */
  fromName: string;
  /** In-Reply-To's first msg-id. */
  inReplyTo: string | null;
  /** References' msg-ids (at most 50), then bare ms1. thread tokens some clients write unbracketed. */
  references: string[];
  /** From fields in the header, and mailboxes in the one the parser kept; 0 when the address kept is not written in it. */
  fromFields: number;
  fromMailboxes: number;
  hasDate: boolean;
  /** The headers automatedReason reads, present ones only, values on one line. */
  automatedHeaders: Record<string, string>;
  /** At most READ_BODY_MAX_CHARS of each body part; bodyTruncated when either was longer. */
  html: string | null;
  bodyTruncated: boolean;
  text: string | null;
}

const EMPTY_METADATA: ReceivedMetadata = {
  from: null,
  to: [],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: "",
  messageId: null,
  attachments: [],
  fromName: "",
  inReplyTo: null,
  references: [],
  fromFields: 0,
  fromMailboxes: 0,
  hasDate: false,
  automatedHeaders: {},
  html: null,
  bodyTruncated: false,
  text: null,
};

/** MIME parses in flight per process: each can hold a 40 MiB message several times over. */
const PARSE_CONCURRENCY = 4;
// ponytail: per process, not per instance; a shared queue is the upgrade if
// several API replicas end up parsing at once.
const parseSlot = createSemaphore(PARSE_CONCURRENCY);
/** A parse that has not finished by now is abandoned; the message is still stored. */
const PARSE_TIMEOUT_MS = 30_000;

const TEXT_ONLY = { skipHtmlToText: true, skipTextToHtml: true, skipTextLinks: true } as const;

/**
 * Longest HTML a data_uri read builds: the largest message accepted. Each
 * image's data URL repeats at every `cid:` naming it, so a small message
 * quoting one image hundreds of times would otherwise inflate to gigabytes
 * in memory. Past it the cid form is served, as Resend does past 100 MB.
 */
const MAX_INLINED_HTML_CHARS = MAX_RECEIVED_MESSAGE_BYTES;

/** mailparser's `cid:` reference syntax and the image types it inlines. */
const CID_REFERENCE = /\bcid:([^'"\s]{1,256})/g;
const INLINE_IMAGE_TYPE = /^image\/[\w]+$/i;

const CONTENT_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

/** The attachment id a row's `index`-th attachment always gets (a hash-derived RFC 9562 v8 uuid). */
export function receivedAttachmentId(emailId: string, index: number): string {
  const b = createHash("sha256").update(`${emailId}:attachment:${index}`).digest();
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x80, 6);
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const h = b.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function attachmentEntry(data: AttachmentStream, index: number): Omit<ReceivedAttachment, "id"> {
  const filename = data.filename ? visibleLine(data.filename, 255).replace(/[\\/]/g, "_") : "";
  const disposition = data.contentDisposition;
  return {
    index,
    filename: filename || null,
    contentType: CONTENT_TYPE_RE.test(data.contentType ?? "")
      ? data.contentType.toLowerCase()
      : "application/octet-stream",
    size: 0,
    contentDisposition:
      disposition === "inline" || disposition === "attachment" ? disposition : null,
    contentId: (data.cid && visibleLine(data.cid, 255)) || null,
  };
}

interface Walk {
  headers: Headers | undefined;
  headerLines: HeaderLines;
  attachments: Omit<ReceivedAttachment, "id">[];
  /** The bytes of the attachment at the requested index, when one was asked for. */
  captured: Buffer | null;
  html: string | null;
  text: string | null;
}

/**
 * One streaming pass over a message: headers and every attachment's
 * metadata, buffering at most the one attachment asked for.
 */
function walk(raw: Buffer, captureIndex?: number): Promise<Walk> {
  return new Promise((resolve, reject) => {
    const parser = new MailParser({ ...TEXT_ONLY, skipImageLinks: true });
    const result: Walk = {
      headers: undefined,
      headerLines: [],
      attachments: [],
      captured: null,
      html: null,
      text: null,
    };
    const timer = setTimeout(() => {
      parser.destroy();
      reject(new Error("mime parse timed out"));
    }, PARSE_TIMEOUT_MS);
    timer.unref();
    parser.on("headers", (headers) => {
      result.headers = headers;
    });
    parser.on("headerLines", (lines: HeaderLines) => {
      result.headerLines = lines;
    });
    parser.on("data", (data) => {
      if (data.type === "text") {
        result.html = typeof data.html === "string" ? data.html : null;
        result.text = typeof data.text === "string" ? data.text : null;
        return;
      }
      if (data.type !== "attachment") return;
      const entry = attachmentEntry(data, result.attachments.length);
      result.attachments.push(entry);
      const chunks: Buffer[] = [];
      data.content.on("data", (chunk: Buffer) => {
        entry.size += chunk.length;
        if (entry.index === captureIndex) chunks.push(chunk);
      });
      data.content.on("end", () => {
        if (entry.index === captureIndex) result.captured = Buffer.concat(chunks);
        data.release();
      });
    });
    parser.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    parser.once("end", () => {
      clearTimeout(timer);
      resolve(result);
    });
    parser.end(raw);
  });
}

function addresses(value: unknown): string[] {
  const objects = (Array.isArray(value) ? value : value ? [value] : []) as AddressObject[];
  const out = new Set<string>();
  const visit = (entries: EmailAddress[]) => {
    for (const entry of entries) {
      if (entry.group) visit(entry.group);
      const parsed = entry.address ? routableAddress(entry.address) : null;
      if (parsed) out.add(parsed.address);
    }
  };
  for (const object of objects) if (Array.isArray(object?.value)) visit(object.value);
  return [...out];
}

function headerText(headers: Headers | undefined, key: string, max: number): string {
  const value = headers?.get(key);
  return typeof value === "string" ? visibleLine(value, max) : "";
}

/** A header line's value, unfolded, as mailsplit hands it over (latin1 for raw UTF-8). */
function lineValue(line: string): string {
  const bytes = Buffer.from(line.slice(line.indexOf(":") + 1), "latin1");
  return bytes.toString(isUtf8(bytes) ? "utf8" : "latin1").replace(/\r?\n[ \t]/g, " ");
}

// A msg-id as stored: printable ASCII without angle brackets inside, so a
// header-shaped value can never carry a line break into anything built from it.
const MSG_ID = /<[\x21-\x3b\x3d\x3f-\x7e]{3,996}>/g;
const BARE_TOKEN = /(?<![<\w.])ms1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}@[A-Za-z0-9.-]{1,253}/g;
const MAX_REFERENCES = 50;

/** Mailboxes in a parsed address header, group members counted. */
function mailboxCount(value: unknown): number {
  const objects = (Array.isArray(value) ? value : value ? [value] : []) as AddressObject[];
  let n = 0;
  const visit = (entries: EmailAddress[]) => {
    for (const entry of entries) {
      if (entry.group) visit(entry.group);
      else n++;
    }
  };
  for (const object of objects) if (Array.isArray(object?.value)) visit(object.value);
  return n;
}

/**
 * Whether a From line spells out `address` itself. mailparser before 3.9.40
 * decoded an encoded-word display name and parsed the result again, so
 * "=?utf-8?B?…?=: eve@evil.example;" yielded an address that no DMARC
 * check read (RFC 2047 §5 keeps encoded words out of addresses).
 */
function writtenIn(lines: readonly string[], address: string): boolean {
  const wanted = address.toLowerCase();
  return lines.some((line) =>
    line
      .split(/[\s<>(),;:"]+/)
      .some((token) => routableAddress(token)?.address.toLowerCase() === wanted),
  );
}

function displayName(value: unknown): string {
  const object = (Array.isArray(value) ? value[0] : value) as AddressObject | undefined;
  const first = Array.isArray(object?.value) ? object.value[0] : undefined;
  return visibleLine(first?.name ?? "", 256);
}

/**
 * Metadata for storage, parsed with mailparser, and the HTML and text the
 * read pipeline takes, from the same streaming pass. Never throws: a message
 * that does not parse (malformed MIME, a parser error, a timeout) is still
 * stored, with empty metadata, and its raw bytes stay downloadable.
 */
export async function parseReceivedMetadata(raw: Buffer): Promise<ReceivedMetadata> {
  try {
    const { headers, headerLines, attachments, html, text } = await parseSlot(() => walk(raw));
    const lines = (key: string) =>
      headerLines.filter((l) => l.key === key).map((l) => lineValue(l.line));
    const inReplyTo = lines("in-reply-to").join(" ").match(MSG_ID)?.[0] ?? null;
    const refs = lines("references").join(" ");
    const ids = refs.match(MSG_ID) ?? [];
    // Our thread token leads References, and a long chain must not push it out.
    const tokens = [
      ...ids.filter((id) => id.startsWith("<ms1.")),
      ...(`${lines("in-reply-to").join(" ")} ${refs}`.replace(MSG_ID, " ").match(BARE_TOKEN) ?? []),
    ].slice(0, 5);
    const references = [...new Set([...tokens, ...ids.slice(-(MAX_REFERENCES - tokens.length))])];
    const automatedHeaders: Record<string, string> = {};
    for (const name of AUTOMATED_HEADERS) {
      const values = lines(name);
      if (values.length > 0) automatedHeaders[name] = visibleLine(values.join(", "), 998);
    }
    const capped = (body: string | null) => body?.slice(0, READ_BODY_MAX_CHARS) || null;
    const from = addresses(headers?.get("from"))[0] ?? null;
    const fromLines = lines("from");
    return {
      from,
      to: addresses(headers?.get("to")),
      cc: addresses(headers?.get("cc")),
      bcc: addresses(headers?.get("bcc")),
      replyTo: addresses(headers?.get("reply-to")),
      subject: headerText(headers, "subject", 998),
      messageId: headerText(headers, "message-id", 998) || null,
      attachments,
      fromName: displayName(headers?.get("from")),
      inReplyTo,
      references,
      fromFields: fromLines.length,
      fromMailboxes:
        from !== null && writtenIn(fromLines, from) ? mailboxCount(headers?.get("from")) : 0,
      hasDate: lines("date").length > 0,
      automatedHeaders,
      html: capped(html),
      bodyTruncated: Math.max(html?.length ?? 0, text?.length ?? 0) > READ_BODY_MAX_CHARS,
      text: capped(text),
    };
  } catch {
    return EMPTY_METADATA;
  }
}

export function sealReceivedRaw(
  raw: Buffer,
  keyring: Keyring,
  owner: EnvelopeOwner,
): Promise<EncryptedBody> {
  return encryptPayload(raw, keyring, { ...owner, kind: "received_raw" });
}

export async function sealReceivedAttachments(
  attachments: readonly ReceivedAttachment[],
  keyring: Keyring,
  owner: EnvelopeOwner,
): Promise<string> {
  return packEnvelope(
    await encryptPayload(Buffer.from(JSON.stringify(attachments), "utf8"), keyring, {
      ...owner,
      kind: "received_attachments",
    }),
  );
}

const ownerOf = (row: ReceivedEmailMeta): EnvelopeOwner => ({ teamId: row.teamId, rowId: row.id });

/** The raw RFC 822 bytes, or null once the content retention purge emptied the row. */
export async function openReceivedRaw(
  row: ReceivedEmailRow,
  keyring: Keyring,
): Promise<Buffer | null> {
  if (!row.rawCiphertext || !row.rawIv || !row.rawWrappedDek || row.rawKeyVersion === null) {
    return null;
  }
  return decryptPayload(
    {
      ciphertext: row.rawCiphertext,
      iv: row.rawIv,
      wrappedDek: row.rawWrappedDek,
      keyVersion: row.rawKeyVersion,
    },
    keyring,
    { ...ownerOf(row), kind: "received_raw" },
  );
}

/** The read pipeline's output, sealed as received_emails.extracted. */
export interface ReceivedExtracted {
  text: string;
  quoted: string;
  signature: string;
  code: { kind: "otp"; value: string } | { ambiguous: true } | null;
  link: { url: string; linkDomainMatchesSender: boolean } | { ambiguous: true } | null;
  flags: string[];
}

export async function sealReceivedExtracted(
  extracted: ReceivedExtracted,
  keyring: Keyring,
  owner: EnvelopeOwner,
): Promise<string> {
  return packEnvelope(
    await encryptPayload(Buffer.from(JSON.stringify(extracted), "utf8"), keyring, {
      ...owner,
      kind: "received_extracted",
    }),
  );
}

/** The sealed extracted read, or null when there is none or the content purge emptied it. */
export async function openReceivedExtracted(
  row: { teamId: string; id: string; extracted: string | null },
  keyring: Keyring,
): Promise<ReceivedExtracted | null> {
  if (!row.extracted) return null;
  const plaintext = await decryptPayload(unpackEnvelope(row.extracted), keyring, {
    teamId: row.teamId,
    rowId: row.id,
    kind: "received_extracted",
  });
  return JSON.parse(plaintext.toString("utf8")) as ReceivedExtracted;
}

/** The sealed attachment list; empty once purged. */
export async function openReceivedAttachments(
  row: ReceivedEmailMeta,
  keyring: Keyring,
): Promise<ReceivedAttachment[]> {
  if (!row.attachments) return [];
  const plaintext = await decryptPayload(unpackEnvelope(row.attachments), keyring, {
    ...ownerOf(row),
    kind: "received_attachments",
  });
  return JSON.parse(plaintext.toString("utf8")) as ReceivedAttachment[];
}

/**
 * One attachment's metadata and bytes, or null when the id is unknown or the
 * content was purged. Parses the raw message, buffering only that attachment.
 */
export async function openReceivedAttachment(
  row: ReceivedEmailRow,
  keyring: Keyring,
  attachmentId: string,
): Promise<{ attachment: ReceivedAttachment; content: Buffer } | null> {
  const attachment = (await openReceivedAttachments(row, keyring)).find(
    (a) => a.id === attachmentId,
  );
  if (!attachment) return null;
  const raw = await openReceivedRaw(row, keyring);
  if (!raw) return null;
  const { captured } = await parseSlot(() => walk(raw, attachment.index));
  return captured ? { attachment, content: captured } : null;
}

/** SES's verdict words, which Resend's `authentication` reports, from mailauth's results. */
const RESEND_VERDICT: Record<string, string> = {
  pass: "pass",
  fail: "fail",
  softfail: "gray",
  neutral: "gray",
  none: "gray",
  policy: "gray",
  temperror: "processing_failed",
  permerror: "processing_failed",
};

const resendVerdict = (result: string | undefined) =>
  (result && RESEND_VERDICT[result]) || "unknown";

/** Resend's InboundAttachment, as list items and GET /emails/receiving/{id} embed it. */
export interface InboundAttachmentWire {
  id: string;
  filename: string | null;
  content_type: string;
  content_id: string | null;
  content_disposition: string | null;
  size: number;
}

/** Resend's ListReceivingEmail. */
export interface ReceivedEmailListItem {
  id: string;
  to: string[];
  from: string;
  created_at: string;
  subject: string;
  bcc: string[];
  cc: string[];
  reply_to: string[];
  received_for: string[];
  message_id: string;
  attachments: InboundAttachmentWire[];
}

/** Resend's GetReceivingEmailResponseSuccess, plus the documented html_format and authentication. */
export interface ReceivedEmailDetail {
  object: "email";
  id: string;
  to: string[];
  from: string;
  created_at: string;
  subject: string;
  html: string | null;
  html_format: "data_uri" | "cid";
  text: string | null;
  headers: Record<string, string> | null;
  bcc: string[];
  cc: string[];
  reply_to: string[];
  received_for: string[];
  authentication: { spf: string; dkim: string; dmarc: string };
  message_id: string;
  raw: { download_url: string; expires_at: string } | null;
  attachments: InboundAttachmentWire[];
}

/** Resend's AttachmentData, as the attachment endpoints return it. */
export interface AttachmentDataWire {
  id: string;
  filename?: string;
  size: number;
  content_type: string;
  content_disposition: "inline" | "attachment";
  content_id?: string;
  download_url: string;
  expires_at: string;
}

const inboundAttachment = (a: ReceivedAttachment): InboundAttachmentWire => ({
  id: a.id,
  filename: a.filename,
  content_type: a.contentType,
  content_id: a.contentId,
  content_disposition: a.contentDisposition,
  size: a.size,
});

function listItem(
  row: ReceivedEmailMeta,
  attachments: ReceivedAttachment[],
): ReceivedEmailListItem {
  return {
    id: row.id,
    to: row.to,
    from: row.from,
    created_at: row.createdAt.toISOString(),
    subject: row.subject,
    bcc: row.bcc,
    cc: row.cc,
    reply_to: row.replyTo,
    received_for: row.receivedFor,
    message_id: row.messageId,
    attachments: attachments.map(inboundAttachment),
  };
}

/** GET /emails/receiving item; opens only the sealed attachment list, never the raw message. */
export async function receivedEmailListItem(
  row: ReceivedEmailMeta,
  keyring: Keyring,
): Promise<ReceivedEmailListItem> {
  return listItem(row, await openReceivedAttachments(row, keyring));
}

/**
 * Top-level headers as Resend's Record<string, string>: lowercase names,
 * unfolded one-line values, repeated headers (Received) joined by "\n". A
 * prototype-less object, so a header named __proto__ is just a key.
 */
function headerRecord(lines: HeaderLines): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const { key, line } of lines) {
    const name = visibleLine(key, 128).toLowerCase();
    if (!name) continue;
    // mailsplit hands lines over as latin1: raw UTF-8 (SMTPUTF8 senders) reads
    // back as UTF-8, and bytes that are not UTF-8 stay latin1, as it decodes them.
    const bytes = Buffer.from(line.slice(line.indexOf(":") + 1), "latin1");
    const value = visibleLine(bytes.toString(isUtf8(bytes) ? "utf8" : "latin1"), 16_384);
    out[name] = name in out ? `${out[name]}\n${value}` : value;
  }
  return out;
}

/**
 * The envelope sender as Return-Path when the message carries none, as the
 * receiving server adds it: the MX prepends nothing, so retries keep
 * deduplicating on the exact bytes. `<>` marks a bounce.
 */
function withReturnPath(headers: Record<string, string>, row: ReceivedEmailMeta) {
  headers["return-path"] ??= `<${row.envelope.mailFrom}>`;
  return headers;
}

/**
 * The HTML with every `cid:` image reference replaced by the image as a data
 * URL, as mailparser inlines them, or null when the result would pass
 * `maxChars`; measured before any data URL is built.
 */
export function inlineCidImages(
  html: string,
  attachments: readonly Attachment[],
  maxChars = MAX_INLINED_HTML_CHARS,
): string | null {
  const images = new Map<string, Attachment | undefined>();
  const imageFor = (cid: string) => {
    if (!images.has(cid)) {
      images.set(
        cid,
        attachments.find((a) => a.cid === cid && INLINE_IMAGE_TYPE.test(a.contentType)),
      );
    }
    return images.get(cid);
  };
  let chars = html.length;
  for (const [reference, cid = ""] of html.matchAll(CID_REFERENCE)) {
    const image = imageFor(cid);
    if (!image) continue;
    chars += `data:${image.contentType};base64,`.length + Math.ceil(image.content.length / 3) * 4;
    chars -= reference.length;
    if (chars > maxChars) return null;
  }
  const urls = new Map<string, string>();
  return html.replace(CID_REFERENCE, (reference, cid: string) => {
    const image = imageFor(cid);
    if (!image) return reference;
    let url = urls.get(cid);
    if (url === undefined) {
      url = `data:${image.contentType};base64,${image.content.toString("base64")}`;
      urls.set(cid, url);
    }
    return url;
  });
}

/**
 * GET /emails/receiving/{id}. HTML, text and headers come from parsing the
 * raw message; `data_uri` (Resend's default) inlines `cid:` images, `cid`
 * leaves the references, and so does a message whose inlined HTML would pass
 * MAX_INLINED_HTML_CHARS (`html_format` then reads `cid`). A message that does
 * not parse still answers, with null content and its raw download.
 */
export async function receivedEmailDetail(
  row: ReceivedEmailRow,
  keyring: Keyring,
  options: { htmlFormat: "data_uri" | "cid"; downloads: DownloadSigning },
): Promise<ReceivedEmailDetail> {
  const [attachments, raw] = await Promise.all([
    openReceivedAttachments(row, keyring),
    openReceivedRaw(row, keyring),
  ]);
  let content: Pick<ReceivedEmailDetail, "html" | "html_format" | "text" | "headers"> = {
    html: null,
    html_format: options.htmlFormat,
    text: null,
    headers: null,
  };
  if (raw) {
    try {
      content = await parseSlot(async () => {
        const parsed = await simpleParser(raw, { ...TEXT_ONLY, keepCidLinks: true });
        let html = parsed.html || null;
        let htmlFormat = options.htmlFormat;
        if (html && htmlFormat === "data_uri") {
          const inlined = inlineCidImages(html, parsed.attachments);
          if (inlined === null) htmlFormat = "cid";
          else html = inlined;
        }
        const headers = headerRecord(parsed.headerLines ?? []);
        return {
          html,
          html_format: htmlFormat,
          // Invisible characters out, line breaks kept; html stays byte for byte.
          text: parsed.text ? dropInvisible(parsed.text) : null,
          headers: Object.keys(headers).length > 0 ? withReturnPath(headers, row) : null,
        };
      });
    } catch {
      // Malformed MIME: the raw download below is the way to its bytes.
    }
  }
  // SECURITY: mail carrying malware is never served whole, released or not.
  const signed =
    raw && row.virusVerdict !== "fail"
      ? signReceivedDownload({ ...options.downloads, teamId: row.teamId, emailId: row.id })
      : null;
  const item = listItem(row, attachments);
  return {
    object: "email",
    id: item.id,
    to: item.to,
    from: item.from,
    created_at: item.created_at,
    subject: item.subject,
    html: content.html,
    html_format: content.html_format,
    text: content.text,
    headers: content.headers,
    bcc: item.bcc,
    cc: item.cc,
    reply_to: item.reply_to,
    received_for: item.received_for,
    authentication: {
      spf: resendVerdict(row.authentication.spf),
      dkim: resendVerdict(row.authentication.dkim),
      dmarc: resendVerdict(row.authentication.dmarc),
    },
    message_id: item.message_id,
    raw: signed ? { download_url: signed.url, expires_at: signed.expiresAt.toISOString() } : null,
    attachments: item.attachments,
  };
}

function attachmentData(
  row: ReceivedEmailMeta,
  a: ReceivedAttachment,
  downloads: DownloadSigning,
): AttachmentDataWire {
  const signed = signReceivedDownload({
    ...downloads,
    teamId: row.teamId,
    emailId: row.id,
    attachmentId: a.id,
  });
  return {
    id: a.id,
    ...(a.filename ? { filename: a.filename } : {}),
    size: a.size,
    content_type: a.contentType,
    content_disposition: a.contentDisposition === "inline" ? "inline" : "attachment",
    ...(a.contentId ? { content_id: a.contentId } : {}),
    download_url: signed.url,
    expires_at: signed.expiresAt.toISOString(),
  };
}

/** GET /emails/receiving/{email_id}/attachments; empty once the content is purged. */
export async function receivedEmailAttachments(
  row: ReceivedEmailMeta,
  keyring: Keyring,
  downloads: DownloadSigning,
): Promise<AttachmentDataWire[]> {
  return (await openReceivedAttachments(row, keyring)).map((a) =>
    attachmentData(row, a, downloads),
  );
}

/** GET /emails/receiving/{email_id}/attachments/{id}; null when the id is not one of the row's. */
export async function receivedEmailAttachment(
  row: ReceivedEmailMeta,
  keyring: Keyring,
  attachmentId: string,
  downloads: DownloadSigning,
): Promise<AttachmentDataWire | null> {
  const attachment = (await openReceivedAttachments(row, keyring)).find(
    (a) => a.id === attachmentId,
  );
  return attachment ? attachmentData(row, attachment, downloads) : null;
}

/**
 * `data` of the email.received webhook, exactly Resend's: metadata only, no
 * body, headers or attachment sizes, `from` a bare address.
 */
export function receivedEmailEventData(
  row: ReceivedEmailMeta,
  attachments: readonly ReceivedAttachment[],
): Record<string, unknown> {
  return {
    email_id: row.id,
    created_at: row.createdAt.toISOString(),
    from: row.from,
    to: row.to,
    bcc: row.bcc,
    cc: row.cc,
    received_for: row.receivedFor,
    message_id: row.messageId,
    subject: row.subject,
    attachments: attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      content_type: a.contentType,
      content_disposition: a.contentDisposition,
      content_id: a.contentId,
    })),
  };
}

/** One of a received row's inbox memberships, as reads show it. */
export interface ReceivedMembershipView {
  inboxId: string;
  threadId: string;
  verdict: ScreeningVerdict;
  senderTrust: SenderTrust;
  quarantineReason: QuarantineReason | null;
  reasons: string[];
  injectionScore: number | null;
  phishingScore: number | null;
  readAt: Date | null;
  deliveredAt: Date | null;
  /** Its inbox serves codes and links (safety.extract_codes). */
  extractCodes: boolean;
}

/** The memberships of these rows, each row's in its inboxes' creation order. */
export async function receivedMemberships(
  db: Db,
  rowIds: readonly string[],
): Promise<Map<string, ReceivedMembershipView[]>> {
  const out = new Map<string, ReceivedMembershipView[]>();
  if (rowIds.length === 0) return out;
  const m = schema.receivedEmailInboxes;
  const i = schema.inboxes;
  const rows = await db
    .select({
      receivedEmailId: m.receivedEmailId,
      inboxId: m.inboxId,
      threadId: m.threadId,
      verdict: m.verdict,
      senderTrust: m.senderTrust,
      quarantineReason: m.quarantineReason,
      reasons: m.reasons,
      injectionScore: m.injectionScore,
      phishingScore: m.phishingScore,
      readAt: m.readAt,
      deliveredAt: m.deliveredAt,
      safety: i.safety,
    })
    .from(m)
    .innerJoin(i, eq(i.id, m.inboxId))
    .where(inArray(m.receivedEmailId, [...rowIds]))
    .orderBy(asc(i.createdAt), asc(i.id));
  for (const { receivedEmailId, safety, ...membership } of rows) {
    const list = out.get(receivedEmailId) ?? [];
    list.push({ ...membership, extractCodes: safety.extract_codes });
    out.set(receivedEmailId, list);
  }
  return out;
}

type RowFacts = Pick<
  ReceivedEmailMeta,
  | "senderTrust"
  | "spamVerdict"
  | "spamScore"
  | "virusVerdict"
  | "virusSignature"
  | "releasedAt"
  | "hiddenText"
  | "extractedKinds"
>;

/** A row that reached no inbox: held for a virus until released, else suspicious or clean by its facts. */
function rowVerdict(row: RowFacts): ScreeningVerdict {
  if (row.virusVerdict === "fail") return row.releasedAt ? "released" : "quarantined";
  return row.senderTrust === "unauthenticated" ||
    row.senderTrust === "failed" ||
    row.spamVerdict === "gray" ||
    row.spamVerdict === "fail" ||
    row.virusVerdict === "processing_failed"
    ? "suspicious"
    : "clean";
}

/** Whose read this is: an inbox in context (an inbox-scoped key, an inbox_id filter), and whether an agent reads. */
export interface ReceivedReadView {
  inboxId: string | null;
  /** Inbox-scoped keys and MCP tokens: held memberships are never theirs to see. */
  agent: boolean;
}

/** The membership a read is about: the inbox in context, else the first by inbox age; agents see delivered ones only. */
export function chosenMembership(
  memberships: readonly ReceivedMembershipView[],
  view: ReceivedReadView,
): { chosen: ReceivedMembershipView | null; shown: ReceivedMembershipView[] } {
  const shown = view.agent ? memberships.filter((m) => m.deliveredAt !== null) : [...memberships];
  const chosen = view.inboxId
    ? (shown.find((m) => m.inboxId === view.inboxId) ?? null)
    : (shown[0] ?? null);
  return { chosen, shown };
}

/**
 * Why an agent may not read a row: "quarantined" (403, it may learn the id
 * is held) or "pending" (404, still being screened, or no membership in its
 * inbox); null when the row is visible to it.
 */
export function heldFrom(
  row: Pick<ReceivedEmailMeta, "catchAll" | "virusVerdict" | "releasedAt">,
  memberships: readonly ReceivedMembershipView[],
  inboxId: string | null,
): "pending" | "quarantined" | null {
  const relevant = inboxId ? memberships.filter((m) => m.inboxId === inboxId) : memberships;
  if (relevant.some((m) => m.deliveredAt !== null)) return null;
  const virusHeld = row.virusVerdict === "fail" && !row.releasedAt;
  // The catch-all copy shows nothing an inbox holds (every membership here is
  // held) unless a person released it.
  if (!inboxId && row.catchAll && (row.releasedAt || (!virusHeld && relevant.length === 0))) {
    return null;
  }
  if (virusHeld || relevant.some((m) => m.verdict === "quarantined")) return "quarantined";
  return "pending";
}

/** MillionSend's keys on a GET /emails/receiving list item. */
export interface ReceivedListExtras {
  inbox_id: string | null;
  thread_id: string | null;
  /** Owner views only. */
  inboxes?: { inbox_id: string; thread_id: string; verdict: ScreeningVerdict }[];
  screening: { verdict: ScreeningVerdict; sender_trust: SenderTrust };
  spam_verdict: SpamVerdict | null;
  virus_verdict: VirusVerdict | null;
  extracted: { kinds: ("code" | "link")[] };
  /** With an inbox in context. */
  read?: boolean;
}

export function receivedListExtras(
  row: RowFacts,
  memberships: readonly ReceivedMembershipView[],
  view: ReceivedReadView,
): ReceivedListExtras {
  const { chosen, shown } = chosenMembership(memberships, view);
  return {
    inbox_id: chosen?.inboxId ?? null,
    thread_id: chosen?.threadId ?? null,
    ...(view.agent
      ? {}
      : {
          inboxes: shown.map((m) => ({
            inbox_id: m.inboxId,
            thread_id: m.threadId,
            verdict: m.verdict,
          })),
        }),
    screening: {
      verdict: chosen?.verdict ?? rowVerdict(row),
      sender_trust: chosen?.senderTrust ?? row.senderTrust,
    },
    spam_verdict: row.spamVerdict,
    virus_verdict: row.virusVerdict,
    extracted: { kinds: row.extractedKinds },
    ...(view.inboxId ? { read: chosen?.readAt != null } : {}),
  };
}

/** extracted as GET /emails/receiving/{id} shows it: the code and link only where they may be served. */
export interface ExtractedWire {
  kinds: ("code" | "link")[];
  code: string | null;
  link: string | null;
  link_domain_matches_sender: boolean | null;
  ambiguous: boolean;
}

/**
 * MillionSend's keys on GET /emails/receiving/{id}. The code and link are
 * served only from delivered mail of a sender that did not fail
 * authentication, in an inbox that extracts codes; `codeServed` says one
 * was, for the code.read activity.
 */
export async function receivedDetailExtras(
  row: RowFacts & { teamId: string; id: string; extracted: string | null; catchAll: boolean },
  memberships: readonly ReceivedMembershipView[],
  view: ReceivedReadView,
  keyring: Keyring,
): Promise<{
  extras: Record<string, unknown>;
  codeServed: { inboxId: string; threadId: string } | null;
}> {
  const { chosen } = chosenMembership(memberships, view);
  const list = receivedListExtras(row, memberships, view);
  const screening: ScreeningWire = chosen
    ? screeningWire(chosen, row.hiddenText)
    : {
        verdict: rowVerdict(row),
        sender_trust: row.senderTrust,
        quarantine_reason: row.virusVerdict === "fail" ? "virus" : null,
        reasons: [],
        injection_score: null,
        phishing_score: null,
        hidden_text_removed: hiddenTextRemoved(row.hiddenText),
      };
  const extracted = await openReceivedExtracted(row, keyring);
  const delivered = chosen
    ? chosen.deliveredAt !== null
    : row.catchAll && rowVerdict(row) !== "quarantined";
  const serves =
    extracted !== null &&
    delivered &&
    screening.sender_trust !== "failed" &&
    (chosen ? chosen.extractCodes : true);
  const code = serves ? extracted.code : null;
  const link = serves ? extracted.link : null;
  const wire: ExtractedWire = {
    kinds: row.extractedKinds,
    code: code && "value" in code ? code.value : null,
    link: link && "url" in link ? link.url : null,
    link_domain_matches_sender: link && "url" in link ? link.linkDomainMatchesSender : null,
    ambiguous: Boolean((code && "ambiguous" in code) || (link && "ambiguous" in link)),
  };
  return {
    extras: {
      inbox_id: list.inbox_id,
      thread_id: list.thread_id,
      ...(list.inboxes ? { inboxes: list.inboxes } : {}),
      screening,
      spam_verdict: row.spamVerdict,
      spam_score: row.spamScore,
      virus_verdict: row.virusVerdict,
      virus_signature: row.virusSignature,
      extracted_text: extracted?.text ?? null,
      extracted: wire,
      ...(view.inboxId ? { read: chosen?.readAt != null } : {}),
    },
    codeServed:
      chosen && (wire.code !== null || wire.link !== null)
        ? { inboxId: chosen.inboxId, threadId: chosen.threadId }
        : null,
  };
}
