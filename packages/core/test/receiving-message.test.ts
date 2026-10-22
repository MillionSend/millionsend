import { randomBytes, randomUUID } from "node:crypto";
import { createTransport, type SendMailOptions } from "nodemailer";
import { describe, expect, it } from "vitest";
import { decryptPayload } from "../src/crypto/envelope.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { verifyReceivedDownload } from "../src/receiving/downloads.js";
import {
  openReceivedAttachment,
  openReceivedRaw,
  parseReceivedMetadata,
  type ReceivedEmailRow,
  receivedAttachmentId,
  receivedEmailAttachment,
  receivedEmailAttachments,
  receivedEmailDetail,
  receivedEmailEventData,
  receivedEmailListItem,
  sealReceivedAttachments,
  sealReceivedRaw,
} from "../src/receiving/message.js";

const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const downloads = { key: randomBytes(32), baseUrl: "https://api.example.com/" };
const transport = createTransport({ streamTransport: true, buffer: true });

async function mime(options: SendMailOptions): Promise<Buffer> {
  return (await transport.sendMail(options)).message as Buffer;
}

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
  "hex",
);
const PDF = Buffer.from("%PDF-1.4 receiving fixture", "utf8");

const richMessage = () =>
  mime({
    from: '"Ana Souza" <ana@sender.example>',
    to: "agent@inbound.acme.test, Other <other@elsewhere.example>",
    cc: "cc@elsewhere.example",
    replyTo: "replies@sender.example",
    subject: "Pedido nº 42 — olá",
    messageId: "<abc-123@sender.example>",
    text: "Plain body",
    html: '<p>Hi <img src="cid:logo@sender"></p>',
    headers: { Received: ["from a by b; Sat, 10 Oct 2026 10:00:00 +0000", "from c by d"] },
    attachments: [
      { filename: "logo.png", content: PNG, contentType: "image/png", cid: "logo@sender" },
      { filename: "../../etc/report.pdf", content: PDF, contentType: "application/pdf" },
    ],
  });

async function storedRow(raw: Buffer, overrides: Partial<ReceivedEmailRow> = {}) {
  const id = randomUUID();
  const teamId = randomUUID();
  const metadata = await parseReceivedMetadata(raw);
  const attachments = metadata.attachments.map((a) => ({
    ...a,
    id: receivedAttachmentId(id, a.index),
  }));
  const sealed = await sealReceivedRaw(raw, keyring, { teamId, rowId: id });
  const row: ReceivedEmailRow = {
    id,
    teamId,
    domainIds: [randomUUID()],
    rawSha256: "0".repeat(64),
    messageId: metadata.messageId ?? `<${id}@received.invalid>`,
    from: metadata.from ?? "",
    to: metadata.to,
    cc: metadata.cc,
    bcc: metadata.bcc,
    replyTo: metadata.replyTo,
    receivedFor: ["agent@inbound.acme.test"],
    subject: metadata.subject,
    envelope: { mailFrom: "bounce@sender.example", clientIp: "192.0.2.1", helo: "mx", tls: null },
    authentication: { spf: "softfail", dkim: "pass", dmarc: "temperror", arc: "none" },
    sizeBytes: raw.length,
    attachmentCount: attachments.length,
    rawCiphertext: sealed.ciphertext,
    rawIv: sealed.iv,
    rawWrappedDek: sealed.wrappedDek,
    rawKeyVersion: sealed.keyVersion,
    attachments: await sealReceivedAttachments(attachments, keyring, { teamId, rowId: id }),
    contentPurgedAt: null,
    fromName: "",
    inReplyTo: null,
    references: [],
    fromFields: 1,
    fromMailboxes: 1,
    automated: null,
    authDetail: null,
    senderTrust: "unauthenticated",
    spamVerdict: null,
    spamScore: null,
    spamReasons: [],
    virusVerdict: null,
    virusSignature: null,
    hiddenText: null,
    extractedKinds: [],
    extracted: null,
    catchAll: true,
    announcedAt: null,
    releasedAt: null,
    releasedBy: null,
    createdAt: new Date("2026-10-11T12:00:00Z"),
    ...overrides,
  };
  return { row, attachments };
}

describe("parseReceivedMetadata", () => {
  it("reads bare addresses, the subject, the Message-ID and every attachment without its bytes", async () => {
    const metadata = await parseReceivedMetadata(await richMessage());
    expect(metadata).toMatchObject({
      from: "ana@sender.example",
      to: ["agent@inbound.acme.test", "other@elsewhere.example"],
      cc: ["cc@elsewhere.example"],
      bcc: [],
      replyTo: ["replies@sender.example"],
      subject: "Pedido nº 42 — olá",
      messageId: "<abc-123@sender.example>",
    });
    expect(metadata.attachments).toEqual([
      {
        index: 0,
        filename: "logo.png",
        contentType: "image/png",
        size: PNG.length,
        contentDisposition: "inline",
        contentId: "logo@sender",
      },
      {
        index: 1,
        filename: ".._.._etc_report.pdf",
        contentType: "application/pdf",
        size: PDF.length,
        contentDisposition: "attachment",
        contentId: null,
      },
    ]);
  });

  it("flattens header injection, bidi tricks and unusable addresses before anything is stored", async () => {
    const raw = Buffer.from(
      [
        "From: =?UTF-8?Q?Evil?= <evil@sender.example>",
        'To: <bad\u0001addr@inbound.acme.test>, ok@INBOUND.Acme.Test, "a b"@inbound.acme.test',
        "Cc: not-an-address",
        "Subject: =?UTF-8?Q?Hello=0D=0ABcc:_victim@x.example_=E2=80=AEgpj.exe?=",
        "Message-ID: <id\u0007@sender.example>",
        "",
        "body",
      ].join("\r\n"),
      "utf8",
    );
    const metadata = await parseReceivedMetadata(raw);
    expect(metadata.subject).toBe("Hello Bcc: victim@x.example gpj.exe");
    expect(metadata.to).toContain("ok@inbound.acme.test");
    for (const address of metadata.to) {
      expect(address).toMatch(/^[^\s\p{Cc}<>]+@[a-z0-9.-]+$/u);
    }
    expect(metadata.cc).toEqual([]);
    expect(metadata.messageId).toBe("<id @sender.example>");
  });

  it("never takes the From address out of an encoded word", async () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const read = async (from: string) => {
      const m = await parseReceivedMetadata(
        Buffer.from(`From: ${from}\r\nTo: bot@inbound.acme.test\r\nSubject: hi\r\n\r\nbody\r\n`),
      );
      return [m.from, m.fromMailboxes];
    };
    // An encoded-word group name, and a lone encoded word, that decode to another address.
    expect(
      await read(`=?utf-8?B?${b64("Owner <owner@corp.example>")}?=: eve@evil.example;`),
    ).toEqual(["eve@evil.example", 1]);
    expect(await read(`=?utf-8?B?${b64("Owner <owner@corp.example>")}?=`)).toEqual([null, 0]);
    expect(await read(`=?utf-8?B?${b64("Ana Souza")}?= <ana@sender.example>`)).toEqual([
      "ana@sender.example",
      1,
    ]);
    expect(await read("Ana <ANA@Sender.Example>")).toEqual(["ANA@sender.example", 1]);
    expect(await read("Undisclosed: eve@evil.example;")).toEqual(["eve@evil.example", 1]);
    expect(await read("José <jose@bücher.example>")).toEqual(["jose@xn--bcher-kva.example", 1]);
  });

  it("never throws on malformed MIME: what it cannot read comes back empty", async () => {
    for (const raw of [
      Buffer.from([0, 1, 2, 255, 254, 10, 13, 0]),
      Buffer.from(
        'Content-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nunterminated',
      ),
      Buffer.alloc(0),
    ]) {
      const metadata = await parseReceivedMetadata(raw);
      expect(metadata.from).toBeNull();
      expect(metadata.subject).toBe("");
      expect(Array.isArray(metadata.attachments)).toBe(true);
    }
  });
});

describe("received attachment ids", () => {
  it("are stable uuids per row and index", () => {
    const id = randomUUID();
    const first = receivedAttachmentId(id, 0);
    expect(first).toBe(receivedAttachmentId(id, 0));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(receivedAttachmentId(id, 1)).not.toBe(first);
    expect(receivedAttachmentId(randomUUID(), 0)).not.toBe(first);
  });
});

describe("sealed received content", () => {
  it("opens only as its own kind on its own row", async () => {
    const raw = await richMessage();
    const { row } = await storedRow(raw);
    expect((await openReceivedRaw(row, keyring))?.equals(raw)).toBe(true);
    const encrypted = {
      ciphertext: row.rawCiphertext as Buffer,
      iv: row.rawIv as Buffer,
      wrappedDek: row.rawWrappedDek as Buffer,
      keyVersion: row.rawKeyVersion as number,
    };
    const owner = { teamId: row.teamId, rowId: row.id };
    await expect(
      decryptPayload(encrypted, keyring, { ...owner, kind: "received_attachments" }),
    ).rejects.toThrow();
    await expect(
      decryptPayload(encrypted, keyring, { ...owner, kind: "email_body" }),
    ).rejects.toThrow();
    await expect(openReceivedRaw({ ...row, id: randomUUID() }, keyring)).rejects.toThrow();
    await expect(openReceivedRaw({ ...row, teamId: randomUUID() }, keyring)).rejects.toThrow();
  });
});

describe("Resend shapes", () => {
  it("lists without opening the raw message", async () => {
    const { row, attachments } = await storedRow(await richMessage());
    const { rawCiphertext: _c, rawIv: _i, rawWrappedDek: _w, ...meta } = row;
    const item = await receivedEmailListItem(meta, keyring);
    expect(item).toEqual({
      id: row.id,
      to: ["agent@inbound.acme.test", "other@elsewhere.example"],
      from: "ana@sender.example",
      created_at: "2026-10-11T12:00:00.000Z",
      subject: "Pedido nº 42 — olá",
      bcc: [],
      cc: ["cc@elsewhere.example"],
      reply_to: ["replies@sender.example"],
      received_for: ["agent@inbound.acme.test"],
      message_id: "<abc-123@sender.example>",
      attachments: [
        {
          id: attachments[0]?.id,
          filename: "logo.png",
          content_type: "image/png",
          content_id: "logo@sender",
          content_disposition: "inline",
          size: PNG.length,
        },
        {
          id: attachments[1]?.id,
          filename: ".._.._etc_report.pdf",
          content_type: "application/pdf",
          content_id: null,
          content_disposition: "attachment",
          size: PDF.length,
        },
      ],
    });
  });

  it("returns the email with inlined cid images by default and the references on request", async () => {
    const { row } = await storedRow(await richMessage());
    const now = new Date("2026-10-11T12:30:00Z");
    const detail = await receivedEmailDetail(row, keyring, {
      htmlFormat: "data_uri",
      downloads: { ...downloads, now },
    });
    expect(detail.object).toBe("email");
    expect(detail.html_format).toBe("data_uri");
    expect(detail.html).toContain(`src="data:image/png;base64,${PNG.toString("base64")}"`);
    expect(detail.html).not.toContain("cid:");
    expect(detail.text).toBe("Plain body");
    expect(detail.headers?.subject).toBe("=?UTF-8?Q?Pedido_n=C2=BA_42_=E2=80=94_ol=C3=A1?=");
    expect(detail.headers?.["message-id"]).toBe("<abc-123@sender.example>");
    expect(detail.headers?.received).toBe(
      "from a by b; Sat, 10 Oct 2026 10:00:00 +0000\nfrom c by d",
    );
    // Resend reads an SPF softfail as no verdict.
    expect(detail.authentication).toEqual({
      spf: "gray",
      dkim: "pass",
      dmarc: "processing_failed",
    });
    // The envelope sender stands in for the Return-Path the message lacks.
    expect(detail.headers?.["return-path"]).toBe("<bounce@sender.example>");
    expect(detail.raw?.expires_at).toBe("2026-10-11T13:30:00.000Z");
    const url = new URL(detail.raw?.download_url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(`https://api.example.com/receiving/raw/${row.id}`);
    expect(
      verifyReceivedDownload({
        key: downloads.key,
        teamId: row.teamId,
        emailId: row.id,
        expires: url.searchParams.get("expires"),
        signature: url.searchParams.get("signature"),
        now,
      }),
    ).toBe(true);

    const cid = await receivedEmailDetail(row, keyring, { htmlFormat: "cid", downloads });
    expect(cid.html_format).toBe("cid");
    expect(cid.html).toContain('src="cid:logo@sender"');
  });

  it("keeps the cid references when inlining would repeat an image past the largest message", async () => {
    // One 1 MiB image quoted 50 times: a 1.4 MB message whose inlined HTML
    // would run to 67 MiB, each data URL repeated at every reference.
    const image = randomBytes(1024 * 1024);
    const { row } = await storedRow(
      await mime({
        from: "quoter@sender.example",
        to: "agent@inbound.acme.test",
        subject: "Long thread",
        html: '<p><img src="cid:sig@sender"></p>'.repeat(50),
        attachments: [
          { filename: "sig.png", content: image, contentType: "image/png", cid: "sig@sender" },
        ],
      }),
    );
    const detail = await receivedEmailDetail(row, keyring, { htmlFormat: "data_uri", downloads });
    expect(detail.html_format).toBe("cid");
    expect(detail.html?.match(/src="cid:sig@sender"/g)).toHaveLength(50);
    expect(detail.html?.length).toBeLessThan(4096);
    expect(detail.attachments).toMatchObject([{ content_id: "sig@sender", size: image.length }]);
  });

  it("serves attachment records with signed links, and the bytes of exactly one", async () => {
    const { row, attachments } = await storedRow(await richMessage());
    const [logo, report] = attachments;
    if (!logo || !report) throw new Error("fixture lost its attachments");
    const list = await receivedEmailAttachments(row, keyring, downloads);
    expect(list.map((a) => a.id)).toEqual([logo.id, report.id]);
    expect(list[1]).toMatchObject({
      filename: ".._.._etc_report.pdf",
      size: PDF.length,
      content_type: "application/pdf",
      content_disposition: "attachment",
    });
    expect(list[1]).not.toHaveProperty("content_id");
    const url = new URL(list[0]?.download_url ?? "");
    expect(url.pathname).toBe(`/receiving/attachments/${row.id}/${logo.id}`);
    expect(
      verifyReceivedDownload({
        key: downloads.key,
        teamId: row.teamId,
        emailId: row.id,
        attachmentId: logo.id,
        expires: url.searchParams.get("expires"),
        signature: url.searchParams.get("signature"),
      }),
    ).toBe(true);

    expect(await receivedEmailAttachment(row, keyring, report.id, downloads)).toMatchObject({
      id: report.id,
      content_disposition: "attachment",
    });
    expect(await receivedEmailAttachment(row, keyring, randomUUID(), downloads)).toBeNull();

    const opened = await openReceivedAttachment(row, keyring, report.id);
    expect(opened?.content.equals(PDF)).toBe(true);
    expect(opened?.attachment.filename).toBe(".._.._etc_report.pdf");
    expect((await openReceivedAttachment(row, keyring, logo.id))?.content.equals(PNG)).toBe(true);
    expect(await openReceivedAttachment(row, keyring, randomUUID())).toBeNull();
  });

  it("reads a purged row as metadata only", async () => {
    const { row, attachments } = await storedRow(await richMessage());
    const purged: ReceivedEmailRow = {
      ...row,
      rawCiphertext: null,
      rawIv: null,
      rawWrappedDek: null,
      rawKeyVersion: null,
      attachments: null,
      contentPurgedAt: new Date(),
    };
    expect(await openReceivedRaw(purged, keyring)).toBeNull();
    expect((await receivedEmailListItem(purged, keyring)).attachments).toEqual([]);
    const detail = await receivedEmailDetail(purged, keyring, {
      htmlFormat: "data_uri",
      downloads,
    });
    expect(detail).toMatchObject({ html: null, text: null, headers: null, raw: null });
    expect(detail.attachments).toEqual([]);
    expect(detail.subject).toBe(row.subject);
    expect(await receivedEmailAttachments(purged, keyring, downloads)).toEqual([]);
    expect(await openReceivedAttachment(purged, keyring, attachments[0]?.id ?? "")).toBeNull();
  });

  it("reads raw 8-bit header values as UTF-8, or latin1 when they are not UTF-8", async () => {
    const raw = Buffer.concat([
      Buffer.from("From: ana@sender.example\r\nX-Nota: confirmação\r\nX-Legado: ", "utf8"),
      Buffer.from([0x61, 0xe7, 0xe3, 0x6f]),
      Buffer.from("\r\nSubject: =?UTF-8?Q?ol=C3=A1?=\r\n\r\nbody", "utf8"),
    ]);
    const { row } = await storedRow(raw);
    const detail = await receivedEmailDetail(row, keyring, { htmlFormat: "data_uri", downloads });
    expect(detail.headers?.["x-nota"]).toBe("confirmação");
    expect(detail.headers?.["x-legado"]).toBe("ação");
    expect(detail.headers?.subject).toBe("=?UTF-8?Q?ol=C3=A1?=");
  });

  it("answers an unparseable message with its metadata and the raw download", async () => {
    const { row } = await storedRow(Buffer.from([0, 159, 146, 150, 13, 10, 13, 10, 0]));
    const detail = await receivedEmailDetail(row, keyring, { htmlFormat: "data_uri", downloads });
    expect(detail).toMatchObject({ html: null, headers: null });
    expect(detail.raw?.download_url).toContain(`/receiving/raw/${row.id}`);
  });

  it("builds Resend's email.received data: metadata only, no sizes", async () => {
    const { row, attachments } = await storedRow(await richMessage());
    expect(receivedEmailEventData(row, attachments)).toEqual({
      email_id: row.id,
      created_at: "2026-10-11T12:00:00.000Z",
      from: "ana@sender.example",
      to: ["agent@inbound.acme.test", "other@elsewhere.example"],
      bcc: [],
      cc: ["cc@elsewhere.example"],
      received_for: ["agent@inbound.acme.test"],
      message_id: "<abc-123@sender.example>",
      subject: "Pedido nº 42 — olá",
      attachments: [
        {
          id: attachments[0]?.id,
          filename: "logo.png",
          content_type: "image/png",
          content_disposition: "inline",
          content_id: "logo@sender",
        },
        {
          id: attachments[1]?.id,
          filename: ".._.._etc_report.pdf",
          content_type: "application/pdf",
          content_disposition: "attachment",
          content_id: null,
        },
      ],
    });
  });
});
