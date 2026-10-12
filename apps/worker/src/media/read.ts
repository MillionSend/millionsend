import {
  type EmailAttachment,
  type FileKind,
  getImage,
  IMAGE_FETCH_MAX_BYTES,
  IMAGE_TYPES,
  type Keyring,
  linkDomain,
  type MediaFindings,
  type MediaIssue,
  type MediaReview,
  type PromiseCache,
  postFailureCode,
  sealMediaReview,
  sha256Hex,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull } from "drizzle-orm";
import sharp, { type Sharp } from "sharp";
import { MEDIA_IMAGE_MAX_PIXELS, MEDIA_SHARP_TIMEOUT, type ParsedFile } from "./pool.js";
import {
  cachedParse,
  fileIssues,
  type MediaDeps,
  mediaCache,
  mediaPool,
  type ParseFailure,
  parseCached,
  qrFindings,
  type ScannedFile,
  scanFiles,
  UNREADABLE_FLAGS,
} from "./scan.js";
import type { VisionReader, VisionReport, VisionResult } from "./vision.js";

/**
 * The judge job's read of an email's media: everything the send path reads,
 * deeper (PDF pages 2 and 3, more Office images), plus the body's images
 * (data: and inline SVG decoded here, remote ones fetched through the SSRF
 * guard) and the image reader's transcripts. Cached per process: a blast's
 * files, fetches and transcripts are paid for once.
 */

/** The whole image-and-attachment step of one judge job. */
export const MEDIA_STEP_TIMEOUT_MS = 25_000;
/** Images read per email, duplicates dropped, body images first. */
export const MEDIA_IMAGES_MAX = 12;
const BODY_FETCH_BUDGET_MS = 6_000;
const BODY_FETCH_CONCURRENCY = 4;
const URL_HASH_TTL_MS = 10 * 60_000;
/** 1,120 px a side keeps an image at 1,600 visual tokens or fewer. */
const VISION_SIDE = 1_120;
const VISION_MIN_SIDE = 48;
const ANIMATION_FRAMES = 4;
const PREVIEWS_MAX = 4;
const PREVIEW_SIDE = 600;
const IMAGE_KINDS: ReadonlySet<FileKind> = new Set([...IMAGE_TYPES, "svg"]);

// sharp's jobs run on libuv's thread pool, which DNS lookups and file reads
// share (4 threads unless UV_THREADPOOL_SIZE says otherwise). One sharp job
// at a time here and one per parsing thread always leave that pool a free
// thread; concurrency(1) keeps each job to a single libvips thread.
sharp.concurrency(1);
let sharpTurn: Promise<unknown> = Promise.resolve();

function sharpInTurn<T>(work: () => Promise<T>): Promise<T> {
  const turn = sharpTurn.then(work, work);
  sharpTurn = turn.catch(() => undefined);
  return turn;
}

export interface MediaReadInput {
  attachments: readonly EmailAttachment[];
  /**
   * The body's image sources in reading order: http(s) URLs, data: URIs,
   * inline <svg> markup and cid: references, without tracking pixels or our
   * own tracking host.
   */
  bodyImages: readonly string[];
  /** Read body images too: the team is in "new", or the email is opaque. */
  readBodyImages: boolean;
}

export interface MediaReadDeps extends MediaDeps {
  /** Null when ABUSE_VISION is off: the email is judged without image text, and that is noted. */
  vision: VisionReader | null;
  fetchImage?: typeof getImage;
}

export interface MediaRead {
  /** For buildJudgeBlock's `media`. */
  findings: MediaFindings;
  /** What the gate parks or waits on. */
  issues: MediaIssue[];
  /** What a person reviewing the email sees if it is held; draws previews from the same images. */
  review(): Promise<MediaReview>;
}

interface Item {
  /** For the judge: where the image came from, sender text included. */
  label: string;
  /** For the image reader: fixed words only. */
  hint: string;
  /** The cache's name for the image: its bytes' hash, or its file's hash and part. */
  id: string;
  load(): Promise<Uint8Array | null>;
}

type ItemRead = VisionReport | "small" | "unreadable" | "not reported";
type Outcome = { status: "ok"; items: ItemRead[] } | Exclude<VisionResult, { status: "ok" }>;

const NOT_READ: Record<Exclude<Outcome["status"], "ok">, string> = {
  refused: "the image reader declined",
  blocked: "blocked by Bedrock",
  unavailable: "image reader unavailable",
};

/**
 * An image as the reader receives it: fitted into 1,120 px as JPEG, and an
 * animation as four evenly spaced frames stacked, since the model reads only
 * the first frame. "small" for an image under 48 px a side: decoration.
 */
export function prepareImage(bytes: Uint8Array): Promise<Buffer | "small"> {
  return sharpInTurn(async () => {
    const input = { limitInputPixels: MEDIA_IMAGE_MAX_PIXELS };
    const meta = await sharp(bytes, input).timeout(MEDIA_SHARP_TIMEOUT).metadata();
    const height = meta.pageHeight ?? meta.height ?? 0;
    if ((meta.width ?? 0) < VISION_MIN_SIDE || height < VISION_MIN_SIDE) return "small";
    const fitted = (image: Sharp) =>
      image
        .timeout(MEDIA_SHARP_TIMEOUT)
        .flatten({ background: "#ffffff" })
        .resize(VISION_SIDE, VISION_SIDE, { fit: "inside", withoutEnlargement: true });
    const pages = meta.pages ?? 1;
    if (pages <= 1) return fitted(sharp(bytes, input)).jpeg({ quality: 85 }).toBuffer();
    const picks = new Set(
      Array.from({ length: ANIMATION_FRAMES }, (_, i) =>
        Math.round((i * (pages - 1)) / (ANIMATION_FRAMES - 1)),
      ),
    );
    const frames: Buffer[] = [];
    for (const page of picks) {
      frames.push(
        await fitted(sharp(bytes, { ...input, page }))
          .png()
          .toBuffer(),
      );
    }
    return fitted(sharp(frames, { join: { across: 1 } }))
      .jpeg({ quality: 85 })
      .toBuffer();
  });
}

function decodeDataUri(uri: string): Uint8Array | null {
  const comma = uri.indexOf(",");
  if (comma === -1) return null;
  const data = uri.slice(comma + 1);
  try {
    return /;base64$/i.test(uri.slice(0, comma))
      ? Buffer.from(data, "base64")
      : Buffer.from(decodeURIComponent(data), "utf8");
  } catch {
    return null;
  }
}

async function bodyItems(
  sources: readonly string[],
  deps: MediaReadDeps,
  cache: PromiseCache,
  signal: AbortSignal,
  notRead: string[],
): Promise<Item[]> {
  const unique = [...new Set(sources.map((source) => source.trim()).filter(Boolean))];
  for (const _ of unique.slice(MEDIA_IMAGES_MAX)) notRead.push("over the cap");
  const fetchImage = deps.fetchImage ?? getImage;
  const budget = AbortSignal.any([signal, AbortSignal.timeout(BODY_FETCH_BUDGET_MS)]);
  const inline = (bytes: Uint8Array, label: string): Item | string =>
    bytes.length > IMAGE_FETCH_MAX_BYTES
      ? "over the cap"
      : { label, hint: "inline image", id: sha256Hex(bytes), load: async () => bytes };
  const resolve = async (source: string, n: number): Promise<Item | string> => {
    if (/^cid:/i.test(source)) return "cid reference";
    if (/^data:/i.test(source)) {
      const bytes = decodeDataUri(source);
      return bytes ? inline(bytes, `image ${n}, inline`) : "won't decode";
    }
    if (source.startsWith("<"))
      return inline(Buffer.from(source, "utf8"), `image ${n}, inline SVG`);
    let host: string;
    try {
      host = new URL(source).hostname;
    } catch {
      return "won't decode";
    }
    const fetched: { bytes?: Uint8Array | undefined } = {};
    const fetchBytes = async () => (await fetchImage(source, { signal: budget })).bytes;
    try {
      const id = await cache.get(
        `url:${source}`,
        async () => {
          fetched.bytes = await fetchBytes();
          return sha256Hex(fetched.bytes);
        },
        URL_HASH_TTL_MS,
      );
      return {
        label: `image ${n}, remote, ${host}`,
        hint: "remote image",
        id,
        load: async () => {
          fetched.bytes ??= await fetchBytes().catch(() => undefined);
          return fetched.bytes ?? null;
        },
      };
    } catch (err) {
      return postFailureCode(err) === "timeout" ? "timeout" : "fetch failed";
    }
  };
  const kept = unique.slice(0, MEDIA_IMAGES_MAX);
  const resolved: (Item | string)[] = new Array(kept.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(BODY_FETCH_CONCURRENCY, kept.length) }, async () => {
      while (next < kept.length) {
        const i = next++;
        resolved[i] = await resolve(kept[i] as string, i + 1);
      }
    }),
  );
  for (const failure of resolved) if (typeof failure === "string") notRead.push(failure);
  return resolved.filter((item): item is Item => typeof item !== "string");
}

/** QR codes in body images; an image that won't open, or found the threads busy, is dropped and noted. */
async function bodyQr(
  items: Item[],
  deps: MediaDeps,
  cache: PromiseCache,
  notRead: string[],
): Promise<{ items: Item[]; qr: string[] }> {
  const files = await Promise.all(
    items.map(async (item) => ({
      sha: item.id,
      bytes: cachedParse(item.id, "judge", cache) ? new Uint8Array(0) : await item.load(),
    })),
  );
  const readable = files.filter((file): file is { sha: string; bytes: Uint8Array } => !!file.bytes);
  const parsed = new Map<string, ParsedFile | ParseFailure>();
  (await parseCached(readable, "judge", deps)).forEach((read, i) => {
    parsed.set((readable[i] as { sha: string }).sha, read);
  });
  const kept: Item[] = [];
  const qr: string[] = [];
  for (const item of items) {
    const read = parsed.get(item.id);
    if (!read) {
      notRead.push("fetch failed");
      continue;
    }
    if ("failed" in read) {
      notRead.push(read.failed === "busy" ? "busy" : "won't decode");
      continue;
    }
    if (read.flags.some((flag) => UNREADABLE_FLAGS.has(flag))) {
      notRead.push("won't decode");
      continue;
    }
    qr.push(...read.qr);
    kept.push(item);
  }
  return { items: kept, qr };
}

function attachmentItems(files: readonly ScannedFile[], deps: MediaDeps): Item[] {
  const items: Item[] = [];
  for (const file of files) {
    if (file.verdict.action === "reject") continue;
    // A file the threads could not open is not decoded again here, on the worker's own thread.
    if (file.verdict.flags.some((flag) => UNREADABLE_FLAGS.has(flag))) continue;
    if (IMAGE_KINDS.has(file.verdict.kind)) {
      items.push({
        label: `attachment ${file.filename}`,
        hint: "attached image",
        id: file.sha,
        load: async () => file.bytes,
      });
    }
    let rendered: Promise<Record<string, Uint8Array>> | undefined;
    for (const part of file.parts) {
      const page = part.startsWith("p");
      items.push({
        label: `attachment ${file.filename} ${page ? "page" : "image"} ${part.slice(1)}`,
        hint: page ? "attachment page" : "image inside an attachment",
        id: `${file.sha}#${part}`,
        load: async () => {
          rendered ??= (deps.pool ?? mediaPool())
            .run<ParsedFile[]>({ files: [file.bytes], depth: "judge", images: true })
            .then((parsed) => parsed[0]?.images ?? {});
          return (await rendered.catch((): Record<string, Uint8Array> => ({})))[part] ?? null;
        },
      });
    }
  }
  return items;
}

async function readImages(
  items: Item[],
  reader: VisionReader,
  signal: AbortSignal,
): Promise<Outcome> {
  const prepared: (Buffer | "small" | "unreadable")[] = [];
  for (const item of items) {
    try {
      const bytes = await item.load();
      prepared.push(bytes ? await prepareImage(bytes) : "unreadable");
    } catch {
      prepared.push("unreadable");
    }
  }
  const sent = prepared.flatMap((jpeg, index) =>
    Buffer.isBuffer(jpeg) ? [{ index, hint: (items[index] as Item).hint, jpeg }] : [],
  );
  const reads: ItemRead[] = prepared.map((p) => (Buffer.isBuffer(p) ? "not reported" : p));
  if (sent.length === 0) return { status: "ok", items: reads };
  const result = await reader.read(
    sent.map(({ hint, jpeg }) => ({ hint, jpeg })),
    signal,
  );
  if (result.status !== "ok") return result;
  sent.forEach(({ index }, i) => {
    reads[index] = result.reports[i] ?? "not reported";
  });
  return { status: "ok", items: reads };
}

async function previews(items: Item[]): Promise<MediaReview["previews"]> {
  const out: MediaReview["previews"] = [];
  for (const item of items) {
    if (out.length >= PREVIEWS_MAX) break;
    try {
      const bytes = await item.load();
      const jpeg = bytes && (await prepareImage(bytes));
      if (!Buffer.isBuffer(jpeg)) continue;
      const small = await sharpInTurn(() =>
        sharp(jpeg)
          .timeout(MEDIA_SHARP_TIMEOUT)
          .resize(PREVIEW_SIDE, PREVIEW_SIDE, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 70 })
          .toBuffer(),
      );
      out.push({ label: item.label, jpeg: small.toString("base64") });
    } catch {
      // An image that won't draw gets no preview; its facts are still listed.
    }
  }
  return out;
}

/**
 * Reads an email's media for the judge. Fills the judge block's media lines
 * and says what could not be read, for the gate to park or wait on.
 */
export async function readMediaForJudge(
  input: MediaReadInput,
  deps: MediaReadDeps,
): Promise<MediaRead> {
  const signal = AbortSignal.timeout(MEDIA_STEP_TIMEOUT_MS);
  const cache = deps.cache ?? mediaCache;
  const notRead: string[] = [];
  const [files, body] = await Promise.all([
    scanFiles(input.attachments, "judge", deps),
    input.readBodyImages
      ? bodyItems(input.bodyImages, deps, cache, signal, notRead)
      : Promise.resolve([]),
  ]);
  const scanned = await bodyQr(body, deps, cache, notRead);
  const candidates = [...scanned.items, ...attachmentItems(files, deps)];
  for (const _ of candidates.slice(MEDIA_IMAGES_MAX)) notRead.push("over the cap");
  const items = candidates.slice(0, MEDIA_IMAGES_MAX);

  for (const _ of files.filter((file) => file.busy)) notRead.push("busy");
  const issues = new Set<MediaIssue>();
  const { risky, unreadable, refused } = fileIssues(files);
  if (risky) issues.add("risky_file");
  if (unreadable) issues.add("unreadable_file");
  if (refused) issues.add("refused_file");
  if (notRead.length > 0) issues.add("images_not_read");

  let outcome: Outcome | null = null;
  if (items.length > 0 && deps.vision) {
    const key = `vision:${items.map((item) => item.id).join(",")}`;
    const reader = deps.vision;
    outcome = await cache.get(key, () => readImages(items, reader, signal));
    // A transient failure is not an answer: the next email asks again.
    if (outcome.status === "unavailable") cache.delete(key);
  } else if (items.length > 0) {
    issues.add("vision_off");
    for (const _ of items) notRead.push("image reading is off");
  }

  const imageText: MediaFindings["imageText"] = [];
  const brands: string[] = [];
  let read = 0;
  let forms = 0;
  let addressedToAi = 0;
  let modelSeenQr = 0;
  if (outcome && outcome.status !== "ok") {
    issues.add(`vision_${outcome.status}`);
    const why =
      outcome.status === "unavailable" && outcome.reason === "timeout"
        ? "timeout"
        : NOT_READ[outcome.status];
    for (const _ of items) notRead.push(why);
  } else if (outcome) {
    outcome.items.forEach((result, i) => {
      if (result === "small") return;
      if (typeof result === "string") {
        notRead.push(result === "unreadable" ? "won't decode" : result);
        issues.add("images_not_read");
        return;
      }
      read++;
      if (result.text.trim())
        imageText.push({ label: (items[i] as Item).label, text: result.text });
      brands.push(...result.brands);
      modelSeenQr += result.qrCodes;
      if (result.loginOrPaymentForm) forms++;
      if (result.addressedToAi) addressedToAi++;
    });
  }

  const qr = qrFindings(scanned.qr);
  const decoded = scanned.qr.length + files.reduce((n, file) => n + file.qr.length, 0);
  if (modelSeenQr > decoded) issues.add("qr_undecoded");
  const findings: MediaFindings = {
    imageText,
    brands,
    images: { read, notRead: notRead.length, why: [...new Set(notRead)], forms, addressedToAi },
    qr: { seen: Math.max(decoded, modelSeenQr), decoded },
    fileText: files
      .filter((file) => file.text)
      .map((file) => ({ filename: file.filename, text: file.text })),
    links: [...qr.links, ...files.flatMap((file) => file.links)],
    pix: [...qr.pix, ...files.flatMap((file) => file.pix)],
    files: files.map((file) => ({
      filename: file.filename,
      kind: file.verdict.kind,
      size: file.size,
      pages: file.pages,
      flags: file.verdict.flags,
    })),
  };
  return {
    findings,
    issues: [...issues],
    review: async () => ({
      text: [
        ...imageText.map((entry) => ({ source: entry.label, text: entry.text })),
        ...findings.fileText.map((entry) => ({ source: entry.filename, text: entry.text })),
      ],
      links: findings.links.map((link) => ({ ...link, domain: linkDomain(link.url) ?? "" })),
      pix: findings.pix,
      files: findings.files,
      // Bedrock's CSAM check answers 400, and a refusal may hide the same:
      // no image from such an email is ever kept.
      previews:
        issues.has("vision_blocked") || issues.has("vision_refused") ? [] : await previews(items),
      issues: [...issues],
    }),
  };
}

/**
 * Seals what screening read into the held email's `media` column. Call it
 * only for mail parked for review; a purged body stays purged. `keep` leaves
 * a review already saved in place: the send path's file facts never replace
 * the judge's fuller read, whichever lands first.
 */
export async function saveMediaReview(
  db: Db,
  keyring: Keyring,
  email: { id: string; teamId: string },
  review: MediaReview,
  opts: { keep?: boolean } = {},
): Promise<void> {
  const media = await sealMediaReview(review, keyring, { teamId: email.teamId, rowId: email.id });
  await db
    .update(schema.emails)
    .set({ media })
    .where(
      and(
        eq(schema.emails.id, email.id),
        isNull(schema.emails.bodyPurgedAt),
        opts.keep ? isNull(schema.emails.media) : undefined,
      ),
    );
}
