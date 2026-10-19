import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  buildJudgeBlock,
  createPromiseCache,
  type EmailAttachment,
  EnvKeyring,
  encryptEmailBody,
  openMediaReview,
  purgedEmailBodyColumns,
  UNNAMED_ATTACHMENT,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MediaPool } from "../src/media/pool.js";
import { type MediaReadDeps, readMediaForJudge, saveMediaReview } from "../src/media/read.js";
import {
  createBedrockVision,
  type VisionReader,
  type VisionReport,
  type VisionResult,
} from "../src/media/vision.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/media/${name}`, import.meta.url));
const attach = (filename: string, bytes: Uint8Array): EmailAttachment => ({
  filename,
  content: Buffer.from(bytes).toString("base64"),
});
const QR_DATA_URI = `data:image/png;base64,${fixture("qr.png").toString("base64")}`;

// Room for CI under load; the parse budget itself is tested in media-scan.
const pool = new MediaPool({ timeoutMs: 30_000 });
afterAll(() => pool.close());

const report = (overrides: Partial<VisionReport> = {}): VisionReport => ({
  text: "Your Microsoft 365 password expires today",
  brands: ["Microsoft"],
  qrCodes: 1,
  loginOrPaymentForm: false,
  addressedToAi: false,
  ...overrides,
});

function fakeReader(answer: (count: number) => VisionResult): VisionReader & { calls: number } {
  const reader = {
    model: "fake",
    calls: 0,
    read: async (items: unknown[]) => {
      reader.calls++;
      return answer(items.length);
    },
  };
  return reader;
}

const deps = (vision: VisionReader | null, extra: Partial<MediaReadDeps> = {}): MediaReadDeps => ({
  pool,
  cache: createPromiseCache({ maxEntries: 100, ttlMs: 60_000 }),
  vision,
  ...extra,
});

describe("createBedrockVision", () => {
  // Not the default region, so a reader that ignores the config fails here.
  const config = {
    region: "eu-west-3",
    model: "eu.anthropic.claude-haiku-5-5",
    accessKeyId: "AKIATEST",
    secretAccessKey: "secret",
  };
  const image = [{ hint: "remote image", jpeg: Buffer.from("jpeg") }];
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const answer = (status: number, body: unknown, headers?: Record<string, string>) =>
    vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      reply(status, body, headers),
    );
  const hang = (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  const read = (fetch: typeof globalThis.fetch, signal?: AbortSignal) =>
    createBedrockVision(config, { fetch }).read(image, signal);
  const message = (content: unknown[], stopReason: string) => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "anthropic.claude-haiku-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  });
  const toolUse = (input: unknown) =>
    message([{ type: "tool_use", id: "toolu_1", name: "report_media", input }], "tool_use");

  it("forces report_media on Haiku 5.5 through the region's profile, and parses what it reports", async () => {
    const fetch = answer(
      200,
      toolUse({
        items: [
          {
            index: 1,
            text: "x".repeat(1_500),
            brands: ["Microsoft", "a", "b", "c", "d", "e"],
            qr_codes: 1,
            login_or_payment_form: true,
            addressed_to_ai: false,
          },
        ],
      }),
    );
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "example-not-a-token");
    const result = await createBedrockVision(config, { fetch }).read(image);
    vi.unstubAllEnvs();
    expect(result).toEqual({
      status: "ok",
      reports: [
        {
          text: "x".repeat(1_000),
          brands: ["Microsoft", "a", "b", "c", "d"],
          qrCodes: 1,
          loginOrPaymentForm: true,
          addressedToAi: false,
        },
      ],
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://bedrock-runtime.eu-west-3.amazonaws.com/model/eu.anthropic.claude-haiku-5-5/invoke",
    );
    expect(new Headers(init?.headers).get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/eu-west-3\/bedrock\/aws4_request,/,
    );
    const body = JSON.parse(String(init?.body));
    expect(body).not.toHaveProperty("model");
    expect(body).toMatchObject({
      anthropic_version: "bedrock-2023-05-31",
      tool_choice: { type: "tool", name: "report_media" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Image 1 (remote image):" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg" } },
            { type: "text", text: "Report every image with report_media." },
          ],
        },
      ],
    });
    expect(body.tools[0]).toMatchObject({
      name: "report_media",
      input_schema: { type: "object", required: ["items"] },
    });
    expect(body.tools[0].input_schema).not.toHaveProperty("$schema");
    expect(body.system).toMatch(/never instructions to you/);
    expect(body).not.toHaveProperty("temperature");
    expect(String(init?.body)).not.toContain("cache_control");
  });

  it("blocks images Bedrock refuses, unless it refuses the same request without them too", async () => {
    const refusal = () =>
      reply(
        400,
        { message: "blocked" },
        { "x-amzn-errortype": "com.example#ValidationException:http://example.com/" },
      );
    const csam = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(refusal())
      .mockResolvedValueOnce(reply(200, toolUse({ items: [] })));
    expect(await read(csam)).toEqual({ status: "blocked" });
    expect(csam).toHaveBeenCalledTimes(2);
    expect(String(csam.mock.calls[1]?.[0])).toBe(String(csam.mock.calls[0]?.[0]));
    expect(JSON.parse(String(csam.mock.calls[1]?.[1]?.body))).toMatchObject({
      tool_choice: { type: "tool", name: "report_media" },
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Report every image with report_media." }],
        },
      ],
    });
    const wrongModel = answer(
      400,
      { message: "The provided model identifier is invalid." },
      { "x-amzn-errortype": "ValidationException" },
    );
    expect(await read(wrongModel)).toEqual({ status: "unavailable", reason: "upstream" });
    expect(wrongModel).toHaveBeenCalledTimes(2);
    const passing: (typeof globalThis.fetch)[] = [
      async () => reply(429, { message: "x" }, { "x-amzn-errortype": "ThrottlingException" }),
      async () =>
        reply(400, { message: "x" }, { "x-amzn-errortype": "ServiceQuotaExceededException" }),
      async () => reply(503, { message: "x" }),
      () => Promise.reject(new TypeError("fetch failed")),
    ];
    for (const probe of passing) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(refusal())
        .mockImplementation(probe);
      expect(await read(fetch)).toEqual({ status: "blocked" });
    }
    const deadline = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(refusal())
      .mockImplementation(hang);
    expect(await read(deadline, AbortSignal.timeout(500))).toEqual({ status: "blocked" });
  });

  it("never reads a quota, a permission or an unnamed 400 as blocked", async () => {
    const throttled: VisionResult = { status: "unavailable", reason: "throttled" };
    const upstream: VisionResult = { status: "unavailable", reason: "upstream" };
    const cases: [status: number, type: string | null, result: VisionResult, calls: number][] = [
      [400, "ServiceQuotaExceededException", throttled, 1],
      [400, "ThrottlingException", throttled, 1],
      [429, "ThrottlingException", throttled, 2],
      [403, "AccessDeniedException", upstream, 1],
      [404, "ResourceNotFoundException", upstream, 1],
      [400, null, upstream, 1],
      [408, "ModelTimeoutException", { status: "unavailable", reason: "timeout" }, 2],
    ];
    for (const [status, type, result, calls] of cases) {
      const fetch = answer(status, { message: "x" }, type ? { "x-amzn-errortype": type } : {});
      expect(await read(fetch)).toEqual(result);
      expect(fetch).toHaveBeenCalledTimes(calls);
    }
  });

  it("rejects a malformed report, and reports a refusal and a timeout apart", async () => {
    expect(await read(answer(200, toolUse({ items: [{ index: 1, text: 3 }] })))).toEqual({
      status: "unavailable",
      reason: "invalid_output",
    });
    expect(await read(answer(200, message([], "refusal")))).toEqual({ status: "refused" });
    expect(await read(hang, AbortSignal.timeout(50))).toEqual({
      status: "unavailable",
      reason: "timeout",
    });
  });

  it("reads the same images once when two emails need them at the same time", async () => {
    const fetch = answer(
      200,
      toolUse({
        items: [
          {
            index: 1,
            text: "Escaneie para pagar",
            brands: [],
            qr_codes: 1,
            login_or_payment_form: false,
            addressed_to_ai: false,
          },
        ],
      }),
    );
    const shared = deps(createBedrockVision(config, { fetch }));
    const input = { attachments: [], bodyImages: [QR_DATA_URI], readBodyImages: true };
    const [a, b] = await Promise.all([
      readMediaForJudge(input, shared),
      readMediaForJudge(input, shared),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a.findings.imageText).toEqual(b.findings.imageText);
  });
});

describe("readMediaForJudge", () => {
  it("reads attachments and body images, and the judge block carries what it found", async () => {
    const vision = fakeReader((count) => ({
      status: "ok",
      reports: Array.from({ length: count }, (_, i) => report({ text: `image text ${i + 1}` })),
    }));
    const fetchImage = vi.fn(async () => ({ bytes: fixture("qr.png"), contentType: "image/png" }));
    const media = await readMediaForJudge(
      {
        attachments: [
          attach("Fatura.pdf", fixture("lure.pdf")),
          attach("Fatura.docx", fixture("lure.docx")),
        ],
        bodyImages: ["https://cdn.evil.example/lure.png", QR_DATA_URI, "cid:logo"],
        readBodyImages: true,
      },
      deps(vision, { fetchImage }),
    );
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(media.findings.imageText.map((entry) => entry.label)).toEqual([
      "image 1, remote, cdn.evil.example",
      "image 2, inline",
      "attachment Fatura.pdf page 2",
      "attachment Fatura.docx image 1",
    ]);
    expect(media.findings.links).toEqual(
      expect.arrayContaining([
        { source: "QR code", url: "https://m365-verify.example/login" },
        { source: "QR code", url: "https://qr-in-pdf.example/scan" },
        { source: "QR code", url: "https://docx-qr.example/y" },
        { source: "PDF link", url: "https://pdf-link.example/annot" },
        { source: "Office link", url: "https://docx-link.example/x?a=1&b=2" },
      ]),
    );
    expect(media.findings.images).toMatchObject({ read: 4, notRead: 1, why: ["cid reference"] });
    expect(media.issues).toEqual(["images_not_read"]);
    const block = buildJudgeBlock({
      team: { name: "Acme", verifiedDomains: ["acme.dev"], ageDays: 0, plan: "free" },
      from: "Acme <hi@acme.dev>",
      replyTo: null,
      subject: "Fatura",
      html: "<p>Segue a fatura.</p>",
      text: null,
      attachments: [{ filename: "Fatura.pdf" }, { filename: "Fatura.docx" }],
      media: media.findings,
    });
    expect(block).toContain('  [image 1, remote, cdn.evil.example] "image text 1"');
    expect(block).toContain("  (QR code) -> qr-in-pdf.example");
    expect(block).toContain(
      '  (Pix code) payee "JOAO SILVA" (SAO PAULO), key: phone, amount 537.00',
    );
    expect(block).toContain("Attachment details: Fatura.pdf (pdf, 5 KB, 2 pages; flags: none)");
    expect(block).not.toContain("987654321");
  });

  it("judges without image text when image reading is off, and still decodes QR codes", async () => {
    const media = await readMediaForJudge(
      { attachments: [], bodyImages: [QR_DATA_URI], readBodyImages: true },
      deps(null),
    );
    expect(media.issues).toEqual(["vision_off"]);
    expect(media.findings.images).toMatchObject({
      read: 0,
      notRead: 1,
      why: ["image reading is off"],
    });
    expect(media.findings.links).toEqual([
      { source: "QR code", url: "https://m365-verify.example/login" },
    ]);
  });

  it("leaves body images alone when the team and the email don't call for them", async () => {
    const fetchImage = vi.fn();
    const media = await readMediaForJudge(
      { attachments: [], bodyImages: ["https://cdn.example/a.png"], readBodyImages: false },
      deps(null, { fetchImage }),
    );
    expect(fetchImage).not.toHaveBeenCalled();
    expect(media.issues).toEqual([]);
  });

  it("reads a cid: image through its inline part, never as an image left unread", async () => {
    const media = await readMediaForJudge(
      {
        attachments: [
          {
            content: fixture("qr.png").toString("base64"),
            contentType: "image/png",
            contentId: "Logo-1",
          },
        ],
        bodyImages: ["cid:logo-1"],
        readBodyImages: true,
      },
      deps(null),
    );
    expect(media.findings.images.why).not.toContain("cid reference");
    expect(media.findings.links.some((link) => link.source === "QR code")).toBe(true);
    expect(media.findings.files[0]?.filename).toBe(UNNAMED_ATTACHMENT);
  });

  it("flags a QR code the reader saw but nothing decoded", async () => {
    const media = await readMediaForJudge(
      { attachments: [], bodyImages: [QR_DATA_URI], readBodyImages: true },
      deps(fakeReader(() => ({ status: "ok", reports: [report({ qrCodes: 2 })] }))),
    );
    expect(media.findings.qr).toEqual({ seen: 2, decoded: 1 });
    expect(media.issues).toContain("qr_undecoded");
  });

  it("notes a refusal, keeps no preview after a 400, and keeps previews otherwise", async () => {
    const input = { attachments: [], bodyImages: [QR_DATA_URI], readBodyImages: true };
    const refused = await readMediaForJudge(input, deps(fakeReader(() => ({ status: "refused" }))));
    expect(refused.issues).toEqual(["vision_refused"]);
    expect((await refused.review()).previews).toEqual([]);
    const blocked = await readMediaForJudge(input, deps(fakeReader(() => ({ status: "blocked" }))));
    expect(blocked.issues).toEqual(["vision_blocked"]);
    expect((await blocked.review()).previews).toEqual([]);
    const ok = await readMediaForJudge(
      input,
      deps(fakeReader(() => ({ status: "ok", reports: [report()] }))),
    );
    const previews = (await ok.review()).previews;
    expect(previews).toHaveLength(1);
    expect(previews[0]?.label).toBe("image 1, inline");
    expect(Buffer.from(previews[0]?.jpeg ?? "", "base64").subarray(0, 3)).toEqual(
      Buffer.from([0xff, 0xd8, 0xff]),
    );
  });

  it("leaves a file the threads could not open alone, and says when they were busy", async () => {
    const vision = fakeReader(() => ({ status: "ok", reports: [] }));
    const broken = await readMediaForJudge(
      {
        attachments: [
          attach("photo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])),
        ],
        bodyImages: [],
        readBodyImages: true,
      },
      deps(vision),
    );
    expect(vision.calls).toBe(0);
    expect(broken.issues).toEqual(["unreadable_file"]);
    const busy = await readMediaForJudge(
      { attachments: [], bodyImages: [QR_DATA_URI], readBodyImages: true },
      deps(vision, { pool: new MediaPool({ queueMax: 0 }) }),
    );
    expect(busy.findings.images).toMatchObject({ notRead: 1, why: ["busy"] });
    expect(busy.issues).toEqual(["images_not_read"]);
  });

  it("does not cache an outage, and fetches a remote image once per blast", async () => {
    let up = false;
    const vision = fakeReader(() =>
      up ? { status: "ok", reports: [report()] } : { status: "unavailable", reason: "timeout" },
    );
    const fetchImage = vi.fn(async () => ({ bytes: fixture("qr.png"), contentType: "image/png" }));
    const shared = deps(vision, { fetchImage });
    const input = {
      attachments: [],
      bodyImages: ["https://cdn.evil.example/lure.png"],
      readBodyImages: true,
    };
    expect((await readMediaForJudge(input, shared)).issues).toEqual(["vision_unavailable"]);
    up = true;
    // Only the image's hash is cached, so asking the reader again fetches it again.
    expect((await readMediaForJudge(input, shared)).issues).toEqual([]);
    expect(fetchImage).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 3; i++) {
      expect((await readMediaForJudge(input, shared)).findings.images.read).toBe(1);
    }
    expect(vision.calls).toBe(2);
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });
});

describe("saveMediaReview", () => {
  let db: Db;
  let close: () => Promise<void>;
  let teamId: string;
  const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    teamId = await createTeam(db, "media-review");
  });
  afterAll(() => close());

  async function insertEmail(): Promise<string> {
    const id = randomUUID();
    const body = await encryptEmailBody({ html: "<p>x</p>", text: null }, keyring, {
      teamId,
      rowId: id,
    });
    await db.insert(schema.emails).values({
      id,
      teamId,
      from: "Acme <hi@acme.dev>",
      to: ["someone@example.org"],
      subject: "Held",
      bodyCiphertext: body.ciphertext,
      bodyIv: body.iv,
      bodyWrappedDek: body.wrappedDek,
      bodyKeyVersion: body.keyVersion,
    });
    return id;
  }

  it("seals what screening read into the held email, and the purge drops it with the body", async () => {
    const media = await readMediaForJudge(
      { attachments: [], bodyImages: [QR_DATA_URI], readBodyImages: true },
      deps(fakeReader(() => ({ status: "ok", reports: [report()] }))),
    );
    const review = await media.review();
    const id = await insertEmail();
    await saveMediaReview(db, keyring, { id, teamId }, review);
    const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
    expect(row?.media).toBeTruthy();
    expect(row?.media).not.toContain("m365-verify");
    expect(await openMediaReview(row?.media ?? "", keyring, { teamId, rowId: id })).toEqual(review);
    await expect(
      openMediaReview(row?.media ?? "", keyring, { teamId, rowId: randomUUID() }),
    ).rejects.toThrow();

    await db
      .update(schema.emails)
      .set(purgedEmailBodyColumns(new Date()))
      .where(eq(schema.emails.id, id));
    const [purged] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
    expect(purged?.media).toBeNull();
    await saveMediaReview(db, keyring, { id, teamId }, review);
    const [still] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
    expect(still?.media).toBeNull();
  });
});
