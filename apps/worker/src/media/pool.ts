import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import type { AttachmentFlag } from "@millionsend/core";
import {
  readZipDirectory,
  readZipEntry,
  sniffFileType,
  sniffImageType,
  type ZipDirectory,
  type ZipEntry,
} from "@millionsend/core/file-type";

/**
 * The parsing threads. mupdf and zxing are WASM that runs synchronously, and
 * a hostile file can make either spin or crash: they run here, on a thread
 * the pool kills and replaces past MEDIA_TASK_TIMEOUT_MS, never on the
 * worker's event loop. This module is both sides: the pool the worker
 * imports, and the thread's entry, which loads mupdf, zxing and sharp on
 * first use. Threads import only light core subpaths; the core barrel would
 * cost each one half a second and a hundred MB.
 */

// ponytail: fixed at two threads; size from os.availableParallelism() if parsing queues.
export const MEDIA_POOL_SIZE = 2;
/** One email's budget, from the moment its job is queued: waiting for a thread counts. */
export const MEDIA_TASK_TIMEOUT_MS = 4_000;
/** Jobs waiting past this many are refused as busy, and their files count as not read. */
export const MEDIA_QUEUE_MAX = 64;
/** A thread whose mupdf heap grew past this is replaced: WASM memory only ever grows. */
export const MEDIA_THREAD_WASM_MAX_BYTES = 512 * 1024 * 1024;
const THREAD = "millionsend-media-thread";
const THREAD_HEAP_MB = 512;

export class MediaPoolError extends Error {
  constructor(
    readonly reason: "timeout" | "crashed" | "closed" | "busy",
    options?: ErrorOptions,
  ) {
    super(`media parse ${reason}`, options);
  }
}

interface Job {
  message: unknown;
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
  thread?: Worker;
}

type Reply = ({ ok: true; result: unknown } | { ok: false; error: string }) & { wasmBytes: number };

/** Runs one job per thread at a time, in order; a thread that times out or dies is replaced. */
export class MediaPool {
  readonly #size: number;
  readonly #timeoutMs: number;
  readonly #queueMax: number;
  readonly #wasmMaxBytes: number;
  readonly #script: URL;
  readonly #idle: Worker[] = [];
  readonly #busy = new Map<Worker, Job>();
  readonly #queue: Job[] = [];
  #threads = 0;

  constructor(
    opts: {
      size?: number;
      timeoutMs?: number;
      queueMax?: number;
      wasmMaxBytes?: number;
      script?: URL;
    } = {},
  ) {
    this.#size = opts.size ?? MEDIA_POOL_SIZE;
    this.#timeoutMs = opts.timeoutMs ?? MEDIA_TASK_TIMEOUT_MS;
    this.#queueMax = opts.queueMax ?? MEDIA_QUEUE_MAX;
    this.#wasmMaxBytes = opts.wasmMaxBytes ?? MEDIA_THREAD_WASM_MAX_BYTES;
    this.#script = opts.script ?? new URL(import.meta.url);
  }

  run<T>(message: unknown): Promise<T> {
    if (this.#queue.length >= this.#queueMax) return Promise.reject(new MediaPoolError("busy"));
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        message,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: setTimeout(() => this.#expire(job), this.#timeoutMs),
      };
      this.#queue.push(job);
      this.#pump();
    });
  }

  async close(): Promise<void> {
    for (const job of this.#queue.splice(0)) {
      clearTimeout(job.timer);
      job.reject(new MediaPoolError("closed"));
    }
    const threads = [...this.#idle, ...this.#busy.keys()];
    await Promise.all(threads.map((thread) => this.#drop(thread, new MediaPoolError("closed"))));
  }

  #expire(job: Job): void {
    if (job.thread) {
      void this.#drop(job.thread, new MediaPoolError("timeout"));
      return;
    }
    const queued = this.#queue.indexOf(job);
    if (queued !== -1) this.#queue.splice(queued, 1);
    job.reject(new MediaPoolError("timeout"));
  }

  #pump(): void {
    while (this.#queue.length > 0) {
      const thread = this.#idle.pop() ?? this.#spawn();
      if (!thread) return;
      const job = this.#queue.shift() as Job;
      job.thread = thread;
      this.#busy.set(thread, job);
      thread.postMessage(job.message);
    }
  }

  #spawn(): Worker | undefined {
    if (this.#threads >= this.#size) return undefined;
    this.#threads++;
    const thread = new Worker(this.#script, {
      workerData: THREAD,
      // The worker runs TypeScript through tsx, and a thread does not inherit its loader.
      execArgv: ["--import", import.meta.resolve("tsx")],
      resourceLimits: { maxOldGenerationSizeMb: THREAD_HEAP_MB },
    });
    thread.unref();
    thread.on("message", (reply: Reply) => {
      const job = this.#busy.get(thread);
      if (!job) return;
      clearTimeout(job.timer);
      this.#busy.delete(thread);
      if (reply.ok) job.resolve(reply.result);
      else job.reject(new Error(reply.error));
      if (reply.wasmBytes > this.#wasmMaxBytes) {
        void this.#retire(thread);
      } else {
        this.#idle.push(thread);
        this.#pump();
      }
    });
    thread.on("error", (err) => {
      void this.#drop(thread, new MediaPoolError("crashed", { cause: err }));
    });
    thread.on("exit", () => {
      void this.#drop(thread, new MediaPoolError("crashed"));
    });
    return thread;
  }

  /** Fails the thread's job, if any, and kills it; the next job starts a fresh thread. */
  #drop(thread: Worker, err: MediaPoolError): Promise<void> {
    const job = this.#busy.get(thread);
    const idle = this.#idle.indexOf(thread);
    if (!job && idle === -1) return Promise.resolve();
    if (job) {
      clearTimeout(job.timer);
      this.#busy.delete(thread);
      job.reject(err);
    }
    if (idle !== -1) this.#idle.splice(idle, 1);
    return this.#retire(thread, err.reason !== "closed");
  }

  /**
   * Its slot frees only once the thread has stopped, so a thread killed in
   * the middle of native work never runs alongside its replacement.
   */
  async #retire(thread: Worker, refill = true): Promise<void> {
    await thread.terminate().catch(() => undefined);
    this.#threads--;
    if (refill) this.#pump();
  }
}

// ---- Inside a thread ----

/** "send" reads what the send path can wait for; "judge" reads what the judge job adds. */
export type ParseDepth = "send" | "judge";

export interface ParseRequest {
  files: Uint8Array[];
  depth: ParseDepth;
  /** Return the parts' bytes too, for the image reader. */
  images: boolean;
}

export interface ParsedFile {
  flags: AttachmentFlag[];
  pages: number | null;
  /** Office text keeps its XML entities; the caller decodes them. */
  text: string;
  links: string[];
  qr: string[];
  /** Parts worth transcribing, in reading order: "p1" a page with little text, "i2" an embedded image. */
  parts: string[];
  /** Part id → JPEG of a page, or an embedded image as stored; filled only when asked for. */
  images: Record<string, Uint8Array>;
}

const DEPTH = {
  send: { pages: 1, images: 3 },
  judge: { pages: 3, images: 6 },
} as const;
/** Text and links come from this many pages; a longer PDF also counts as over the caps. */
export const MEDIA_PDF_PAGES_MAX = 50;
/** sharp's limitInputPixels for every image screening opens. */
export const MEDIA_IMAGE_MAX_PIXELS = 50_000_000;
/** sharp's own timeout: libvips work runs outside the thread, where killing it can't reach. */
export const MEDIA_SHARP_TIMEOUT = { seconds: 3 };
const FILE_TEXT_MAX_CHARS = 8_000;
const FILE_LINKS_MAX = 50;
const RENDER_SCALE = 1.5;
const RENDER_MAX_PIXELS = 8_000_000;
const QR_MAX_SIDE = 2048;
const PAGE_TEXT_FOR_VISION = 100;
const ZIP_PART_MAX_BYTES = 8 * 1024 * 1024;
const PDF_OBJECTS_MAX = 100_000;
const PDF_NESTING_MAX = 32;
const PDF_ACTIVE = new Set(["JavaScript", "JS", "Launch", "EmbeddedFile", "EmbeddedFiles", "XFA"]);

const require = createRequire(import.meta.url);
let qrReader: Promise<typeof import("zxing-wasm/reader")> | undefined;

/** zxing reads its WASM from node_modules: left alone, it fetches the binary from a CDN. */
function zxing(): Promise<typeof import("zxing-wasm/reader")> {
  qrReader ??= import("zxing-wasm/reader").then(async (reader) => {
    const wasm = readFileSync(require.resolve("zxing-wasm/reader/zxing_reader.wasm"));
    await reader.prepareZXingModule({
      overrides: {
        wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
      },
      fireImmediately: true,
    });
    return reader;
  });
  return qrReader;
}

/** The QR codes in an RGBA image. */
export async function decodeQr(rgba: Uint8Array, width: number, height: number): Promise<string[]> {
  const { readBarcodes } = await zxing();
  const image = {
    data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    width,
    height,
    colorSpace: "srgb",
  } as unknown as Parameters<typeof readBarcodes>[0];
  const found = await readBarcodes(image, {
    formats: ["QRCode"],
    tryHarder: true,
    maxNumberOfSymbols: 8,
  });
  return found.filter((code) => code.isValid && code.text).map((code) => code.text);
}

function empty(): ParsedFile {
  return { flags: [], pages: null, text: "", links: [], qr: [], parts: [], images: {} };
}

async function imageQr(bytes: Uint8Array): Promise<Pick<ParsedFile, "flags" | "qr">> {
  const { default: sharp } = await import("sharp");
  sharp.concurrency(1);
  try {
    const { data, info } = await sharp(bytes, { limitInputPixels: MEDIA_IMAGE_MAX_PIXELS })
      .timeout(MEDIA_SHARP_TIMEOUT)
      .resize(QR_MAX_SIDE, QR_MAX_SIDE, { fit: "inside", withoutEnlargement: true })
      // A transparent background reads as black: a QR code drawn on one would vanish.
      .flatten({ background: "#ffffff" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { flags: [], qr: await decodeQr(data, info.width, info.height) };
  } catch (err) {
    return { flags: [/pixel limit/i.test(String(err)) ? "over_caps" : "unreadable"], qr: [] };
  }
}

type Mupdf = typeof import("mupdf");
type PdfObject = InstanceType<Mupdf["PDFObject"]>;

/** Whether any object, compressed object streams included, holds a script, launch, embedded file or XFA form. */
function hasActiveContent(pdf: InstanceType<Mupdf["PDFDocument"]>): boolean {
  const walk = (obj: PdfObject, depth: number): boolean => {
    if (obj.isName()) return PDF_ACTIVE.has(obj.asName());
    if (depth > PDF_NESTING_MAX || (!obj.isDictionary() && !obj.isArray())) return false;
    let found = false;
    obj.forEach((value, key) => {
      if (found) return;
      if (typeof key === "string" && PDF_ACTIVE.has(key)) found = true;
      // Referenced objects get their own turn in the outer loop.
      else if (!value.isIndirect()) found = walk(value, depth + 1);
    });
    return found;
  };
  const count = Math.min(pdf.countObjects(), PDF_OBJECTS_MAX);
  for (let num = 1; num < count; num++) {
    try {
      if (walk(pdf.newIndirect(num).resolve(), 0)) return true;
    } catch {
      // One object mupdf cannot read must not stop the walk over the rest.
    }
  }
  return false;
}

function rgba(pixmap: InstanceType<Mupdf["Pixmap"]>): Uint8Array {
  const width = pixmap.getWidth();
  const height = pixmap.getHeight();
  const stride = pixmap.getStride();
  const rgb = pixmap.getPixels();
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = y * stride + x * 3;
      const to = (y * width + x) * 4;
      out[to] = rgb[from] ?? 0;
      out[to + 1] = rgb[from + 1] ?? 0;
      out[to + 2] = rgb[from + 2] ?? 0;
      out[to + 3] = 255;
    }
  }
  return out;
}

/**
 * The object mupdf's WASM module is built on: set before mupdf loads, it
 * shows how far the module's heap has grown.
 */
function mupdfModule(): { HEAPU8?: Uint8Array } {
  const scope = globalThis as { $libmupdf_wasm_Module?: { HEAPU8?: Uint8Array } };
  scope.$libmupdf_wasm_Module ??= {};
  return scope.$libmupdf_wasm_Module;
}

async function parsePdf(bytes: Uint8Array, req: ParseRequest): Promise<ParsedFile> {
  mupdfModule();
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    // A PDF with only an owner password opens with the empty one; banks send those.
    if (doc.needsPassword() && !doc.authenticatePassword("")) {
      return { ...empty(), flags: ["encrypted"] };
    }
    const result = empty();
    const pages = doc.countPages();
    result.pages = pages;
    if (pages > MEDIA_PDF_PAGES_MAX) result.flags.push("over_caps");
    const pdf = doc.asPDF();
    if (pdf && hasActiveContent(pdf)) result.flags.push("pdf_actions");
    const links = new Set<string>();
    for (let i = 0; i < Math.min(pages, MEDIA_PDF_PAGES_MAX); i++) {
      const page = doc.loadPage(i);
      try {
        const stext = page.toStructuredText("preserve-whitespace");
        const text = stext.asText();
        stext.destroy();
        if (result.text.length < FILE_TEXT_MAX_CHARS) result.text += `${text}\n`;
        for (const link of page.getLinks()) if (link.isExternal()) links.add(link.getURI());
        if (i >= DEPTH[req.depth].pages) continue;
        const [x0, y0, x1, y1] = page.getBounds();
        const area = (x1 - x0) * (y1 - y0);
        if (!(area > 0)) continue;
        const scale = Math.min(RENDER_SCALE, Math.sqrt(RENDER_MAX_PIXELS / area));
        const pixmap = page.toPixmap(
          mupdf.Matrix.scale(scale, scale),
          mupdf.ColorSpace.DeviceRGB,
          false,
          true,
        );
        try {
          result.qr.push(...(await decodeQr(rgba(pixmap), pixmap.getWidth(), pixmap.getHeight())));
          if (text.trim().length < PAGE_TEXT_FOR_VISION) {
            const id = `p${i + 1}`;
            result.parts.push(id);
            if (req.images) result.images[id] = pixmap.asJPEG(85);
          }
        } finally {
          pixmap.destroy();
        }
      } finally {
        page.destroy();
      }
    }
    result.text = result.text.slice(0, FILE_TEXT_MAX_CHARS);
    result.links = [...links].slice(0, FILE_LINKS_MAX);
    return result;
  } finally {
    doc.destroy();
  }
}

/** Paragraph and break tags become line breaks; other tags go, so a word split into runs stays whole. */
function xmlText(xml: string): string {
  return xml
    .replace(
      /<\/(?:w:p|a:p|text:p|text:h|si|row)>|<(?:w:br|w:cr|w:tab|a:br|text:line-break|text:tab|text:s)\b[^<>]*>/g,
      "\n",
    )
    .replace(/<[^<>]*>/g, "");
}

const OFFICE = {
  ooxml: {
    text: /^(?:word\/(?:document|header\d*|footer\d*|footnotes|endnotes)|xl\/sharedStrings|ppt\/(?:slides\/slide|notesSlides\/notesSlide)\d+)\.xml$/,
    links: /\.rels$/,
    media: /^(?:word|xl|ppt)\/media\//,
  },
  odf: { text: /^(?:content|styles)\.xml$/, links: /^content\.xml$/, media: /^Pictures\// },
} as const;

/** External targets: hyperlinks, and remote templates or objects a document loads when opened. */
function officeLinks(xml: string, kind: "ooxml" | "odf"): string[] {
  if (kind === "odf") {
    return [...xml.matchAll(/\bxlink:href="([^"]*)"/g)].map((m) => m[1] ?? "");
  }
  return [...xml.matchAll(/<Relationship\b[^<>]*>/g)]
    .filter((m) => /\bTargetMode="External"/.test(m[0]))
    .map((m) => /\bTarget="([^"]*)"/.exec(m[0])?.[1] ?? "");
}

async function parseOffice(
  bytes: Uint8Array,
  directory: ZipDirectory | null,
  kind: "ooxml" | "odf",
  req: ParseRequest,
): Promise<ParsedFile> {
  if (!directory) return { ...empty(), flags: ["unreadable"] };
  const { entries } = directory;
  const result = empty();
  const flags = new Set<AttachmentFlag>(directory.overCaps ? ["over_caps"] : []);
  const read = (entry: ZipEntry): string => {
    const data = readZipEntry(bytes, entry, ZIP_PART_MAX_BYTES);
    if (!data) flags.add(entry.size > ZIP_PART_MAX_BYTES ? "over_caps" : "unreadable");
    return data?.toString("utf8") ?? "";
  };
  const parts = OFFICE[kind];
  for (const entry of entries) {
    if (parts.text.test(entry.name) && result.text.length < FILE_TEXT_MAX_CHARS) {
      result.text += `${xmlText(read(entry))}\n`;
    }
    if (parts.links.test(entry.name)) result.links.push(...officeLinks(read(entry), kind));
  }
  let images = 0;
  for (const entry of entries) {
    if (images >= DEPTH[req.depth].images) break;
    if (!parts.media.test(entry.name)) continue;
    const data = readZipEntry(bytes, entry, ZIP_PART_MAX_BYTES);
    if (!data || !sniffImageType(data)) continue;
    const id = `i${++images}`;
    const found = await imageQr(data);
    result.qr.push(...found.qr);
    result.parts.push(id);
    if (req.images) result.images[id] = data;
  }
  result.text = result.text.slice(0, FILE_TEXT_MAX_CHARS);
  result.links = [...new Set(result.links.filter((link) => /^[a-z][a-z0-9+.-]*:/i.test(link)))];
  result.flags = [...flags];
  return result;
}

/** A Wallet pass: its fields' text, and what its barcodes encode. */
function parsePass(bytes: Uint8Array, directory: ZipDirectory | null): ParsedFile {
  const entry = directory?.entries.find((e) => e.name === "pass.json");
  const data = entry && readZipEntry(bytes, entry, ZIP_PART_MAX_BYTES);
  if (!data) return { ...empty(), flags: ["unreadable"] };
  const strings: string[] = [];
  const barcodes: string[] = [];
  const walk = (value: unknown, key = ""): void => {
    if (typeof value === "string") (key === "message" ? barcodes : strings).push(value);
    else if (Array.isArray(value)) for (const item of value) walk(item, key);
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  try {
    walk(JSON.parse(data.toString("utf8")));
  } catch {
    return { ...empty(), flags: ["unreadable"] };
  }
  return { ...empty(), text: strings.join("\n").slice(0, FILE_TEXT_MAX_CHARS), qr: barcodes };
}

async function parseFile(bytes: Uint8Array, req: ParseRequest): Promise<ParsedFile> {
  const directory = readZipDirectory(bytes);
  const kind = sniffFileType(bytes, directory);
  try {
    if (kind === "pdf") return await parsePdf(bytes, req);
    if (kind === "ooxml" || kind === "odf") return await parseOffice(bytes, directory, kind, req);
    if (kind === "pkpass") return parsePass(bytes, directory);
    if (kind === "svg" || sniffImageType(bytes)) return { ...empty(), ...(await imageQr(bytes)) };
    return empty();
  } catch {
    return { ...empty(), flags: ["unreadable"] };
  }
}

export async function parseFiles(req: ParseRequest): Promise<ParsedFile[]> {
  const parsed: ParsedFile[] = [];
  for (const bytes of req.files) parsed.push(await parseFile(bytes, req));
  return parsed;
}

if (!isMainThread && workerData === THREAD && parentPort) {
  const port = parentPort;
  const wasmBytes = () => mupdfModule().HEAPU8?.byteLength ?? 0;
  port.on("message", (req: ParseRequest) => {
    parseFiles(req).then(
      (result) => port.postMessage({ ok: true, result, wasmBytes: wasmBytes() }),
      (err: unknown) =>
        port.postMessage({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          wasmBytes: wasmBytes(),
        }),
    );
  });
}
