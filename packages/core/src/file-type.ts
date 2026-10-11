import { inflateRawSync } from "node:zlib";

/**
 * What a file is, read from its leading bytes: the name and the declared type
 * are the sender's word, the bytes are what a reader opens. Pure, apart from
 * zlib for reading one ZIP entry.
 */

export type ImageType = "png" | "jpeg" | "gif" | "webp" | "bmp" | "tiff" | "avif";
export type ArchiveType = "zip" | "rar" | "7z" | "gzip" | "bzip2" | "xz" | "zstd";
export type ExecutableType = "pe" | "elf" | "macho" | "lnk";
/** ooxml, odf and pkpass are ZIPs told apart by their entry names; ole is the legacy Office container. */
export type FileKind =
  | ImageType
  | ArchiveType
  | ExecutableType
  | "pdf"
  | "ooxml"
  | "odf"
  | "pkpass"
  | "ole"
  | "html"
  | "svg"
  | "unknown";

export const IMAGE_TYPES: readonly ImageType[] = [
  "png",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "avif",
];

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  return signature.every((byte, i) => bytes[at + i] === byte);
}

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  return [...text].every((ch, i) => bytes[at + i] === ch.charCodeAt(0));
}

/** Bounds-safe, unlike Buffer.readUInt32LE: past the end reads as zero. */
function uint32le(bytes: Uint8Array, at: number): number {
  const byte = (i: number) => bytes[at + i] ?? 0;
  return byte(0) + (byte(1) << 8) + (byte(2) << 16) + byte(3) * 0x1000000;
}

/** Identifies a raster image from its magic bytes. Null for anything else, SVG included. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) return "gif";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "webp";
  // "BM" alone is two letters of text; the DIB header size behind it is not.
  if (ascii(bytes, 0, "BM") && [12, 40, 52, 56, 64, 108, 124].includes(uint32le(bytes, 14))) {
    return "bmp";
  }
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return "tiff";
  }
  if (ascii(bytes, 4, "ftypavif") || ascii(bytes, 4, "ftypavis")) return "avif";
  return null;
}

const MARKUP_HEAD_BYTES = 1024;
// The tags a browser takes for HTML when a file starts with one (the WHATWG
// sniffing list), plus the ones phishing pages open with.
const HTML_START =
  /^<(?:!doctype html|html|head|body|script|iframe|h1|div|font|table|a|style|title|b|br|p|meta|form|img|link)[\s/>]/;

function sniffMarkup(bytes: Uint8Array): "html" | "svg" | null {
  let head = Buffer.from(bytes.subarray(0, MARKUP_HEAD_BYTES))
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  // An XML declaration, a doctype that is not HTML's and comments say nothing yet.
  for (;;) {
    const skipped = head.replace(/^(?:<\?xml[^>]*>|<!--[\s\S]*?-->|<!doctype svg[^>]*>)\s*/, "");
    if (skipped === head) break;
    head = skipped;
  }
  if (/^<svg[\s/>]/.test(head)) return "svg";
  return HTML_START.test(head) ? "html" : null;
}

function sniffExecutable(bytes: Uint8Array): ExecutableType | null {
  if (ascii(bytes, 0, "MZ")) {
    const peOffset = uint32le(bytes, 0x3c);
    if (peOffset + 4 <= bytes.length && startsWith(bytes, [0x50, 0x45, 0, 0], peOffset)) {
      return "pe";
    }
  }
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return "elf";
  const machO = [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
  ];
  if (machO.some((signature) => startsWith(bytes, signature))) return "macho";
  if (startsWith(bytes, [0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0x00])) return "lnk";
  return null;
}

function sniffArchive(bytes: Uint8Array): Exclude<ArchiveType, "zip"> | null {
  if (ascii(bytes, 0, "Rar!") && bytes[4] === 0x1a && bytes[5] === 0x07) return "rar";
  if (startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "7z";
  if (startsWith(bytes, [0x1f, 0x8b])) return "gzip";
  if (ascii(bytes, 0, "BZh")) return "bzip2";
  if (startsWith(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return "xz";
  if (startsWith(bytes, [0x28, 0xb5, 0x2f, 0xfd])) return "zstd";
  return null;
}

/** A ZIP's own kind: Office, OpenDocument and Wallet passes are ZIPs with known entries. */
function zipKind(directory: ZipDirectory | null): "zip" | "ooxml" | "odf" | "pkpass" {
  const names = new Set(directory?.entries.map((entry) => entry.name.toLowerCase()));
  if (names.has("[content_types].xml")) return "ooxml";
  if (names.has("mimetype") && (names.has("content.xml") || names.has("meta-inf/manifest.xml"))) {
    return "odf";
  }
  if (names.has("pass.json") && names.has("manifest.json")) return "pkpass";
  return "zip";
}

/**
 * The kind of file the bytes are, whatever its name says. A PDF header may
 * sit anywhere in the first KB, as readers accept it there. Pass the ZIP
 * directory when it is already read, so a file's directory is parsed once.
 */
export function sniffFileType(bytes: Uint8Array, directory?: ZipDirectory | null): FileKind {
  const image = sniffImageType(bytes);
  if (image) return image;
  if (ascii(bytes, 0, "PK\x03\x04") || ascii(bytes, 0, "PK\x05\x06")) {
    return zipKind(directory === undefined ? readZipDirectory(bytes) : directory);
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";
  const kind = sniffArchive(bytes) ?? sniffExecutable(bytes);
  if (kind) return kind;
  if (Buffer.from(bytes.subarray(0, 1024)).includes("%PDF-")) return "pdf";
  return sniffMarkup(bytes) ?? "unknown";
}

export interface ZipEntry {
  /**
   * The central directory's name, plus any other name the archive gives the
   * same entry (its local header, the Info-ZIP Unicode path): unzip tools
   * disagree on which one they show, so a check must see all of them.
   */
  names: string[];
  name: string;
  /** General-purpose flag bit 0: the entry's data is encrypted. */
  encrypted: boolean;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export interface ZipDirectory {
  entries: ZipEntry[];
  /**
   * Past a cap: more than ZIP_MAX_ENTRIES entries (the listing stops there),
   * a name longer than ZIP_NAME_MAX_BYTES (read from its end, where its
   * extension is), or more than ZIP_NAMES_MAX_BYTES of names in all.
   */
  overCaps: boolean;
}

const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const UNICODE_PATH = 0x7075;
/** More entries than any real attachment has. */
const ZIP_MAX_ENTRIES = 10_000;
const ZIP_NAME_MAX_BYTES = 1_024;
/** Every entry can name the same 64 KB local header: without a total, names cost 10,000 times that. */
const ZIP_NAMES_MAX_BYTES = 1_048_576;

/** Where the end-of-central-directory record starts: within the last 64 KB, the comment's limit. */
function findEocd(buf: Buffer): number {
  const at = buf.lastIndexOf(EOCD, buf.length - 22);
  return at >= 0 && at >= buf.length - 22 - 0xffff ? at : -1;
}

/**
 * Reads a ZIP's central directory with no library, whatever bytes come
 * before it: a ZIP appended to a PDF or an image is read too. Null when the
 * bytes hold no readable directory.
 */
export function readZipDirectory(bytes: Uint8Array): ZipDirectory | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(buf);
  if (eocd < 0) return null;
  let count = buf.readUInt16LE(eocd + 10);
  let directorySize = buf.readUInt32LE(eocd + 12);
  let offset = buf.readUInt32LE(eocd + 16);
  if ((count === 0xffff || offset === 0xffffffff) && eocd >= 20) {
    if (buf.readUInt32LE(eocd - 20) !== ZIP64_LOCATOR) return null;
    const record = Number(buf.readBigUInt64LE(eocd - 12));
    if (record + 56 > buf.length || buf.readUInt32LE(record) !== ZIP64_EOCD) return null;
    count = Number(buf.readBigUInt64LE(record + 32));
    directorySize = Number(buf.readBigUInt64LE(record + 40));
    offset = Number(buf.readBigUInt64LE(record + 48));
  }
  // Offsets count from the ZIP's own start; bytes put in front of it (a PDF
  // or an image, a self-extractor's stub) shift everything, and unzip tools
  // find the directory from its end all the same.
  let shift = 0;
  const at = (position: number) => position + 4 <= buf.length && position >= 0;
  if (!(at(offset) && buf.readUInt32LE(offset) === CENTRAL)) {
    const start = eocd - directorySize;
    if (!(at(start) && buf.readUInt32LE(start) === CENTRAL)) {
      return count === 0 ? { entries: [], overCaps: false } : null;
    }
    shift = start - offset;
    offset = start;
  }
  let overCaps = count > ZIP_MAX_ENTRIES;
  let nameBytes = 0;
  const name = (start: number, length: number, utf8: boolean): string => {
    const kept = Math.min(length, ZIP_NAME_MAX_BYTES);
    if (kept < length) overCaps = true;
    nameBytes += kept;
    return buf.toString(utf8 ? "utf8" : "latin1", start + length - kept, start + length);
  };
  const unicodePath = (start: number, end: number): string | null => {
    for (let p = start; p + 4 <= end; ) {
      const id = buf.readUInt16LE(p);
      const size = buf.readUInt16LE(p + 2);
      if (id === UNICODE_PATH && size > 5 && p + 4 + size <= end)
        return name(p + 9, size - 5, true);
      p += 4 + size;
    }
    return null;
  };
  // Many central entries may point at one local header: read each header's name once.
  const localNames = new Map<number, string | null>();
  const entries: ZipEntry[] = [];
  let p = offset;
  for (let n = 0; n < Math.min(count, ZIP_MAX_ENTRIES); n++) {
    if (nameBytes > ZIP_NAMES_MAX_BYTES) {
      overCaps = true;
      break;
    }
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) return null;
    const flags = buf.readUInt16LE(p + 8);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42) + shift;
    const utf8 = (flags & 0x800) !== 0;
    const central = name(p + 46, nameLength, utf8);
    const names = new Set([central]);
    const extraStart = p + 46 + nameLength;
    const alias = unicodePath(extraStart, Math.min(buf.length, extraStart + extraLength));
    if (alias) names.add(alias);
    if (!localNames.has(localOffset)) {
      const local =
        localOffset + 30 <= buf.length && buf.readUInt32LE(localOffset) === LOCAL
          ? name(localOffset + 30, buf.readUInt16LE(localOffset + 26), utf8)
          : null;
      localNames.set(localOffset, local);
    }
    const local = localNames.get(localOffset);
    if (local) names.add(local);
    entries.push({
      name: central,
      names: [...names],
      encrypted: (flags & 1) !== 0,
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localOffset,
    });
    p = extraStart + extraLength + commentLength;
  }
  return { entries, overCaps };
}

/**
 * One entry's bytes, stored or deflated, never more than maxBytes: a ZIP
 * bomb stops at the cap instead of filling memory. Null when the entry is
 * encrypted, uses another method, is cut short or inflates past the cap.
 */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes: number): Buffer | null {
  if (entry.encrypted) return null;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localOffset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL) return null;
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (data.length < entry.compressedSize) return null;
  if (entry.method === 0) return data.length <= maxBytes ? data : null;
  if (entry.method !== 8) return null;
  try {
    return inflateRawSync(data, { maxOutputLength: maxBytes });
  } catch {
    return null;
  }
}
