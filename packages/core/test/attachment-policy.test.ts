import { describe, expect, it } from "vitest";
import {
  attachmentVerdict,
  BLOCKED_CONTENT_TYPES,
  BLOCKED_EXTENSIONS,
  fileExtensions,
  sentContentType,
} from "../src/attachment-policy.js";
import { readZipDirectory, readZipEntry, sniffFileType, sniffImageType } from "../src/file-type.js";

interface Entry {
  name: string;
  data?: string | Uint8Array;
  encrypted?: boolean;
  /** A different name in the local header than in the central directory. */
  localName?: string;
}

/** A stored (uncompressed) ZIP, enough for directory checks. */
function zip(entries: Entry[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const localName = Buffer.from(entry.localName ?? entry.name);
    const data = Buffer.from(entry.data ?? "");
    const flags = 0x800 | (entry.encrypted ? 1 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(localName.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(flags, 8);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    parts.push(local, localName, data);
    central.push(head, name);
    offset += 30 + localName.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const text = (s: string) => new TextEncoder().encode(s);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const PDF = text("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
const PE = (() => {
  const bytes = new Uint8Array(0x80);
  bytes.set(text("MZ"), 0);
  bytes[0x3c] = 0x40;
  bytes.set(text("PE\0\0"), 0x40);
  return bytes;
})();
const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
const MACH_O = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]);
const LNK = new Uint8Array([0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0x00, 0, 0, 0, 0]);
const OLE = new Uint8Array([
  0xd0,
  0xcf,
  0x11,
  0xe0,
  0xa1,
  0xb1,
  0x1a,
  0xe1,
  ...new Array(64).fill(0),
]);
const DOCX_ENTRIES: Entry[] = [
  { name: "[Content_Types].xml", data: "<Types/>" },
  { name: "word/document.xml", data: "<w:document/>" },
];
const DOCX = zip(DOCX_ENTRIES);

const verdict = (filename: string, bytes: Uint8Array, contentType?: string) =>
  attachmentVerdict({ filename, bytes, contentType });

describe("file types", () => {
  it("identifies images by magic bytes, never by a text that looks like one", () => {
    expect(sniffImageType(PNG)).toBe("png");
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffImageType(text("RIFF\x24\0\0\0WEBPVP"))).toBe("webp");
    expect(sniffImageType(text("GIF89a......"))).toBe("gif");
    expect(sniffImageType(text("BM is a car brand, not a bitmap"))).toBeNull();
    expect(sniffImageType(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(PNG.slice(0, 4))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
    const riffOnly = text("RIFF\x24\0\0\0AVI LIST");
    expect(sniffImageType(riffOnly)).toBeNull();
  });

  it("tells programs, archives, documents and markup apart", () => {
    expect([PE, ELF, MACH_O, LNK].map((bytes) => sniffFileType(bytes))).toEqual([
      "pe",
      "elf",
      "macho",
      "lnk",
    ]);
    expect(sniffFileType(text("MZ but no PE header behind it"))).toBe("unknown");
    expect(sniffFileType(OLE)).toBe("ole");
    expect(sniffFileType(DOCX)).toBe("ooxml");
    expect(sniffFileType(zip([{ name: "mimetype" }, { name: "content.xml" }]))).toBe("odf");
    expect(sniffFileType(zip([{ name: "pass.json" }, { name: "manifest.json" }]))).toBe("pkpass");
    expect(sniffFileType(zip([{ name: "a.txt" }]))).toBe("zip");
    expect(sniffFileType(text("Rar!\x1a\x07\x01\0"))).toBe("rar");
    expect(sniffFileType(new Uint8Array([0x1f, 0x8b, 8, 0]))).toBe("gzip");
    expect(sniffFileType(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]))).toBe("zstd");
    // Readers accept a PDF header anywhere in the first KB.
    expect(sniffFileType(text(`${"junk ".repeat(50)}%PDF-1.4`))).toBe("pdf");
    expect(sniffFileType(text("\uFEFF  <!DOCTYPE html><html>"))).toBe("html");
    expect(sniffFileType(text("<script>location='https://x.example'</script>"))).toBe("html");
    expect(
      sniffFileType(text('<?xml version="1.0"?>\n<!-- logo --><svg viewBox="0 0 1 1"/>')),
    ).toBe("svg");
    // NF-e and other XML stay plain data.
    expect(sniffFileType(text('<?xml version="1.0"?><nfeProc versao="4.00"><prod/>'))).toBe(
      "unknown",
    );
    expect(sniffFileType(text("BEGIN:VCALENDAR\r\nEND:VCALENDAR"))).toBe("unknown");
  });

  it("reads every name a ZIP gives an entry, and caps what an entry inflates to", () => {
    const directory = readZipDirectory(
      zip([{ name: "readme.txt", localName: "run.js", data: "x" }]),
    );
    expect(directory?.entries[0]?.names).toEqual(["readme.txt", "run.js"]);
    expect(directory?.overCaps).toBe(false);
    expect(readZipDirectory(text("PK\x03\x04 truncated"))).toBeNull();
    const archive = zip([{ name: "a.txt", data: "hello" }]);
    const [entry] = readZipDirectory(archive)?.entries ?? [];
    if (!entry) throw new Error("entry missing");
    expect(readZipEntry(archive, entry, 100)?.toString()).toBe("hello");
    expect(readZipEntry(archive, entry, 4)).toBeNull();
  });
});

describe("fileExtensions", () => {
  it.each([
    ["Invoice.EXE", ["exe"]],
    ["invoice.exe.", ["exe"]],
    ["invoice.exe . .", ["exe"]],
    ["x.exe.gz", ["gz", "exe"]],
    ["x.tar.zst", ["zst", "tar"]],
    ["report.pdf.exe", ["exe"]],
    ["dir/sub.d/file", []],
    ["noext", []],
  ])("%s → %j", (name, expected) => {
    expect(fileExtensions(name)).toEqual(expected);
  });

  it("reads a long run of dots in linear time", () => {
    expect(fileExtensions(`${".".repeat(200_000)}x`)).toEqual(["x"]);
    expect(fileExtensions(`a${" .".repeat(100_000)}`)).toEqual([]);
  });
});

describe("attachmentVerdict: refused for every team", () => {
  it("covers SES's 90 and Gmail's 21 extensions, and the 30 program types", () => {
    expect(BLOCKED_EXTENSIONS.size).toBe(111);
    expect(BLOCKED_CONTENT_TYPES.size).toBe(30);
  });

  it.each([...BLOCKED_EXTENSIONS])("refuses .%s", (ext) => {
    expect(verdict(`file.${ext}`, text("hello"))).toMatchObject({
      action: "reject",
      rejection: "blocked_extension",
      reason: expect.stringContaining(`.${ext} files can't be sent`),
    });
  });

  it("checks the name a compressed file hides and ignores trailing dots and spaces", () => {
    for (const name of ["x.exe.gz", "x.exe.", "x.exe ", "X.Exe", "payload.js.zst"]) {
      expect(verdict(name, text("hello")).action, name).toBe("reject");
    }
  });

  it("refuses a name that hides its real type behind an invisible character", () => {
    // Displays as "invoicefdp.exe" while the real extension is .pdf.
    expect(verdict("invoice\u202Eexe.pdf", PDF)).toMatchObject({
      action: "reject",
      rejection: "direction_controls",
      reason:
        '"invoice<U+202E>exe.pdf" is refused: its name holds a text-direction control (U+202E) that can disguise the file\'s type',
    });
  });

  it.each([...BLOCKED_CONTENT_TYPES])("refuses the declared type %s", (type) => {
    expect(verdict("data.bin", text("hello"), type)).toMatchObject({
      action: "reject",
      rejection: "blocked_type",
    });
  });

  it("reads the declared type without case or parameters", () => {
    expect(verdict("a.txt", text("x"), "Application/JavaScript; charset=utf-8").action).toBe(
      "reject",
    );
  });

  it.each([
    ["pe", PE],
    ["elf", ELF],
    ["macho", MACH_O],
    ["lnk", LNK],
  ])("refuses %s bytes named .pdf", (kind, bytes) => {
    expect(verdict("fatura.pdf", bytes)).toMatchObject({
      action: "reject",
      rejection: "executable",
      kind,
      reason: expect.stringMatching(
        /^"fatura\.pdf" is refused: its content is a .+, which can't be sent under any name$/,
      ),
    });
  });

  it("refuses a ZIP holding a blocked file, under any of the entry's names", () => {
    expect(verdict("files.zip", zip([{ name: "a/run.js", data: "alert(1)" }]))).toMatchObject({
      action: "reject",
      rejection: "blocked_in_archive",
      reason: '"files.zip" is refused: it holds "a/run.js", and .js files can\'t be sent',
    });
    const disguised = zip([{ name: "a/readme.txt", localName: "a/run.js", data: "x" }]);
    expect(verdict("files.zip", disguised).action).toBe("reject");
    expect(verdict("report.docx", zip([...DOCX_ENTRIES, { name: "x.exe" }])).action).toBe("reject");
  });
});

describe("attachmentVerdict: parked while the team is new", () => {
  it.each([
    ["an encrypted ZIP entry", "docs.zip", zip([{ name: "a.pdf", encrypted: true }]), "encrypted"],
    ["a ZIP inside a ZIP", "docs.zip", zip([{ name: "inner.zip", data: "PK" }]), "nested_archive"],
    [
      "a .docx with a VBA project",
      "report.docx",
      zip([...DOCX_ENTRIES, { name: "word/vbaProject.bin" }]),
      "macros",
    ],
    ["a .docx that is really an OLE file", "report.docx", OLE, "type_mismatch"],
    ["an .html file", "invoice.html", text("<!DOCTYPE html><html><form></form>"), "markup"],
    ["HTML bytes under any name", "invoice.pdf", text("<html><body>Pay</body></html>"), "markup"],
    ["a .pdf that is really a ZIP", "invoice.pdf", zip([{ name: "a.txt" }]), "type_mismatch"],
    ["an .svg file", "logo.svg", text("<svg/>"), "markup"],
    ["a macro-enabled workbook", "sheet.xlsm", text("x"), "macros"],
    ["an attached e-mail", "fwd.eml", text("From: a@b.example"), "risky_type"],
    ["a disk image", "disk.vhdx", text("vhdxfile"), "disk_image"],
    ["RAR bytes", "photos.dat", text("Rar!\x1a\x07\x00"), "archive"],
  ])("parks %s", (_label, name, bytes, flag) => {
    const result = verdict(name, bytes);
    expect(result.action).toBe("park");
    expect(result.flags).toContain(flag);
  });

  it("flags a legacy Office file carrying a VBA project, and an OLE-wrapped encrypted document", () => {
    const withVba = new Uint8Array([...OLE, ...Buffer.from("_VBA_PROJECT", "utf16le")]);
    expect(verdict("old.doc", withVba).flags).toEqual(["macros"]);
    const locked = new Uint8Array([...OLE, ...Buffer.from("EncryptedPackage", "utf16le")]);
    expect(verdict("locked.xlsx", locked).flags).toEqual(["type_mismatch", "encrypted"]);
  });

  it("parks declared risky types and keeps flags a full read found", () => {
    expect(verdict("page.txt", text("hi"), "text/html; charset=utf-8").flags).toEqual(["markup"]);
    expect(
      verdict("x.bin", text("x"), "application/vnd.ms-excel.sheet.macroEnabled.12").flags,
    ).toEqual(["macros"]);
    expect(attachmentVerdict({ filename: "a.pdf", bytes: PDF }, ["pdf_actions"])).toMatchObject({
      action: "park",
      flags: ["pdf_actions"],
    });
  });
});

describe("attachmentVerdict: allowed", () => {
  it.each([
    ["report.docx", DOCX],
    [
      "sheet.xlsx",
      zip([
        { name: "[Content_Types].xml" },
        { name: "xl/workbook.xml" },
        { name: "xl/sharedStrings.xml" },
      ]),
    ],
    ["fatura.pdf", PDF],
    ["photo.png", PNG],
    ["photo.jpg", PNG],
    ["invite.ics", text("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n")],
    ["nfe.xml", text('<?xml version="1.0"?><nfeProc versao="4.00"/>')],
    [
      "ticket.pkpass",
      zip([{ name: "pass.json" }, { name: "manifest.json" }, { name: "signature" }]),
    ],
    ["notes.txt", PDF],
  ])("allows %s", (name, bytes) => {
    expect(verdict(name, bytes)).toMatchObject({ action: "allow", flags: [] });
  });
});

describe("attachmentVerdict: hostile archives and names", () => {
  it("reads 10,000 entries sharing one 64 KB local name once, and parks the archive", () => {
    const longName = Buffer.alloc(0xffff, 0x61);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(longName.length, 26);
    const central: Buffer[] = [];
    for (let i = 0; i < 10_000; i++) {
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE(5, 28);
      central.push(head, Buffer.from("a.txt"));
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(10_000, 8);
    end.writeUInt16LE(10_000, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(30 + longName.length, 16);
    const bomb = Buffer.concat([local, longName, directory, end]);
    const started = performance.now();
    const result = verdict("names.zip", bomb);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.action).toBe("park");
    expect(result.flags).toEqual(expect.arrayContaining(["archive", "over_caps"]));
  });

  it("stops reading names past the archive's total, and keeps a long name's extension", () => {
    const many = zip(
      Array.from({ length: 1_100 }, (_, i) => ({ name: `${i}`.padEnd(1_000, "x") })),
    );
    expect(readZipDirectory(many)?.overCaps).toBe(true);
    expect(verdict("many.zip", many).flags).toContain("over_caps");
    expect(verdict("files.zip", zip([{ name: `${"a".repeat(2_000)}.exe` }]))).toMatchObject({
      action: "reject",
      rejection: "blocked_in_archive",
    });
  });

  it("reads a ZIP behind other bytes: a PDF or image polyglot", () => {
    const pdfZip = Buffer.concat([PDF, zip([{ name: "a/run.js", data: "x" }])]);
    expect(verdict("fatura.pdf", pdfZip)).toMatchObject({
      action: "reject",
      kind: "pdf",
      rejection: "blocked_in_archive",
    });
    const pngZip = Buffer.concat([PNG, zip([{ name: "readme.txt", data: "x" }])]);
    expect(verdict("photo.png", pngZip)).toMatchObject({
      action: "park",
      kind: "png",
      flags: ["archive"],
    });
  });
});

describe("attachmentVerdict: names", () => {
  it("refuses only the controls that change text direction", () => {
    for (const control of ["\u202A", "\u202E", "\u2066", "\u2069", "\u200E", "\u200F", "\u061C"]) {
      expect(
        verdict(`fatura${control}.pdf`, PDF),
        control.codePointAt(0)?.toString(16),
      ).toMatchObject({
        action: "reject",
        rejection: "direction_controls",
      });
    }
    // Persian spelling joins with U+200C; emoji sequences with U+200D.
    for (const name of [
      "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645.pdf",
      "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}.pdf",
      "fa\u00ADtura.pdf",
    ]) {
      expect(verdict(name, PDF).action, name).toBe("allow");
    }
  });
});

describe("sentContentType", () => {
  it("keeps the bare media type and its charset, never a declared name", () => {
    expect(sentContentType("application/pdf")).toBe("application/pdf");
    expect(sentContentType("Application/PDF; name=report.pdf")).toBe("application/pdf");
    expect(sentContentType("application/octet-stream; name=notes.txt; name=report.pdf")).toBe(
      "application/octet-stream",
    );
    expect(sentContentType('text/plain; name="a.txt"; charset="UTF-8"')).toBe(
      "text/plain; charset=UTF-8",
    );
    expect(sentContentType("text/csv;charset=iso-8859-1")).toBe("text/csv; charset=iso-8859-1");
  });

  it("drops what is not a media type, for the MIME writer to infer", () => {
    for (const declared of [
      undefined,
      "",
      "pdf",
      "text/plain/extra",
      "text/pl ain",
      "a/b\r\nX: y",
    ]) {
      expect(sentContentType(declared), String(declared)).toBeUndefined();
    }
  });
});
