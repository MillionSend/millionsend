import { randomBytes } from "node:crypto";
import { type AddressInfo, connect, type Socket } from "node:net";
import { decryptEmailBody, EnvKeyring, generateApiKey, hashRecipient } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSmtpServer,
  MAX_CONNECTIONS_PER_IP,
  MAX_RCPT_TO,
  SMTP_USERNAME,
} from "../src/smtp.js";

let db: Db;
let closeDb: () => Promise<void>;
let teamId: string;
let token: string;
let port: number;
let server: ReturnType<typeof createSmtpServer>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const enqueued: { emailId: string; startAfter?: Date }[] = [];

const transport = (auth?: { user: string; pass: string }) =>
  nodemailer.createTransport({
    host: "127.0.0.1",
    port,
    secure: false,
    ignoreTLS: true,
    ...(auth ? { auth } : {}),
  });

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  teamId = await createTeam(db, "smtp-team");
  await db.insert(schema.domains).values({
    teamId,
    name: "acme.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  const key = generateApiKey();
  token = key.token;
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "smtp",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  server = createSmtpServer(serverDeps());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.server.address() as AddressInfo).port;
});

const serverDeps = () => ({
  db,
  keyring,
  isCloud: true,
  allowInsecureAuth: true,
  enqueueEmailSend: async (emailId: string, opts?: { startAfter?: Date }) => {
    enqueued.push({ emailId, ...(opts?.startAfter ? { startAfter: opts.startAfter } : {}) });
  },
});

const emailRow = async (response: string) => {
  const id = /Queued as (\S+)/.exec(response)?.[1];
  const [row] = await db
    .select()
    .from(schema.emails)
    .where(eq(schema.emails.id, id as string));
  if (!row) throw new Error("email row missing");
  return row;
};

/** Raw SMTP client: waits for each final reply line, then sends the next command. */
const dialogue = (commands: string[], atPort = port): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const socket = connect(atPort, "127.0.0.1");
    const replies: string[] = [];
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => {
      buf += data;
      let eol = buf.indexOf("\r\n");
      while (eol !== -1) {
        const line = buf.slice(0, eol);
        buf = buf.slice(eol + 2);
        if (/^\d{3} /.test(line)) {
          replies.push(line);
          const next = commands[replies.length - 1];
          if (next === undefined) socket.end();
          else socket.write(`${next}\r\n`);
        }
        eol = buf.indexOf("\r\n");
      }
    });
    socket.on("close", () => resolve(replies));
    socket.on("error", reject);
  });

const greeting = (): Promise<{ socket: Socket; line: string }> =>
  new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.setEncoding("utf8");
    socket.once("data", (line: string) => resolve({ socket, line }));
    socket.on("error", reject);
  });

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(resolve));
  await closeDb();
});

describe("smtp relay", () => {
  it("accepts an authenticated send into the shared pipeline", async () => {
    const info = await transport({ user: SMTP_USERNAME, pass: token }).sendMail({
      from: "Acme <a@acme.dev>",
      to: "r@example.com",
      cc: "copy@example.com",
      bcc: "hidden@example.com",
      replyTo: "reply@acme.dev",
      subject: "hello over smtp",
      text: "plain body",
      html: "<p>rich body</p>",
    });
    expect(info.response).toContain("Queued as");
    const id = /Queued as (\S+)/.exec(info.response)?.[1];
    expect(id).toBeTruthy();

    const [row] = await db
      .select()
      .from(schema.emails)
      .where(eq(schema.emails.id, id as string));
    if (!row) throw new Error("email row missing");
    expect(row.teamId).toBe(teamId);
    expect(row.from).toBe("Acme <a@acme.dev>");
    expect(row.to).toEqual(["r@example.com"]);
    expect(row.cc).toEqual(["copy@example.com"]);
    expect(row.bcc).toEqual(["hidden@example.com"]);
    expect(row.replyTo).toEqual(["reply@acme.dev"]);
    expect(row.subject).toBe("hello over smtp");
    expect(row.latestStatus).toBe("queued");
    expect(enqueued.map((e) => e.emailId)).toContain(id);

    // Stored encrypted at rest, and html/text map to the right fields.
    expect(Buffer.from(row.bodyCiphertext ?? []).includes("rich body")).toBe(false);
    const body = await decryptEmailBody(
      {
        // biome-ignore lint/style/noNonNullAssertion: row was just inserted with a body
        ciphertext: row.bodyCiphertext!,
        // biome-ignore lint/style/noNonNullAssertion: row was just inserted with a body
        iv: row.bodyIv!,
        // biome-ignore lint/style/noNonNullAssertion: row was just inserted with a body
        wrappedDek: row.bodyWrappedDek!,
        // biome-ignore lint/style/noNonNullAssertion: row was just inserted with a body
        keyVersion: row.bodyKeyVersion!,
      },
      keyring,
      { teamId: row.teamId, rowId: row.id },
    );
    expect(body.html).toContain("rich body");
    expect(body.text).toContain("plain body");
    expect(body.html).not.toContain("plain body");
  });

  it("rejects a wrong password with 535", async () => {
    await expect(
      transport({ user: SMTP_USERNAME, pass: "ms_live_definitelywrongkey000000" }).verify(),
    ).rejects.toMatchObject({ responseCode: 535 });
  });

  it("rejects a wrong username with 535", async () => {
    await expect(transport({ user: "resend", pass: token }).verify()).rejects.toMatchObject({
      responseCode: 535,
    });
  });

  it("rejects unauthenticated MAIL", async () => {
    await expect(
      transport().sendMail({
        from: "a@acme.dev",
        to: "r@example.com",
        subject: "s",
        text: "t",
      }),
    ).rejects.toMatchObject({ responseCode: 530 });
  });

  it("rejects with 550 when all recipients are suppressed", async () => {
    await db.insert(schema.suppressions).values({
      teamId,
      email: "dead@example.com",
      emailHash: hashRecipient("dead@example.com"),
      reason: "hard_bounce",
    });
    await expect(
      transport({ user: SMTP_USERNAME, pass: token }).sendMail({
        from: "a@acme.dev",
        to: "dead@example.com",
        subject: "s",
        text: "t",
      }),
    ).rejects.toMatchObject({ responseCode: 550 });
  });

  it("confines a domain-scoped key to its domain (550 from another)", async () => {
    const [scopedDomain] = await db
      .insert(schema.domains)
      .values({
        teamId,
        name: "scoped.dev",
        region: "us-east-1",
        status: "verified",
        verifiedAt: new Date(),
      })
      .returning({ id: schema.domains.id });
    if (!scopedDomain) throw new Error("domain insert failed");
    const scopedKey = generateApiKey();
    await db.insert(schema.apiKeys).values({
      teamId,
      name: "scoped",
      tokenPrefix: scopedKey.tokenPrefix,
      keyHash: scopedKey.keyHash,
      last4: scopedKey.last4,
      domainId: scopedDomain.id,
    });
    const auth = { user: SMTP_USERNAME, pass: scopedKey.token };
    // acme.dev is verified for the team but is not this key's domain.
    await expect(
      transport(auth).sendMail({
        from: "a@acme.dev",
        to: "r@example.com",
        subject: "s",
        text: "t",
      }),
    ).rejects.toMatchObject({ responseCode: 550 });
    const ok = await transport(auth).sendMail({
      from: "a@scoped.dev",
      to: "r@example.com",
      subject: "s",
      text: "t",
    });
    expect(ok.response).toContain("Queued as");
  });

  it("rejects an unverified sender domain with 554", async () => {
    await expect(
      transport({ user: SMTP_USERNAME, pass: token }).sendMail({
        from: "a@not-ours.dev",
        to: "r@example.com",
        subject: "s",
        text: "t",
      }),
    ).rejects.toMatchObject({ responseCode: 554 });
  });

  it("stores display names canonically quoted", async () => {
    const info = await transport({ user: SMTP_USERNAME, pass: token }).sendMail({
      from: { name: "Doe, John", address: "a@acme.dev" },
      to: { name: "Roe, Jane", address: "r@example.com" },
      subject: "s",
      text: "t",
    });
    const row = await emailRow(info.response);
    expect(row.from).toBe('"Doe, John" <a@acme.dev>');
    expect(row.to).toEqual(['"Roe, Jane" <r@example.com>']);
  });

  it("rejects a display name that carries an address with 553", async () => {
    await expect(
      transport({ user: SMTP_USERNAME, pass: token }).sendMail({
        from: "a@acme.dev",
        to: { name: "ceo@victim.com", address: "r@example.com" },
        subject: "s",
        text: "t",
      }),
    ).rejects.toMatchObject({ responseCode: 553 });
  });

  it("delivers to the envelope only: header-only recipients are dropped, envelope extras are BCC", async () => {
    const info = await transport({ user: SMTP_USERNAME, pass: token }).sendMail({
      from: "a@acme.dev",
      to: ["r@example.com", "ghost@example.com"],
      subject: "s",
      text: "t",
      envelope: { from: "a@acme.dev", to: ["r@example.com", "hidden@example.com"] },
    });
    const row = await emailRow(info.response);
    expect(row.to).toEqual(["r@example.com"]);
    expect(row.bcc).toEqual(["hidden@example.com"]);
  });

  it("caps RCPT TO at MAX_RCPT_TO with 452", async () => {
    const rcpts = Array.from({ length: MAX_RCPT_TO + 1 }, (_, i) => `many${i}@example.com`);
    const info = await transport({ user: SMTP_USERNAME, pass: token }).sendMail({
      from: "a@acme.dev",
      to: "many0@example.com",
      subject: "s",
      text: "t",
      envelope: { from: "a@acme.dev", to: rcpts },
    });
    expect(info.accepted).toHaveLength(MAX_RCPT_TO);
    expect(info.rejected).toEqual([rcpts[MAX_RCPT_TO]]);
  });

  it("drops the connection after repeated AUTH failures", async () => {
    const bad = `AUTH PLAIN ${Buffer.from(`\0${SMTP_USERNAME}\0ms_live_wrong`).toString("base64")}`;
    const replies = await dialogue(["EHLO client.test", bad, bad, bad, "NOOP"]);
    expect(replies.slice(2, 4).every((r) => r.startsWith("535"))).toBe(true);
    expect(replies[4]).toMatch(/^421/);
    // The server hung up: NOOP got no reply.
    expect(replies).toHaveLength(5);
  });

  it("refuses connections past the per-IP cap", async () => {
    const open: Socket[] = [];
    try {
      for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i++) {
        const { socket, line } = await greeting();
        open.push(socket);
        expect(line).toMatch(/^220/);
      }
      const extra = await greeting();
      open.push(extra.socket);
      expect(extra.line).toMatch(/^421/);
    } finally {
      for (const socket of open) socket.destroy();
    }
    // Slots are released on close.
    await new Promise((r) => setTimeout(r, 50));
    const { socket, line } = await greeting();
    socket.destroy();
    expect(line).toMatch(/^220/);
  });

  it("rejects an oversized DATA with 552 without buffering it", async () => {
    const small = createSmtpServer({ ...serverDeps(), maxMessageBytes: 2048 });
    await new Promise<void>((resolve) => small.listen(0, "127.0.0.1", resolve));
    const smallPort = (small.server.address() as AddressInfo).port;
    try {
      await expect(
        nodemailer
          .createTransport({
            host: "127.0.0.1",
            port: smallPort,
            secure: false,
            ignoreTLS: true,
            auth: { user: SMTP_USERNAME, pass: token },
          })
          .sendMail({
            from: "a@acme.dev",
            to: "r@example.com",
            subject: "s",
            text: "x".repeat(10 * 1024),
          }),
      ).rejects.toMatchObject({ responseCode: 552 });
    } finally {
      await new Promise<void>((resolve) => small.close(resolve));
    }
  });

  it("rejects attachments with 554", async () => {
    await expect(
      transport({ user: SMTP_USERNAME, pass: token }).sendMail({
        from: "a@acme.dev",
        to: "r@example.com",
        subject: "s",
        text: "t",
        attachments: [{ filename: "x.txt", content: "attached" }],
      }),
    ).rejects.toMatchObject({ responseCode: 554 });
  });
});
