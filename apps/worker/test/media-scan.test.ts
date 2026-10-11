import { readFileSync } from "node:fs";
import { createPromiseCache, type EmailAttachment } from "@millionsend/core";
import sharp from "sharp";
import { afterAll, describe, expect, it, vi } from "vitest";
import { decodeQr, MEDIA_TASK_TIMEOUT_MS, MediaPool, MediaPoolError } from "../src/media/pool.js";
import { prepareImage } from "../src/media/read.js";
import { scanAttachments } from "../src/media/scan.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/media/${name}`, import.meta.url));
const attach = (filename: string, bytes: Uint8Array | string, contentType?: string) =>
  ({
    filename,
    content: Buffer.from(bytes).toString("base64"),
    ...(contentType ? { contentType } : {}),
  }) satisfies EmailAttachment;

const pool = new MediaPool();
afterAll(() => pool.close());
const deps = () => ({ pool, cache: createPromiseCache({ maxEntries: 100, ttlMs: 60_000 }) });

describe("the parsing threads", () => {
  it("decode QR codes with zxing's WASM from node_modules, never a CDN", async () => {
    const fetch = vi.fn(() => Promise.reject(new Error("no network in tests")));
    vi.stubGlobal("fetch", fetch);
    try {
      const { data, info } = await sharp(fixture("qr.png"))
        .flatten({ background: "#ffffff" })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(await decodeQr(data, info.width, info.height)).toEqual([
        "https://m365-verify.example/login",
      ]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("kill a hung parse at the timeout and start a fresh thread", async () => {
    expect(MEDIA_TASK_TIMEOUT_MS).toBe(4_000);
    // Long enough for a fresh thread to boot, which the timeout also covers.
    const hang = new MediaPool({
      size: 1,
      timeoutMs: 1_500,
      script: new URL("./fixtures/media/hang-thread.mjs", import.meta.url),
    });
    try {
      const started = Date.now();
      await expect(hang.run("hang")).rejects.toMatchObject({ reason: "timeout" });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(await hang.run("next")).toMatchObject({ message: "next" });
      await expect(hang.run("crash")).rejects.toBeInstanceOf(MediaPoolError);
      expect(await hang.run("after")).toMatchObject({ message: "after" });
    } finally {
      await hang.close();
    }
  });
});

describe("the pool's limits", () => {
  const hangScript = new URL("./fixtures/media/hang-thread.mjs", import.meta.url);

  it("counts queue time against the budget, and refuses work past the queue's bound", async () => {
    const pool = new MediaPool({ size: 1, timeoutMs: 1_500, queueMax: 1, script: hangScript });
    try {
      const hung = pool.run("hang");
      const waiting = pool.run("never runs");
      await expect(pool.run("one too many")).rejects.toMatchObject({ reason: "busy" });
      await expect(hung).rejects.toMatchObject({ reason: "timeout" });
      // It never reached a thread: the budget ran out while it waited for one.
      await expect(waiting).rejects.toMatchObject({ reason: "timeout" });
      expect(await pool.run("after")).toMatchObject({ message: "after" });
    } finally {
      await pool.close();
    }
  });

  it("replaces a thread whose WASM heap grew past the limit", async () => {
    const pool = new MediaPool({ size: 1, timeoutMs: 3_000, script: hangScript });
    try {
      const first = await pool.run<{ threadId: number }>("first");
      expect((await pool.run<{ threadId: number }>("again")).threadId).toBe(first.threadId);
      await pool.run("grow");
      expect((await pool.run<{ threadId: number }>("next")).threadId).not.toBe(first.threadId);
    } finally {
      await pool.close();
    }
  });
});

describe("scanAttachments (the send path)", () => {
  it("reads a PDF's text, links and Pix code, and only page 1's QR code", async () => {
    const scan = await scanAttachments([attach("Fatura.pdf", fixture("lure.pdf"))], deps());
    expect(scan.files).toEqual([
      {
        filename: "Fatura.pdf",
        kind: "pdf",
        size: expect.any(Number),
        pages: 2,
        action: "allow",
        flags: [],
      },
    ]);
    expect(scan.links).toEqual(
      expect.arrayContaining([
        { source: "PDF link", url: "https://pdf-link.example/annot" },
        { source: "PDF link", url: "https://m365-verify.example/pay" },
      ]),
    );
    // The QR code sits on page 2, which only the judge job renders.
    expect(scan.links.some((link) => link.source === "QR code")).toBe(false);
    expect(scan.pix).toEqual([
      { from: "text", payee: "JOAO SILVA", city: "SAO PAULO", amount: "537.00", key: "phone" },
    ]);
    expect(scan).toMatchObject({ risky: false, unreadable: false, refused: false });
  });

  it("reads a DOCX's text, external link and embedded QR code", async () => {
    const scan = await scanAttachments([attach("Fatura.docx", fixture("lure.docx"))], deps());
    expect(scan.files[0]).toMatchObject({ kind: "ooxml", action: "allow", flags: [] });
    expect(scan.links).toEqual(
      expect.arrayContaining([
        { source: "QR code", url: "https://docx-qr.example/y" },
        { source: "Office link", url: "https://docx-link.example/x?a=1&b=2" },
      ]),
    );
  });

  it("decodes a QR code in an image attachment, and finds calendar and web page links", async () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Reunião de cobrança",
      "DESCRIPTION:Confirme seu acesso em https://ics-text.exa",
      " mple/confirm\\nObrigado",
      "URL:https://ics-link.example/join",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="60"><script>location.href="https://svg-script.example"</script><a xlink:href="https://svg-link.example/login"><text x="10" y="30">Entrar</text></a></svg>';
    const scan = await scanAttachments(
      [attach("qr.png", fixture("qr.png")), attach("invite.ics", ics), attach("logo.svg", svg)],
      deps(),
    );
    expect(scan.links).toEqual(
      expect.arrayContaining([
        { source: "QR code", url: "https://m365-verify.example/login" },
        { source: "calendar link", url: "https://ics-link.example/join" },
        { source: "calendar link", url: "https://ics-text.example/confirm" },
        { source: "web page link", url: "https://svg-link.example/login" },
      ]),
    );
    expect(scan.files[2]).toMatchObject({ kind: "svg", action: "park" });
    expect(scan.files[2]?.flags).toEqual(expect.arrayContaining(["markup", "scripts"]));
    expect(scan.risky).toBe(true);
  });

  it("flags a locked PDF and one with a script in an object stream, but not an owner password", async () => {
    const scan = await scanAttachments(
      [
        attach("locked.pdf", fixture("locked.pdf")),
        attach("script.pdf", fixture("script.pdf")),
        attach("statement.pdf", fixture("owner-only.pdf")),
      ],
      deps(),
    );
    expect(scan.files.map((file) => [file.action, file.flags])).toEqual([
      ["park", ["encrypted"]],
      ["park", ["pdf_actions"]],
      ["allow", []],
    ]);
    expect(scan.risky).toBe(true);
  });

  it("marks a file that won't open as unreadable, and one now refused as refused", async () => {
    const scan = await scanAttachments(
      [attach("photo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]))],
      deps(),
    );
    expect(scan.files[0]?.flags).toEqual(["unreadable"]);
    expect(scan).toMatchObject({ unreadable: true, risky: false, refused: false });
    const old = await scanAttachments([attach("setup.exe", "MZ")], deps());
    expect(old).toMatchObject({ refused: true, files: [{ action: "reject" }] });
  });

  it("scans hostile markup in linear time, and caps how much it reads", async () => {
    const meta = `<meta ${"http-equiv=refresh ".repeat(20_000)}`;
    const started = performance.now();
    const scan = await scanAttachments([attach("page.html", meta)], deps());
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(scan.files[0]?.flags).toEqual(["markup"]);
    const refresh = '<meta http-equiv="refresh" content="0;url=https://refresh.example/go">';
    const huge = await scanAttachments(
      [attach("page.html", `${refresh}${"<p>x</p>".repeat(130_000)}`)],
      deps(),
    );
    expect(huge.files[0]?.flags).toEqual(expect.arrayContaining(["markup", "over_caps"]));
    expect(huge.links).toContainEqual({
      source: "web page link",
      url: "https://refresh.example/go",
    });
  });

  it("says when the threads were too busy to read a file", async () => {
    const busy = new MediaPool({ queueMax: 0 });
    const scan = await scanAttachments([attach("Fatura.pdf", fixture("lure.pdf"))], {
      pool: busy,
      cache: createPromiseCache({ maxEntries: 10, ttlMs: 60_000 }),
    });
    expect(scan).toMatchObject({
      unreadable: true,
      files: [{ action: "park", flags: ["unreadable"] }],
    });
  });

  it("reads each file once per process: the second scan of a blast hits the cache", async () => {
    const run = vi.spyOn(pool, "run");
    const shared = deps();
    const files = [attach("Fatura.pdf", fixture("lure.pdf"))];
    await scanAttachments(files, shared);
    await scanAttachments(files, shared);
    expect(run).toHaveBeenCalledTimes(1);
    run.mockRestore();
  });
});

describe("prepareImage", () => {
  it("skips images under 48 px and fits the rest into 1,120 px as JPEG", async () => {
    const tiny = await sharp({
      create: { width: 40, height: 400, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    expect(await prepareImage(tiny)).toBe("small");
    const wide = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: "#123" },
    })
      .png()
      .toBuffer();
    const jpeg = await prepareImage(wide);
    expect(await sharp(jpeg as Buffer).metadata()).toMatchObject({
      format: "jpeg",
      width: 1120,
      height: 373,
    });
  });

  it("turns an animation into four of its frames, stacked", async () => {
    const frames = await Promise.all(
      ["#f00", "#0f0", "#00f", "#ff0", "#0ff", "#f0f"].map((background) =>
        sharp({ create: { width: 100, height: 100, channels: 3, background } })
          .png()
          .toBuffer(),
      ),
    );
    const gif = await sharp(frames, { join: { animated: true } })
      .gif()
      .toBuffer();
    expect((await sharp(gif).metadata()).pages).toBe(6);
    const jpeg = await prepareImage(gif);
    expect(await sharp(jpeg as Buffer).metadata()).toMatchObject({ width: 100, height: 400 });
  });
});
