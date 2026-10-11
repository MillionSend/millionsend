import {
  type AttachmentFlag,
  type AttachmentVerdict,
  attachmentVerdict,
  createPromiseCache,
  decodeEntities,
  type EmailAttachment,
  extractAnchors,
  type FileKind,
  fileExtensions,
  findPixCodes,
  type MediaLink,
  type MediaLinkSource,
  type MediaPix,
  type PromiseCache,
  parsePix,
  sha256Hex,
  stripHiddenElements,
  stripInvisible,
  urlsInText,
  visibleText,
} from "@millionsend/core";
import { MediaPool, MediaPoolError, type ParseDepth, type ParsedFile } from "./pool.js";

/**
 * Reads an email's attachments for screening. The parsing threads open PDF,
 * Office, Wallet and image files; calendar and web-page attachments are read
 * here with the regex passes the judge already runs on bodies. Then come Pix
 * codes, links written in text, and the policy's verdict with what the full
 * read found. Local only: nothing here touches the network.
 */

/** One per process, shared by the send path and the judge job, so a blast's files are read once. */
export const mediaCache: PromiseCache = createPromiseCache({
  maxEntries: 2_000,
  ttlMs: 60 * 60_000,
});

let sharedPool: MediaPool | undefined;

/** The process's parsing threads, started on first use. */
export function mediaPool(): MediaPool {
  sharedPool ??= new MediaPool();
  return sharedPool;
}

export interface MediaDeps {
  pool?: MediaPool | undefined;
  cache?: PromiseCache | undefined;
}

export interface ScannedFile {
  filename: string;
  size: number;
  verdict: AttachmentVerdict;
  pages: number | null;
  text: string;
  links: MediaLink[];
  qr: string[];
  pix: MediaPix[];
  /** Pages and embedded images worth transcribing (see ParsedFile). */
  parts: string[];
  sha: string;
  bytes: Buffer;
}

export interface AttachmentScan {
  files: {
    filename: string;
    kind: FileKind;
    size: number;
    pages: number | null;
    action: AttachmentVerdict["action"];
    flags: AttachmentFlag[];
  }[];
  links: MediaLink[];
  pix: MediaPix[];
  /** A file the policy flags: it waits for a person while the team is new. */
  risky: boolean;
  /** A file over the caps, that timed out, or that won't open. */
  unreadable: boolean;
  /** A file the API now refuses, accepted before the refusal existed. */
  refused: boolean;
}

export const UNREADABLE_FLAGS: ReadonlySet<AttachmentFlag> = new Set(["over_caps", "unreadable"]);

const LINK_SOURCE: Partial<Record<FileKind, MediaLinkSource>> = {
  pdf: "PDF link",
  ooxml: "Office link",
  odf: "Office link",
  pkpass: "pass link",
  html: "web page link",
  svg: "web page link",
};
const THREAD_KINDS: ReadonlySet<FileKind> = new Set([
  "pdf",
  "ooxml",
  "odf",
  "pkpass",
  "svg",
  "png",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "avif",
]);
const MARKUP_EXTENSIONS = new Set(["htm", "html", "shtml", "xhtml", "xht", "svg"]);
/** Markup read on the worker's own thread, so a huge page can't hold it; past this, over the caps. */
const MARKUP_SCAN_MAX_CHARS = 1_000_000;
const CALENDAR_PROPERTIES =
  /^(SUMMARY|DESCRIPTION|LOCATION|URL|ATTACH|X-ALT-DESC)(?:;[^:]*)?:(.*)$/i;

const parseKey = (depth: ParseDepth, sha: string) => `parse:${depth}:${sha}`;

/** A cached read of these bytes, deep enough for `depth`; a judge read serves the send path too. */
export function cachedParse(
  sha: string,
  depth: ParseDepth,
  cache: PromiseCache,
): Promise<ParsedFile> | undefined {
  return (
    cache.peek<ParsedFile>(parseKey("judge", sha)) ??
    (depth === "send" ? cache.peek<ParsedFile>(parseKey("send", sha)) : undefined)
  );
}

/** Why the threads gave no read: busy (queue full), timed out, crashed. */
export interface ParseFailure {
  failed: MediaPoolError["reason"] | "error";
}

/**
 * Reads files on the parsing threads, one task for every file not cached
 * yet, each file's read cached by its hash. A failure is never cached.
 */
export async function parseCached(
  files: { sha: string; bytes: Uint8Array }[],
  depth: ParseDepth,
  deps: MediaDeps,
): Promise<(ParsedFile | ParseFailure)[]> {
  const cache = deps.cache ?? mediaCache;
  const reads = new Map<string, Promise<ParsedFile>>();
  for (const file of files) {
    const cached = cachedParse(file.sha, depth, cache);
    if (cached) reads.set(file.sha, cached);
  }
  const missing = [...new Map(files.map((f) => [f.sha, f])).values()].filter(
    (f) => !reads.has(f.sha),
  );
  if (missing.length > 0) {
    const task = (deps.pool ?? mediaPool()).run<ParsedFile[]>({
      files: missing.map((f) => f.bytes),
      depth,
      images: false,
    });
    missing.forEach((file, i) => {
      reads.set(
        file.sha,
        cache.set(
          parseKey(depth, file.sha),
          task.then((parsed) => parsed[i] as ParsedFile),
        ),
      );
    });
  }
  return Promise.all(
    files.map((f) =>
      (reads.get(f.sha) as Promise<ParsedFile>).catch(
        (err: unknown): ParseFailure => ({
          failed: err instanceof MediaPoolError ? err.reason : "error",
        }),
      ),
    ),
  );
}

function readCalendar(ics: string): { text: string; urls: string[] } {
  const lines: string[] = [];
  const urls: string[] = [];
  // RFC 5545 folds long lines: a line break followed by a space or tab continues the line.
  for (const line of ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
    const match = CALENDAR_PROPERTIES.exec(line);
    if (!match) continue;
    const name = (match[1] as string).toUpperCase();
    const value = (match[2] as string).replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
    if (name === "URL" || name === "ATTACH") urls.push(value.trim());
    else lines.push(name === "X-ALT-DESC" ? visibleText(value) : value);
  }
  return { text: lines.join("\n"), urls };
}

function readMarkup(page: string): { text: string; urls: string[]; flags: AttachmentFlag[] } {
  const markup = page.slice(0, MARKUP_SCAN_MAX_CHARS);
  const text = decodeEntities(visibleText(stripHiddenElements(markup).html));
  const attributes = [
    ...markup.matchAll(/\b(?:xlink:href|action|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi),
  ].map((m) => m[1] ?? m[2] ?? "");
  // Each <meta> tag on its own, then tested: one unbounded run per match keeps this linear.
  const refreshes = [...markup.matchAll(/<meta\b[^<>]*>/gi)]
    .map((m) => m[0])
    .filter((tag) => /\bhttp-equiv\s*=\s*["']?\s*refresh/i.test(tag));
  const urls = [
    ...extractAnchors(markup).map((anchor) => anchor.href),
    ...attributes,
    ...refreshes.flatMap((tag) => urlsInText(tag)),
  ].map((url) => decodeEntities(url).trim());
  const flags: AttachmentFlag[] = page.length > MARKUP_SCAN_MAX_CHARS ? ["over_caps"] : [];
  if (/<script\b|<[a-z][^<>]*\son[a-z]+\s*=|=\s*["']?\s*javascript:/i.test(markup)) {
    flags.push("scripts");
  }
  if (/<form\b|<input\b[^<>]*\btype\s*=\s*["']?password/i.test(markup)) flags.push("forms");
  return { text, urls, flags };
}

function isCalendar(file: EmailAttachment, bytes: Buffer): boolean {
  return (
    fileExtensions(file.filename)[0] === "ics" ||
    file.contentType?.toLowerCase().startsWith("text/calendar") === true ||
    bytes.subarray(0, 64).toString("latin1").trimStart().startsWith("BEGIN:VCALENDAR")
  );
}

/** Pix codes and http(s) links among decoded QR payloads. */
export function qrFindings(payloads: string[]): { links: MediaLink[]; pix: MediaPix[] } {
  const links: MediaLink[] = [];
  const pix: MediaPix[] = [];
  for (const payload of payloads) {
    const code = parsePix(payload);
    if (code) pix.push({ ...code, from: "qr" });
    else if (/^(?:https?:\/\/|www\.)/i.test(payload.trim())) {
      links.push(...urlsInText(payload.trim()).map((url) => ({ source: "QR code" as const, url })));
    }
  }
  return { links, pix };
}

/** Every attachment read and judged; `depth` sets how far the threads read. */
export async function scanFiles(
  attachments: readonly EmailAttachment[],
  depth: ParseDepth,
  deps: MediaDeps,
): Promise<ScannedFile[]> {
  const files = attachments.map((attachment) => {
    const bytes = Buffer.from(attachment.content, "base64");
    const first = attachmentVerdict({
      filename: attachment.filename,
      contentType: attachment.contentType,
      bytes,
    });
    return { attachment, bytes, sha: sha256Hex(bytes), first };
  });
  const threaded = files.filter(
    (f) => f.first.action !== "reject" && THREAD_KINDS.has(f.first.kind),
  );
  const parsed = await parseCached(threaded, depth, deps);
  return files.map(({ attachment, bytes, sha, first }) => {
    const index = threaded.findIndex((f) => f.sha === sha);
    const parse = index === -1 ? undefined : parsed[index];
    const read = parse && !("failed" in parse) ? parse : undefined;
    const found: AttachmentFlag[] =
      parse && "failed" in parse ? ["unreadable"] : [...(read?.flags ?? [])];
    let text = read?.text ?? "";
    // Office links come out of XML attributes, entities and all.
    const urls = (read?.links ?? []).map((link) => decodeEntities(link));
    const markup =
      first.kind === "html" ||
      first.kind === "svg" ||
      fileExtensions(attachment.filename).some((ext) => MARKUP_EXTENSIONS.has(ext));
    if (first.action !== "reject" && markup) {
      const page = readMarkup(bytes.toString("utf8"));
      text = page.text;
      urls.push(...page.urls);
      found.push(...page.flags);
    } else if (first.action !== "reject" && isCalendar(attachment, bytes)) {
      const calendar = readCalendar(bytes.toString("utf8"));
      text = calendar.text;
      urls.push(...calendar.urls);
    }
    const decoded = decodeEntities(text);
    text = stripInvisible(decoded);
    const source = LINK_SOURCE[first.kind] ?? (markup ? "web page link" : "calendar link");
    const links = [...new Set([...urls, ...urlsInText(text)])]
      .filter((url) => /^https?:\/\//i.test(url))
      .map((url) => ({ source, url }));
    const qr = qrFindings(read?.qr ?? []);
    return {
      filename: attachment.filename,
      size: bytes.length,
      verdict: attachmentVerdict(
        { filename: attachment.filename, contentType: attachment.contentType, bytes },
        found,
      ),
      pages: read?.pages ?? null,
      text,
      links: [...qr.links, ...links],
      qr: read?.qr ?? [],
      // Before stripInvisible: a payload wrapped across lines is joined only where it broke.
      pix: [
        ...qr.pix,
        ...findPixCodes(decoded).map((code) => ({ ...code, from: "text" as const })),
      ],
      parts: read?.parts ?? [],
      sha,
      bytes,
    };
  });
}

/** Whether a file waits for a person (risky), couldn't be read, or is now refused outright. */
export function fileIssues(files: readonly ScannedFile[]): {
  risky: boolean;
  unreadable: boolean;
  refused: boolean;
} {
  return {
    risky: files.some((f) => f.verdict.flags.some((flag) => !UNREADABLE_FLAGS.has(flag))),
    unreadable: files.some((f) => f.verdict.flags.some((flag) => UNREADABLE_FLAGS.has(flag))),
    refused: files.some((f) => f.verdict.action === "reject"),
  };
}

/**
 * The send path's read of an email's attachments, for every tier: local,
 * no network, a PDF's first page and a few Office images for QR codes. It
 * feeds parking for teams in "new", the before-SES trigger, the
 * new-destination check (its links) and the sampling anomalies.
 */
export async function scanAttachments(
  attachments: readonly EmailAttachment[],
  deps: MediaDeps = {},
): Promise<AttachmentScan> {
  const files = await scanFiles(attachments, "send", deps);
  return {
    files: files.map((f) => ({
      filename: f.filename,
      kind: f.verdict.kind,
      size: f.size,
      pages: f.pages,
      action: f.verdict.action,
      flags: f.verdict.flags,
    })),
    links: files.flatMap((f) => f.links),
    pix: files.flatMap((f) => f.pix),
    ...fileIssues(files),
  };
}
