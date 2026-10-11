import { randomBytes, randomUUID } from "node:crypto";
import {
  deriveReceivedDownloadKey,
  EnvKeyring,
  ingestReceivedEmail,
  verifyReceivedDownload,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";
import type { Context } from "@/server/trpc";

// The router builds its keyring and download key from the env (left live by
// SKIP_ENV_VALIDATION), so the key is set before any procedure runs.
const TEST_KEK = randomBytes(32).toString("base64");
process.env.MASTER_ENCRYPTION_KEY = TEST_KEK;
const keyring = EnvKeyring.fromBase64(TEST_KEK);
const downloadKey = deriveReceivedDownloadKey(Buffer.from(TEST_KEK, "base64"));

let db: Db;
let close: () => Promise<void>;
let acme: string;
let beta: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  acme = await createTeam(db, "recv-acme");
  beta = await createTeam(db, "recv-beta");
  for (const [teamId, name] of [
    [acme, "inbound.acme.test"],
    [beta, "mail.beta.test"],
  ] as const) {
    await db
      .insert(schema.domains)
      .values({ teamId, name, region: "us-east-1", status: "verified", receivingEnabled: true });
  }
});
afterAll(() => close());

beforeEach(() => {
  vi.stubEnv("RECEIVING_MX_HOST", "mx.example.net");
  vi.stubEnv("PUBLIC_API_URL", "https://api.example.test");
});
afterEach(() => vi.unstubAllEnvs());

function caller(teamId: string, supportView?: Context["supportView"]) {
  return createCaller({
    db,
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId,
    role: "owner",
    supportView,
  });
}

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
  "hex",
).toString("base64");

/** A text + HTML message with an inline cid image and one attachment, CRLF as on the wire. */
function message(subject: string, to = "agent@inbound.acme.test"): Buffer {
  return Buffer.from(
    [
      'From: "Ana Souza" <ana@sender.example>',
      `To: ${to}`,
      "Cc: copy@elsewhere.example",
      `Subject: ${subject}`,
      "Message-ID: <abc-123@sender.example>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="mixed"',
      "",
      "--mixed",
      'Content-Type: multipart/related; boundary="rel"',
      "",
      "--rel",
      'Content-Type: multipart/alternative; boundary="alt"',
      "",
      "--alt",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Plain body",
      "--alt",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p>Hi <img src="cid:logo@sender"></p>',
      "--alt--",
      "--rel",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      "Content-ID: <logo@sender>",
      'Content-Disposition: inline; filename="logo.png"',
      "",
      PNG,
      "--rel--",
      "--mixed",
      'Content-Type: text/plain; name="notes.txt"',
      'Content-Disposition: attachment; filename="notes.txt"',
      "",
      "attached notes",
      "--mixed--",
      "",
    ].join("\r\n"),
    "utf8",
  );
}

/** Stores a message the way the MX's /deliver does; returns the receiving team's row id. */
async function receive(raw: Buffer, recipients: string[]): Promise<string> {
  const result = await ingestReceivedEmail(
    { db, keyring, isCloud: false },
    {
      raw,
      envelope: {
        mailFrom: "bounces@sender.example",
        recipients,
        clientIp: "192.0.2.10",
        helo: "mail.sender.example",
        tls: { protocol: "TLSv1.3" },
        auth: { spf: "pass", dkim: "pass", dmarc: "fail", arc: "none" },
        receivedAt: new Date().toISOString(),
      },
    },
  );
  if (!result.ok) throw new Error(`ingest refused: ${result.code} ${result.enhanced}`);
  const [stored] = result.stored;
  if (!stored) throw new Error("nothing stored");
  return stored.id;
}

/** The query of a signed download link, as the API's download route reads it. */
function signed(url: string) {
  const parsed = new URL(url);
  return {
    path: parsed.pathname,
    expires: parsed.searchParams.get("expires"),
    signature: parsed.searchParams.get("signature"),
  };
}

describe("receiving", () => {
  let older: string;
  let newer: string;
  let betaOnly: string;

  beforeAll(async () => {
    older = await receive(message("Older"), ["agent@inbound.acme.test"]);
    newer = await receive(message("Newer"), ["agent@inbound.acme.test"]);
    betaOnly = await receive(message("Beta's", "inbox@mail.beta.test"), ["inbox@mail.beta.test"]);
  });

  it("does not exist on an instance that takes no mail", async () => {
    vi.stubEnv("RECEIVING_MX_HOST", "");
    await expect(caller(acme).receiving.list({})).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(acme).receiving.get({ id: newer })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("lists a team's received mail newest first, metadata only, and never another team's", async () => {
    const list = await caller(acme).receiving.list({});
    expect(list.items.map((row) => row.id)).toEqual([newer, older]);
    expect(list.total).toBe(2);
    expect(list.items[0]).toEqual({
      id: newer,
      from: "ana@sender.example",
      receivedFor: ["agent@inbound.acme.test"],
      subject: "Newer",
      authentication: { spf: "pass", dkim: "pass", dmarc: "fail", arc: "none" },
      attachmentCount: 2,
      createdAt: expect.any(Date),
    });
    expect((await caller(beta).receiving.list({})).items.map((row) => row.id)).toEqual([betaOnly]);
  });

  it("pages with a keyset cursor, counting only on the first page", async () => {
    const first = await caller(acme).receiving.list({ limit: 1 });
    expect(first.items.map((row) => row.id)).toEqual([newer]);
    if (!first.nextCursor) throw new Error("expected a next cursor");
    const second = await caller(acme).receiving.list({ limit: 1, cursor: first.nextCursor });
    expect(second.items.map((row) => row.id)).toEqual([older]);
    expect(second.nextCursor).toBeNull();
    expect(second.total).toBeNull();
  });

  it("opens one email from its raw message, cid images inlined, with download links signed for it alone", async () => {
    const email = await caller(acme).receiving.get({ id: newer });
    expect(email).toMatchObject({
      from: "ana@sender.example",
      to: ["agent@inbound.acme.test"],
      cc: ["copy@elsewhere.example"],
      receivedFor: ["agent@inbound.acme.test"],
      subject: "Newer",
      messageId: "<abc-123@sender.example>",
      envelope: { mailFrom: "bounces@sender.example", clientIp: "192.0.2.10" },
      text: "Plain body",
      hiddenBySupportView: false,
      contentPurgedAt: null,
    });
    expect(email.html).toContain(`src="data:image/png;base64,${PNG}`);
    expect(email.html).not.toContain("cid:");
    expect(email.headers?.subject).toBe("Newer");
    expect(email).not.toHaveProperty("rawCiphertext");
    expect(email.attachments.map((a) => [a.filename, a.contentType, a.inline])).toEqual([
      ["logo.png", "image/png", true],
      ["notes.txt", "text/plain", false],
    ]);

    if (!email.rawUrl) throw new Error("expected a raw download link");
    const raw = signed(email.rawUrl);
    expect(email.rawUrl.startsWith(`https://api.example.test/receiving/raw/${newer}?`)).toBe(true);
    expect(verifyReceivedDownload({ key: downloadKey, teamId: acme, emailId: newer, ...raw })).toBe(
      true,
    );
    // The signature names the team, the email and what is downloaded.
    expect(verifyReceivedDownload({ key: downloadKey, teamId: beta, emailId: newer, ...raw })).toBe(
      false,
    );
    expect(verifyReceivedDownload({ key: downloadKey, teamId: acme, emailId: older, ...raw })).toBe(
      false,
    );

    const notes = email.attachments[1];
    if (!notes) throw new Error("expected the attachment");
    const link = signed(notes.downloadUrl);
    expect(link.path).toBe(`/receiving/attachments/${newer}/${notes.id}`);
    expect(
      verifyReceivedDownload({
        key: downloadKey,
        teamId: acme,
        emailId: newer,
        attachmentId: notes.id,
        ...link,
      }),
    ).toBe(true);
    expect(
      verifyReceivedDownload({ key: downloadKey, teamId: acme, emailId: newer, ...link }),
    ).toBe(false);
  });

  it("never opens another team's email", async () => {
    await expect(caller(beta).receiving.get({ id: newer })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("under a support view reads the envelope and verdicts, never the message", async () => {
    const view = { grantId: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) };
    const email = await caller(acme, view).receiving.get({ id: newer });
    expect(email).toMatchObject({
      subject: "Newer",
      from: "ana@sender.example",
      authentication: { dmarc: "fail" },
      attachmentCount: 2,
      html: null,
      text: null,
      headers: null,
      rawUrl: null,
      attachments: [],
      hiddenBySupportView: true,
    });
  });

  it("answers a purged email with its envelope and no content", async () => {
    const purgedAt = new Date();
    await db
      .update(schema.receivedEmails)
      .set({
        rawCiphertext: null,
        rawIv: null,
        rawWrappedDek: null,
        rawKeyVersion: null,
        attachments: null,
        contentPurgedAt: purgedAt,
      })
      .where(eq(schema.receivedEmails.id, older));
    const email = await caller(acme).receiving.get({ id: older });
    expect(email).toMatchObject({
      subject: "Older",
      html: null,
      text: null,
      headers: null,
      rawUrl: null,
      attachments: [],
      contentPurgedAt: purgedAt,
    });
  });
});
