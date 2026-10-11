import { createHash } from "node:crypto";
import { schema } from "@millionsend/db";
import { getTableColumns } from "drizzle-orm";
import {
  type AddressObject,
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
import { visibleLine } from "../customer-text.js";
import { routableAddress } from "../sender-address.js";
import { type DownloadSigning, signReceivedDownload } from "./downloads.js";

export type ReceivedEmailRow = typeof schema.receivedEmails.$inferSelect;

const { rawCiphertext, rawIv, rawWrappedDek, ...metaColumns } = getTableColumns(
  schema.receivedEmails,
);

/**
 * Every received_emails column but the sealed raw message (up to 40 MiB a
 * row): what lists, webhooks and attachment records select. Only a GET of one
 * email and the downloads need the full row.
 */
export const RECEIVED_EMAIL_META_COLUMNS = metaColumns;

export type ReceivedEmailMeta = Omit<ReceivedEmailRow, "rawCiphertext" | "rawIv" | "rawWrappedDek">;

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
};

/** MIME parses in flight per process: each can hold a 40 MiB message several times over. */
const PARSE_CONCURRENCY = 4;
// ponytail: per process, not per instance; a shared queue is the upgrade if
// several API replicas end up parsing at once.
const parseSlot = createSemaphore(PARSE_CONCURRENCY);
/** A parse that has not finished by now is abandoned; the message is still stored. */
const PARSE_TIMEOUT_MS = 30_000;

const TEXT_ONLY = { skipHtmlToText: true, skipTextToHtml: true, skipTextLinks: true } as const;

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
  attachments: Omit<ReceivedAttachment, "id">[];
  /** The bytes of the attachment at the requested index, when one was asked for. */
  captured: Buffer | null;
}

/**
 * One streaming pass over a message: headers and every attachment's
 * metadata, buffering at most the one attachment asked for.
 */
function walk(raw: Buffer, captureIndex?: number): Promise<Walk> {
  return new Promise((resolve, reject) => {
    const parser = new MailParser({ ...TEXT_ONLY, skipImageLinks: true });
    const result: Walk = { headers: undefined, attachments: [], captured: null };
    const timer = setTimeout(() => {
      parser.destroy();
      reject(new Error("mime parse timed out"));
    }, PARSE_TIMEOUT_MS);
    timer.unref();
    parser.on("headers", (headers) => {
      result.headers = headers;
    });
    parser.on("data", (data) => {
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

/**
 * Metadata for storage, parsed with mailparser. Never throws: a message that
 * does not parse (malformed MIME, a parser error, a timeout) is still stored,
 * with empty metadata, and its raw bytes stay downloadable.
 */
export async function parseReceivedMetadata(raw: Buffer): Promise<ReceivedMetadata> {
  try {
    const { headers, attachments } = await parseSlot(() => walk(raw));
    return {
      from: addresses(headers?.get("from"))[0] ?? null,
      to: addresses(headers?.get("to")),
      cc: addresses(headers?.get("cc")),
      bcc: addresses(headers?.get("bcc")),
      replyTo: addresses(headers?.get("reply-to")),
      subject: headerText(headers, "subject", 998),
      messageId: headerText(headers, "message-id", 998) || null,
      attachments,
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
  softfail: "fail",
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
    const value = visibleLine(line.slice(line.indexOf(":") + 1), 16_384);
    out[name] = name in out ? `${out[name]}\n${value}` : value;
  }
  return out;
}

/**
 * GET /emails/receiving/{id}. HTML, text and headers come from parsing the
 * raw message; `data_uri` (Resend's default) inlines `cid:` images, `cid`
 * leaves the references. A message that does not parse still answers, with
 * null content and its raw download.
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
  let content: Pick<ReceivedEmailDetail, "html" | "text" | "headers"> = {
    html: null,
    text: null,
    headers: null,
  };
  if (raw) {
    try {
      const parsed = await parseSlot(() =>
        simpleParser(raw, { ...TEXT_ONLY, keepCidLinks: options.htmlFormat === "cid" }),
      );
      content = {
        html: parsed.html || null,
        text: parsed.text || null,
        headers: headerRecord(parsed.headerLines ?? []),
      };
    } catch {
      // Malformed MIME: the raw download below is the way to its bytes.
    }
  }
  const signed = raw
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
    html_format: options.htmlFormat,
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
