import { randomBytes, randomUUID } from "node:crypto";
import {
  defaultSafety,
  deriveInboxKeys,
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
import type { SessionRole } from "@/server/membership";
import { createCaller } from "@/server/routers";
import type { Context } from "@/server/trpc";

// Another group's functions: the router's contract with them is what is tested here.
const core = vi.hoisted(() => ({
  openReceivedExtracted: vi.fn(),
  releaseQuarantined: vi.fn(),
  deleteReceivedEmail: vi.fn(),
}));
vi.mock("@millionsend/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@millionsend/core")>()),
  ...core,
}));
vi.mock("@/server/queue", () => ({
  enqueueInboxForward: async () => {},
  enqueueWebhookDeliveries: async () => {},
}));

// The router builds its keyring and download key from the env (left live by
// SKIP_ENV_VALIDATION), so the key is set before any procedure runs.
const TEST_KEK = randomBytes(32).toString("base64");
process.env.MASTER_ENCRYPTION_KEY = TEST_KEK;
const keyring = EnvKeyring.fromBase64(TEST_KEK);
const downloadKey = deriveReceivedDownloadKey(Buffer.from(TEST_KEK, "base64"));
// Typed loosely on purpose: ingest's dependencies grow with screening and threading.
const ingestDeps = {
  keyring,
  isCloud: false,
  inboxKeys: deriveInboxKeys(Buffer.from(TEST_KEK, "base64")),
  judgeAvailable: false,
};

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
    // Catch-all: mail to addresses without an inbox is kept, as before inboxes.
    await db.insert(schema.domains).values({
      teamId,
      name,
      region: "us-east-1",
      status: "verified",
      receivingEnabled: true,
      receivingCatchAll: true,
    });
  }
});
afterAll(() => close());

beforeEach(() => {
  vi.stubEnv("RECEIVING_MX_HOST", "mx.example.net");
  vi.stubEnv("PUBLIC_API_URL", "https://api.example.test");
});
afterEach(() => vi.unstubAllEnvs());

function caller(teamId: string, supportView?: Context["supportView"], role: SessionRole = "owner") {
  return createCaller({
    db,
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId,
    role,
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
    { db, ...ingestDeps },
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
      fromName: expect.any(String),
      receivedFor: ["agent@inbound.acme.test"],
      subject: "Newer",
      attachmentCount: 2,
      extractedKinds: [],
      spamVerdict: "pass",
      virusVerdict: null,
      held: false,
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
    if (!notes?.downloadUrl) throw new Error("expected the attachment's link");
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

describe("received mail as Inboxes reads it", () => {
  let held: string;
  let infected: string;
  let withCode: string;
  let delivered: string;
  let inboxId: string;
  let threadId: string;

  beforeAll(async () => {
    held = await receive(message("Held for screening"), ["agent@inbound.acme.test"]);
    infected = await receive(message("Infected"), ["agent@inbound.acme.test"]);
    withCode = await receive(message("Your code"), ["agent@inbound.acme.test"]);
    delivered = await receive(message("Delivered code"), ["agent@inbound.acme.test"]);
    const [domain] = await db
      .select({ id: schema.domains.id })
      .from(schema.domains)
      .where(eq(schema.domains.name, "inbound.acme.test"));
    if (!domain) throw new Error("no domain");
    const [inbox] = await db
      .insert(schema.inboxes)
      .values({
        teamId: acme,
        kind: "agent",
        emailAddress: "agent@inbound.acme.test",
        localPart: "agent",
        domainId: domain.id,
        name: "Agent",
        safety: defaultSafety("agent", false),
      })
      .returning({ id: schema.inboxes.id });
    if (!inbox) throw new Error("no inbox");
    inboxId = inbox.id;
    const [thread] = await db
      .insert(schema.inboxThreads)
      .values({ teamId: acme, inboxId })
      .returning({ id: schema.inboxThreads.id });
    if (!thread) throw new Error("no thread");
    threadId = thread.id;
    const membership = {
      inboxId,
      teamId: acme,
      threadId: thread.id,
      address: "agent@inbound.acme.test",
      senderTrust: "external" as const,
    };
    await db.insert(schema.receivedEmailInboxes).values([
      {
        ...membership,
        receivedEmailId: held,
        verdict: "quarantined",
        quarantineReason: "injection",
        quarantinedAt: new Date(),
      },
      { ...membership, receivedEmailId: delivered, verdict: "clean", deliveredAt: new Date() },
    ]);
    await db
      .update(schema.receivedEmails)
      .set({ catchAll: false })
      .where(eq(schema.receivedEmails.id, held));
    await db
      .update(schema.receivedEmails)
      .set({ virusVerdict: "fail", virusSignature: "Eicar-Test-Signature" })
      .where(eq(schema.receivedEmails.id, infected));
    await db
      .update(schema.receivedEmails)
      .set({ extractedKinds: ["code"] })
      .where(eq(schema.receivedEmails.id, withCode));
  });

  const ids = async (input: Parameters<ReturnType<typeof caller>["receiving"]["list"]>[0]) =>
    (await caller(acme).receiving.list(input)).items.map((row) => row.id);

  it("filters All received by inbox, catch-all, verdict and search", async () => {
    expect(await ids({ inbox: inboxId })).toEqual([delivered, held]);
    expect(await ids({ inbox: "catch_all" })).not.toContain(held);
    expect(await ids({ verdict: "quarantined" })).toEqual([held]);
    expect(await ids({ verdict: "virus" })).toEqual([infected]);
    const clean = await ids({ verdict: "clean" });
    expect(clean).toContain(withCode);
    expect(clean).not.toContain(held);
    expect(clean).not.toContain(infected);
    expect(await ids({ search: "infect" })).toEqual([infected]);
    expect((await caller(acme).receiving.list({ inbox: inboxId })).total).toBe(2);
  });

  it("marks held rows and names a found code's kind, never its value", async () => {
    const rows = (await caller(acme).receiving.list({})).items;
    expect(rows.find((row) => row.id === held)?.held).toBe(true);
    const coded = rows.find((row) => row.id === withCode);
    expect(coded?.extractedKinds).toEqual(["code"]);
    expect(JSON.stringify(coded)).not.toContain("482913");
  });

  it("blocks every download of an email that carries malware", async () => {
    const email = await caller(acme).receiving.get({ id: infected });
    expect(email.virus).toEqual({ verdict: "fail", signature: "Eicar-Test-Signature" });
    expect(email.rawUrl).toBeNull();
    expect(email.attachments.length).toBeGreaterThan(0);
    expect(email.attachments.every((a) => a.downloadUrl === null)).toBe(true);
    expect(email.heldCatchAll).toBe(true);
  });

  it("shows a code only where an agent could read it too, and records the read", async () => {
    core.openReceivedExtracted.mockResolvedValue({
      text: "",
      quoted: "",
      signature: "",
      code: { kind: "otp", value: "482913" },
      link: null,
      flags: [],
    });
    expect((await caller(acme).receiving.get({ id: withCode })).extracted?.code).toBe("482913");
    expect((await caller(acme).receiving.get({ id: held })).extracted?.code).toBeNull();
    expect((await caller(acme).receiving.get({ id: infected })).extracted?.code).toBeNull();
    const view = { grantId: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) };
    expect((await caller(acme, view).receiving.get({ id: withCode })).extracted).toBeNull();

    const read = await caller(acme).receiving.get({ id: delivered });
    expect(read.extracted?.code).toBe("482913");
    expect(read.memberships).toMatchObject([{ inboxId, verdict: "clean" }]);
    const activity = await db
      .select({ action: schema.inboxActivity.action, actor: schema.inboxActivity.actor })
      .from(schema.inboxActivity)
      .where(eq(schema.inboxActivity.emailId, delivered));
    expect(activity).toEqual([{ action: "code.read", actor: "user:u1" }]);
  });

  it("puts a reply and a forward of the email on its timeline", async () => {
    const [original] = await db
      .select({ messageId: schema.receivedEmails.messageId })
      .from(schema.receivedEmails)
      .where(eq(schema.receivedEmails.id, delivered));
    if (!original?.messageId) throw new Error("no message id");
    const [reply, unrelated] = await db
      .insert(schema.emails)
      .values(
        [original.messageId, "<other@sender.example>"].map((parent) => ({
          teamId: acme,
          inboxId,
          threadId,
          from: "agent@inbound.acme.test",
          to: ["ana@sender.example"],
          subject: "Re: Delivered code",
          headers: { "In-Reply-To": parent },
        })),
      )
      .returning({ id: schema.emails.id });
    if (!reply || !unrelated) throw new Error("no emails");
    const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    await db.insert(schema.inboxActivity).values([
      {
        teamId: acme,
        inboxId,
        actor: "user:u1",
        action: "email.sent",
        threadId,
        emailId: reply.id,
        createdAt: at(1),
      },
      {
        teamId: acme,
        inboxId,
        actor: "user:u1",
        action: "email.sent",
        threadId,
        emailId: unrelated.id,
        createdAt: at(2),
      },
      {
        teamId: acme,
        inboxId,
        actor: "system",
        action: "email.forwarded",
        threadId,
        emailId: delivered,
        createdAt: at(3),
      },
    ]);
    const email = await caller(acme).receiving.get({ id: delivered });
    expect(email.activity.map((a) => a.action)).toEqual(["email.sent", "email.forwarded"]);
  });

  it("erases an email for owners and admins only", async () => {
    core.deleteReceivedEmail.mockResolvedValue(true);
    await expect(
      caller(acme, undefined, "member").receiving.delete({ id: withCode }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(core.deleteReceivedEmail).not.toHaveBeenCalled();
    await caller(acme, undefined, "admin").receiving.delete({ id: withCode });
    expect(core.deleteReceivedEmail).toHaveBeenCalledWith(expect.anything(), {
      teamId: acme,
      id: withCode,
      actor: { kind: "user", userId: "u1" },
    });
    core.deleteReceivedEmail.mockResolvedValue(false);
    await expect(caller(beta).receiving.delete({ id: withCode })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("releases a virus-held catch-all row, which belongs to no inbox", async () => {
    core.releaseQuarantined.mockResolvedValue({
      ok: true,
      releasedAt: new Date(),
      trustedSender: null,
    });
    await caller(acme).receiving.release({ id: infected });
    expect(core.releaseQuarantined).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enqueueInboxForward: expect.any(Function) }),
      expect.objectContaining({ teamId: acme, receivedEmailId: infected, inboxId: null }),
    );
    core.releaseQuarantined.mockResolvedValue({ ok: false, reason: "not_quarantined" });
    await expect(caller(acme).receiving.release({ id: infected })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("answers the operator's intake card for the operator only", async () => {
    await expect(caller(acme).receiving.health()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
