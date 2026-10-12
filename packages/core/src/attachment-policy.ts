import {
  type FileKind,
  IMAGE_TYPES,
  readZipDirectory,
  sniffFileType,
  type ZipEntry,
} from "./file-type.js";

/**
 * Which attachments may leave. One function decides for every path: the API
 * refuses what it rejects, the send path parks what it flags for a team that
 * is still new, and the judge sees the flags of what it lets through.
 */

/**
 * Refused for every team: SES's 90 extensions plus the 21 more Gmail blocks
 * (https://docs.aws.amazon.com/ses/latest/dg/attachments.html#mime-types,
 * https://support.google.com/mail/answer/6590). SES fails the send after we
 * accepted it; Gmail bounces it.
 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    "ade adp apk app appx appxbundle asp bas bat cab cer chm cmd com cpl crt csh der diagcab " +
    "diagcfg diagpkg dll dmg ex ex_ exe fxp gadget hlp hta img inf ins iso isp its jar jnlp js " +
    "jse ksh lib lnk mad maf mag mam maq mar mas mat mau mav maw mda mdb mde mdt mdw mdz mjs msc " +
    "msh msh1 msh1xml msh2 msh2xml mshxml msi msix msixbundle msp mst nsh ops pcd pif plg prf prg " +
    "ps1 ps1xml ps2 ps2xml psc1 psc2 reg scf scr sct shb shs sys tmp url vb vbe vbs vhd vps " +
    "vsmacros vss vst vsw vxd ws wsc wsf wsh xll xnk"
  ).split(" "),
);

/** Declared types that name a program, refused like the extensions above. */
export const BLOCKED_CONTENT_TYPES: ReadonlySet<string> = new Set(
  (
    "application/x-msdownload application/x-msdos-program application/x-dosexec " +
    "application/x-ms-dos-executable application/vnd.microsoft.portable-executable " +
    "application/x-executable application/x-elf application/x-mach-binary application/x-msi " +
    "application/x-ms-installer application/x-ms-shortcut application/x-mswinurl application/hta " +
    "application/x-bat application/x-csh application/javascript application/x-javascript " +
    "text/javascript application/ecmascript text/ecmascript text/vbscript application/java-archive " +
    "application/x-java-archive application/x-java-jnlp-file " +
    "application/vnd.android.package-archive application/x-apple-diskimage " +
    "application/x-iso9660-image application/vnd.ms-cab-compressed application/x-msaccess " +
    "application/vnd.ms-htmlhelp"
  ).split(" "),
);

/** Why a file waits for a person when its team is new; frozen names the console and the judge read. */
export const ATTACHMENT_FLAGS = [
  "markup",
  "archive",
  "disk_image",
  "macros",
  "risky_type",
  "type_mismatch",
  "encrypted",
  "pdf_actions",
  "nested_archive",
  "scripts",
  "forms",
  "over_caps",
  "unreadable",
] as const;
export type AttachmentFlag = (typeof ATTACHMENT_FLAGS)[number];

function groups(spec: Record<string, string>): Map<string, AttachmentFlag> {
  return new Map(
    Object.entries(spec).flatMap(([flag, list]) =>
      list.split(" ").map((item) => [item, flag as AttachmentFlag] as const),
    ),
  );
}

const ARCHIVES = "zip zipx rar 7z gz tgz bz2 tbz tbz2 xz txz tar zst lz lzh lha arj ace z cpio";
const ARCHIVE_EXTENSIONS = new Set(ARCHIVES.split(" "));

const PARKED_EXTENSIONS = groups({
  markup: "htm html shtml xhtml xht mht mhtml svg svgz",
  archive: ARCHIVES,
  disk_image: "vhdx",
  macros: "docm dotm xlsm xltm xlam xlsb pptm potm ppam ppsm sldm",
  risky_type: "one onepkg rtf eml msg",
});

const PARKED_CONTENT_TYPES = groups({
  markup: "text/html application/xhtml+xml image/svg+xml",
  risky_type:
    "message/rfc822 application/vnd.ms-outlook application/onenote application/rtf text/rtf",
  archive:
    "application/zip application/x-zip-compressed application/vnd.rar " +
    "application/x-rar-compressed application/x-7z-compressed application/gzip application/x-gzip " +
    "application/x-tar application/x-bzip2 application/x-xz application/zstd",
});

/** A single compressed file shows its inner name too: x.exe.gz is an .exe. */
const COMPRESSION_EXTENSIONS = new Set(["gz", "bz2", "xz", "z", "zst", "lz"]);

const ARCHIVE_KINDS: ReadonlySet<FileKind> = new Set([
  "zip",
  "rar",
  "7z",
  "gzip",
  "bzip2",
  "xz",
  "zstd",
]);

const EXECUTABLE_KINDS: Partial<Record<FileKind, string>> = {
  pe: "a Windows program",
  elf: "a Linux program",
  macho: "a macOS program",
  lnk: "a Windows shortcut",
};

const ZIP_FAMILY: readonly FileKind[] = ["zip", "ooxml", "odf", "pkpass"];
const OOXML_EXTENSIONS =
  "docx docm dotx dotm xlsx xlsm xltx xltm xlam xlsb pptx pptm potx potm ppsx ppsm ppam sldm";

/** What the bytes of a file with this extension must be; extensions not listed claim nothing. */
const EXPECTED_KINDS = new Map<string, readonly FileKind[]>([
  ["pdf", ["pdf"]],
  ...["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "avif"].map(
    (ext) => [ext, IMAGE_TYPES] as const,
  ),
  ...OOXML_EXTENSIONS.split(" ").map((ext) => [ext, ["ooxml"]] as const),
  ...["odt", "ods", "odp"].map((ext) => [ext, ["odf"]] as const),
  ["pkpass", ["pkpass"]],
  ...["doc", "xls", "ppt", "msg"].map((ext) => [ext, ["ole"]] as const),
  ["zip", ZIP_FAMILY],
  ["rar", ["rar"]],
  ["7z", ["7z"]],
  ["gz", ["gzip"]],
  ["tgz", ["gzip"]],
  ["bz2", ["bzip2"]],
  ["xz", ["xz"]],
  ["zst", ["zstd"]],
]);

/**
 * The extension a reader acts on, lowercased with trailing dots and spaces
 * dropped (Windows drops them too), then the inner one when the last only
 * says the file is compressed.
 */
export function fileExtensions(filename: string): string[] {
  // A loop, not /[. ]+$/: that regex backtracks quadratically on a long run of
  // dots or spaces that does not reach the end of the name.
  let end = filename.length;
  while (end > 0 && (filename[end - 1] === "." || filename[end - 1] === " ")) end -= 1;
  const base = filename.slice(0, end).split(/[\\/]/).pop() ?? "";
  const parts = base.toLowerCase().split(".").slice(1);
  const last = parts.at(-1);
  if (last === undefined) return [];
  const inner = parts.at(-2);
  return inner !== undefined && COMPRESSION_EXTENSIONS.has(last) ? [last, inner] : [last];
}

/** The declared type, lowercased and without parameters. */
function mediaType(contentType: string | undefined): string | null {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  return type ? type : null;
}

/** An RFC 7231 token, as a media type's type, subtype and parameters are written. */
export const MEDIA_TYPE_TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const BARE_MEDIA_TYPE = new RegExp(`^${MEDIA_TYPE_TOKEN}/${MEDIA_TYPE_TOKEN}$`);
const CHARSET_PARAM = new RegExp(`;\\s*charset\\s*=\\s*"?(${MEDIA_TYPE_TOKEN})"?\\s*(?=;|$)`, "i");

/**
 * The Content-Type an attachment goes out with: the declared media type and
 * its charset, every other parameter dropped; undefined when none usable
 * was declared, and the MIME writer infers it. A declared `name` would give
 * the file a second name the policy never checked, beside the one the
 * writer takes from the checked filename.
 */
export function sentContentType(contentType: string | undefined): string | undefined {
  const type = mediaType(contentType);
  if (!type || !BARE_MEDIA_TYPE.test(type)) return undefined;
  const charset = CHARSET_PARAM.exec(contentType ?? "")?.[1];
  return charset ? `${type}; charset=${charset}` : type;
}

/** UTF-16LE, the way OLE directory entries store stream names. */
function oleStream(name: string): Buffer {
  return Buffer.from(name, "utf16le");
}
const OLE_VBA = oleStream("_VBA_PROJECT");
const OLE_ENCRYPTED = oleStream("EncryptedPackage");

function entryFlags(
  entries: readonly ZipEntry[],
  kind: FileKind,
  archive: boolean,
): AttachmentFlag[] {
  const flags: AttachmentFlag[] = [];
  for (const entry of entries) {
    if (entry.encrypted) flags.push("encrypted");
    for (const name of entry.names) {
      const lower = name.toLowerCase();
      if (lower.endsWith("vbaproject.bin")) flags.push("macros");
      if (kind === "odf" && /^(?:basic|scripts)\//.test(lower)) flags.push("macros");
      if (archive && fileExtensions(name).some((ext) => ARCHIVE_EXTENSIONS.has(ext))) {
        flags.push("nested_archive");
      }
    }
  }
  return flags;
}

/**
 * The controls that reverse or isolate text direction, which can show
 * invoice<U+202E>fdp.exe as invoiceexe.pdf. Other format characters are
 * fine in a name: Persian spelling uses U+200C, emoji sequences U+200D.
 */
const DIRECTION_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** How an attachment without a filename (an inline image, say) is named where a name is shown. */
export const UNNAMED_ATTACHMENT = "(unnamed)";

/** A filename for an API message: invisible characters spelled out, length capped. */
function shownName(filename: string | undefined): string {
  if (!filename) return "An unnamed attachment";
  const visible = filename.replace(
    /\p{Cf}/gu,
    (ch) => `<U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>`,
  );
  return JSON.stringify(visible.length > 120 ? `${visible.slice(0, 119)}…` : visible);
}

export interface AttachmentFile {
  /** Absent for an unnamed part, such as an inline image. */
  filename?: string | undefined;
  contentType?: string | undefined;
  bytes: Uint8Array;
}

/** Why a file is refused for every team; frozen names reports count by. */
export const ATTACHMENT_REJECTIONS = [
  "direction_controls",
  "blocked_extension",
  "blocked_type",
  "executable",
  "blocked_in_archive",
] as const;
export type AttachmentRejection = (typeof ATTACHMENT_REJECTIONS)[number];

/**
 * reject: refused for every team, with a sentence naming the file and why,
 * fit for an API error. park: waits for a person while the team is new.
 * allow: sent. `kind` is what the bytes are, whatever the name says.
 */
export type AttachmentVerdict =
  | {
      action: "reject";
      kind: FileKind;
      flags: AttachmentFlag[];
      rejection: AttachmentRejection;
      reason: string;
    }
  | { action: "park" | "allow"; kind: FileKind; flags: AttachmentFlag[] };

/**
 * The verdict on one attachment. `found` carries flags only a full read can
 * raise (a PDF that needs a password, a parse that timed out); the byte-level
 * checks here run on every call, so the API's call without them still
 * refuses everything refusable.
 */
export function attachmentVerdict(
  file: AttachmentFile,
  found: readonly AttachmentFlag[] = [],
): AttachmentVerdict {
  // Read wherever an end-of-central-directory record is: a ZIP behind other
  // bytes (a PDF or image polyglot) opens in unzip tools all the same.
  const directory = readZipDirectory(file.bytes);
  const kind = sniffFileType(file.bytes, directory);
  const reject = (rejection: AttachmentRejection, why: string): AttachmentVerdict => ({
    action: "reject",
    kind,
    flags: [],
    rejection,
    reason: `${shownName(file.filename)} is refused: ${why}`,
  });
  const name = file.filename ?? "";
  const control = DIRECTION_CONTROLS.exec(name)?.[0];
  if (control) {
    const code = (control.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
    return reject(
      "direction_controls",
      `its name holds a text-direction control (U+${code}) that can disguise the file's type`,
    );
  }
  const extensions = fileExtensions(name);
  const blocked = extensions.find((ext) => BLOCKED_EXTENSIONS.has(ext));
  if (blocked) return reject("blocked_extension", `.${blocked} files can't be sent`);
  const type = mediaType(file.contentType);
  if (type && BLOCKED_CONTENT_TYPES.has(type)) {
    return reject(
      "blocked_type",
      `its content_type ${type} is a program type, which can't be sent`,
    );
  }
  const program = EXECUTABLE_KINDS[kind];
  if (program) {
    return reject("executable", `its content is ${program}, which can't be sent under any name`);
  }
  const entries = directory?.entries ?? [];
  for (const name of entries.flatMap((entry) => entry.names)) {
    const inner = fileExtensions(name).find((ext) => BLOCKED_EXTENSIONS.has(ext));
    if (inner) {
      return reject(
        "blocked_in_archive",
        `it holds ${shownName(name)}, and .${inner} files can't be sent`,
      );
    }
  }

  const flags = new Set<AttachmentFlag>(found);
  for (const ext of extensions) {
    const flag = PARKED_EXTENSIONS.get(ext);
    if (flag) flags.add(flag);
  }
  if (type) {
    const flag =
      PARKED_CONTENT_TYPES.get(type) ?? (type.includes("macroenabled") ? "macros" : null);
    if (flag) flags.add(flag);
  }
  const polyglot = entries.length > 0 && !ZIP_FAMILY.includes(kind);
  if (ARCHIVE_KINDS.has(kind) || polyglot) flags.add("archive");
  if (kind === "html" || kind === "svg") flags.add("markup");
  const expected = extensions[0] === undefined ? undefined : EXPECTED_KINDS.get(extensions[0]);
  if (expected && !expected.includes(kind)) flags.add("type_mismatch");
  if (ZIP_FAMILY.includes(kind) && directory === null) flags.add("unreadable");
  if (directory?.overCaps) flags.add("over_caps");
  for (const flag of entryFlags(entries, kind, kind === "zip" || polyglot)) flags.add(flag);
  if (kind === "ole") {
    const bytes = Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength);
    if (bytes.includes(OLE_VBA)) flags.add("macros");
    if (bytes.includes(OLE_ENCRYPTED)) flags.add("encrypted");
  }
  return { action: flags.size > 0 ? "park" : "allow", kind, flags: [...flags] };
}
