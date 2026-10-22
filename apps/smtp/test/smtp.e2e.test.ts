import { randomBytes } from "node:crypto";
import { type AddressInfo, connect, type Socket } from "node:net";
import {
  DAY_MS,
  decryptEmailBody,
  EnvKeyring,
  generateApiKey,
  hashRecipient,
  MAX_SUBJECT_LENGTH,
  OVERAGE_HARD_CAP,
  undeliverableRecipientMessage,
  utcDay,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import nodemailer from "nodemailer";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const transport = (auth?: { user: string; pass: string }, atPort = port) =>
  nodemailer.createTransport({
    host: "127.0.0.1",
    port: atPort,
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
  onboardingEmailFrom: "MillionSend <hello@ms.example>",
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

const greeting = (atPort = port): Promise<{ socket: Socket; line: string }> =>
  new Promise((resolve, reject) => {
    const socket = connect(atPort, "127.0.0.1");
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
    const id = /Queued as (\S+)/.exec(info.response ?? "")?.[1];
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
        subject: "smtp-refused",
        text: "t",
      }),
    ).rejects.toMatchObject({ responseCode: 550 });
    // The relay refuses without keeping a suppressed email.
    const rows = await db
      .select()
      .from(schema.emails)
      .where(eq(schema.emails.subject, "smtp-refused"));
    expect(rows).toHaveLength(0);
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

  it("refuses the instance's onboarding sender with 550, even from the team holding its domain", async () => {
    await db.insert(schema.domains).values({
      teamId,
      name: "ms.example",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
    });
    const auth = { user: SMTP_USERNAME, pass: token };
    for (const from of ["MillionSend <hello@ms.example>", "HELLO@ms.example"]) {
      await expect(
        transport(auth).sendMail({ from, to: "r@example.com", subject: "s", text: "t" }),
      ).rejects.toMatchObject({
        responseCode: 550,
        response: expect.stringContaining(
          "hello@ms.example is reserved for MillionSend's own onboarding email. Add and verify a domain to send your own emails: https://docs.millionsend.com/concepts/domains",
        ),
      });
    }
    const ok = await transport(auth).sendMail({
      from: "news@ms.example",
      to: "r@example.com",
      subject: "s",
      text: "t",
    });
    expect(ok.response).toContain("Queued as");
  });

  it("stores display names canonically quoted", async () => {
    const info = await transport({ user: SMTP_USERNAME, pass: token }).sendMail({
      from: { name: "Doe, John", address: "a@acme.dev" },
      to: { name: "Roe, Jane", address: "r@example.com" },
      subject: "s",
      text: "t",
    });
    const row = await emailRow(info.response ?? "");
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

  it("refuses a Subject with control characters with 554, as POST /emails does", async () => {
    for (const subject of ["a\u0000b", "a\u0007b"]) {
      await expect(
        transport({ user: SMTP_USERNAME, pass: token }).sendMail({
          from: "a@acme.dev",
          to: "r@example.com",
          subject,
          text: "t",
        }),
      ).rejects.toMatchObject({
        responseCode: 554,
        response: expect.stringContaining("Subject must not contain control characters"),
      });
    }
  });

  it("refuses a Subject past MAX_SUBJECT_LENGTH characters with 554, as POST /emails does", async () => {
    const send = (subject: string) =>
      transport({ user: SMTP_USERNAME, pass: token }).sendMail({
        from: "a@acme.dev",
        to: "r@example.com",
        subject,
        text: "t",
      });
    await expect(send("s".repeat(MAX_SUBJECT_LENGTH + 1))).rejects.toMatchObject({
      responseCode: 554,
      response: expect.stringContaining(`Subject must be at most ${MAX_SUBJECT_LENGTH} characters`),
    });
    const row = await emailRow((await send("s".repeat(MAX_SUBJECT_LENGTH))).response ?? "");
    expect(row.subject).toHaveLength(MAX_SUBJECT_LENGTH);
  });

  it("delivers to the envelope only: header-only recipients are dropped, envelope extras are BCC", async () => {
    const info = await transport({ user: SMTP_USERNAME, pass: token }).sendMail({
      from: "a@acme.dev",
      to: ["r@example.com", "ghost@example.com"],
      subject: "s",
      text: "t",
      envelope: { from: "a@acme.dev", to: ["r@example.com", "hidden@example.com"] },
    });
    const row = await emailRow(info.response ?? "");
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

  describe("recipient domains", () => {
    beforeEach(() => {
      vi.stubEnv("RECIPIENT_DOMAIN_CHECK", "on");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("refuses an impossible recipient at RCPT TO with 550 5.1.2 and queues the message for the rest", async () => {
      const info = await transport({ user: SMTP_USERNAME, pass: token }).sendMail({
        from: "a@acme.dev",
        to: "success@simulator.amazonses.com",
        cc: "someone@test.invalid",
        subject: "s",
        text: "t",
      });
      expect(info.accepted).toEqual(["success@simulator.amazonses.com"]);
      expect(info.rejected).toEqual(["someone@test.invalid"]);
      expect(info.rejectedErrors).toMatchObject([
        {
          responseCode: 550,
          response: `550 5.1.2 ${undeliverableRecipientMessage(
            { address: "someone@test.invalid", reason: "reserved_name" },
            { forSend: true },
          )}`,
        },
      ]);
      const row = await emailRow(info.response ?? "");
      expect(row).toMatchObject({
        to: ["success@simulator.amazonses.com"],
        cc: null,
        bcc: null,
        latestStatus: "queued",
      });
      expect(enqueued.map((e) => e.emailId)).toContain(row.id);
    });

    it("drops the session with 421 once MAX_RCPT_TO recipients were refused", async () => {
      const auth = `AUTH PLAIN ${Buffer.from(`\0${SMTP_USERNAME}\0${token}`).toString("base64")}`;
      const refused = Array.from({ length: MAX_RCPT_TO }, (_, i) => `RCPT TO:<r${i}@foo.test>`);
      const replies = await dialogue([
        "EHLO client.test",
        auth,
        "MAIL FROM:<a@acme.dev>",
        ...refused,
        "RCPT TO:<success@simulator.amazonses.com>",
        "NOOP",
      ]);
      // After the greeting, EHLO, AUTH and MAIL replies.
      const rcptReplies = replies.slice(4);
      expect(rcptReplies.slice(0, MAX_RCPT_TO).every((r) => r.startsWith("550 5.1.2 "))).toBe(true);
      expect(rcptReplies[MAX_RCPT_TO]).toMatch(/^421/);
      // The server hung up: NOOP got no reply.
      expect(rcptReplies).toHaveLength(MAX_RCPT_TO + 1);
    });
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
    // Its own server: on the shared one, a session dropped while its client
    // kept sending holds its slot until smtp-server destroys the socket, 5 s on.
    const own = createSmtpServer(serverDeps());
    await new Promise<void>((resolve) => own.listen(0, "127.0.0.1", resolve));
    const ownPort = (own.server.address() as AddressInfo).port;
    try {
      const open: Socket[] = [];
      try {
        for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i++) {
          const { socket, line } = await greeting(ownPort);
          open.push(socket);
          expect(line).toMatch(/^220/);
        }
        const extra = await greeting(ownPort);
        open.push(extra.socket);
        expect(extra.line).toMatch(/^421/);
      } finally {
        for (const socket of open) socket.destroy();
      }
      // Slots are released on close.
      await new Promise((r) => setTimeout(r, 50));
      const { socket, line } = await greeting(ownPort);
      socket.destroy();
      expect(line).toMatch(/^220/);
    } finally {
      await new Promise<void>((resolve) => own.close(resolve));
    }
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

  it("rejects attachments with 554, program files and PDFs alike", async () => {
    for (const attachment of [
      { filename: "x.txt", content: "attached" },
      { filename: "invoice.exe", content: Buffer.from("MZ") },
      { filename: "fatura.pdf", content: Buffer.from("%PDF-1.7 statement") },
    ]) {
      await expect(
        transport({ user: SMTP_USERNAME, pass: token }).sendMail({
          from: "a@acme.dev",
          to: "r@example.com",
          subject: "s",
          text: "t",
          attachments: [attachment],
        }),
        attachment.filename,
      ).rejects.toMatchObject({ responseCode: 554 });
    }
  });

  it("refuses a monthly plan at its included volume with 452 until overage is on", async () => {
    const periodStart = new Date(Date.now() - 5 * DAY_MS);
    const periodEnd = new Date(periodStart.getTime() + 30 * DAY_MS);
    await db
      .update(schema.teams)
      .set({
        plan: "pro",
        planQuota: 100_000,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        overageEnabled: false,
      })
      .where(eq(schema.teams.id, teamId));
    await db.insert(schema.usagePeriods).values({ teamId, periodStart, accepted: 100_000 });
    const mail = { from: "a@acme.dev", to: "r@example.com", subject: "s", text: "t" };
    await expect(
      transport({ user: SMTP_USERNAME, pass: token }).sendMail(mail),
    ).rejects.toMatchObject({
      responseCode: 452,
      response: expect.stringContaining("Monthly sending quota exceeded"),
    });

    await db.update(schema.teams).set({ overageEnabled: true }).where(eq(schema.teams.id, teamId));
    const info = await transport({ user: SMTP_USERNAME, pass: token }).sendMail(mail);
    expect(info.response).toContain("Queued as");
  });

  it("with overage on, refuses with 452 at the hard cap and accepts below it", async () => {
    const cap = 100_000 * OVERAGE_HARD_CAP;
    const setAccepted = (accepted: number) =>
      db
        .update(schema.usagePeriods)
        .set({ accepted })
        .where(eq(schema.usagePeriods.teamId, teamId));
    const mail = { from: "a@acme.dev", to: "r@example.com", subject: "s", text: "t" };
    await setAccepted(cap);
    await expect(
      transport({ user: SMTP_USERNAME, pass: token }).sendMail(mail),
    ).rejects.toMatchObject({
      responseCode: 452,
      response: expect.stringContaining(`${OVERAGE_HARD_CAP} times the included volume`),
    });

    await setAccepted(cap - 1);
    const info = await transport({ user: SMTP_USERNAME, pass: token }).sendMail(mail);
    expect(info.response).toContain("Queued as");
  });
});

describe("rate limits", () => {
  let limitTeam: string;
  const servers: ReturnType<typeof createSmtpServer>[] = [];
  const mail = { from: "a@limits.example", to: "r@example.com", subject: "s", text: "t" };

  beforeAll(async () => {
    limitTeam = await createTeam(db, "smtp-limits");
    await db.insert(schema.domains).values({
      teamId: limitTeam,
      name: "limits.example",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
    });
  });
  // The key's bucket counts in fixed minutes of the database clock; calls
  // straddling a boundary would see a fresh window. Wait out the last
  // seconds of one.
  beforeEach(async () => {
    const left = 60_000 - (Date.now() % 60_000);
    if (left < 3_000) await new Promise((resolve) => setTimeout(resolve, left));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(resolve))));
  });

  async function addKey() {
    const key = generateApiKey();
    const [row] = await db
      .insert(schema.apiKeys)
      .values({
        teamId: limitTeam,
        name: "limited",
        tokenPrefix: key.tokenPrefix,
        keyHash: key.keyHash,
        last4: key.last4,
      })
      .returning({ id: schema.apiKeys.id });
    if (!row) throw new Error("key insert failed");
    return { id: row.id, auth: { user: SMTP_USERNAME, pass: key.token } };
  }

  async function listen(limits: { rateLimitPerMinute?: number; teamRateLimitPerMinute?: number }) {
    const limited = createSmtpServer({ ...serverDeps(), ...limits });
    servers.push(limited);
    await new Promise<void>((resolve) => limited.listen(0, "127.0.0.1", resolve));
    return (limited.server.address() as AddressInfo).port;
  }

  const teamEmails = async () =>
    (await db.select().from(schema.emails).where(eq(schema.emails.teamId, limitTeam))).length;

  it("refuses a message past its key's per-minute budget, kept in the API's bucket, with 451 4.7.1 at MAIL FROM until the next minute", async () => {
    const key = await addKey();
    const limitedPort = await listen({ rateLimitPerMinute: 2 });
    const bucket = async () =>
      (
        await db
          .select()
          .from(schema.apiRateLimits)
          .where(eq(schema.apiRateLimits.apiKeyId, key.id))
      )[0];

    const before = await teamEmails();
    const plain = Buffer.from(`\0${key.auth.user}\0${key.auth.pass}`).toString("base64");
    const replies = await dialogue(
      [
        "EHLO client.test",
        "MAIL FROM:<a@limits.example>",
        `AUTH PLAIN ${plain}`,
        "MAIL FROM:<a@limits.example>",
        "RSET",
        "MAIL FROM:<a@limits.example>",
        "RSET",
        "MAIL FROM:<a@limits.example>",
      ],
      limitedPort,
    );
    await expect(transport(key.auth, limitedPort).sendMail(mail)).rejects.toMatchObject({
      responseCode: 451,
      command: "MAIL FROM",
      response: expect.stringMatching(/^451 4\.7\.1 /),
    });
    // After the greeting and EHLO: a MAIL before AUTH never reaches the
    // count, and every MAIL after RSET is counted again.
    expect(replies.slice(2)).toEqual([
      expect.stringMatching(/^530 /),
      expect.stringMatching(/^235 /),
      expect.stringMatching(/^250 /),
      expect.stringMatching(/^250 /),
      expect.stringMatching(/^250 /),
      expect.stringMatching(/^250 /),
      expect.stringMatching(/^451 4\.7\.1 Too many messages, try again in \d+s$/),
    ]);
    expect((await bucket())?.count).toBe(4);
    expect(await teamEmails()).toBe(before);

    // The bucket's window follows the database clock: move it a minute back.
    await db
      .update(schema.apiRateLimits)
      .set({ windowStart: sql`${schema.apiRateLimits.windowStart} - interval '1 minute'` })
      .where(eq(schema.apiRateLimits.apiKeyId, key.id));
    const info = await transport(key.auth, limitedPort).sendMail(mail);
    expect(info.response).toContain("Queued as");
    expect((await bucket())?.count).toBe(1);
  });

  it("caps a team across all of its keys with 451 4.7.1 at MAIL FROM until the next minute", async () => {
    const first = await addKey();
    const second = await addKey();
    const limitedPort = await listen({ teamRateLimitPerMinute: 2 });
    const now = Date.now();
    const minute = now - (now % 60_000);
    vi.useFakeTimers({ now: minute, toFake: ["Date"] });
    const send = (auth: { user: string; pass: string }) =>
      transport(auth, limitedPort).sendMail(mail);

    expect((await send(first.auth)).response).toContain("Queued as");
    expect((await send(second.auth)).response).toContain("Queued as");
    const before = await teamEmails();
    await expect(send(first.auth)).rejects.toMatchObject({
      responseCode: 451,
      command: "MAIL FROM",
      response: "451 4.7.1 Too many messages, try again in 60s",
    });
    expect(await teamEmails()).toBe(before);

    vi.setSystemTime(minute + 60_000);
    expect((await send(second.auth)).response).toContain("Queued as");
  });
});

describe("new-domain warm-up", () => {
  // One instant per test: the warm-up counts per UTC day, and a rollover
  // between seeding a counter and sending would read a fresh day.
  const NOW = new Date("2026-10-09T10:00:00Z");
  beforeAll(async () => {
    await db.insert(schema.instanceSettings).values({ id: 1, warmupEnabled: true });
  });
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A Free team sending from young domains, with an SMTP key. */
  async function warmTeam(slug: string, names: string[]) {
    const warm = await createTeam(db, slug);
    const domains = await db
      .insert(schema.domains)
      .values(
        names.map((name) => ({
          teamId: warm,
          name,
          region: "us-east-1",
          status: "verified" as const,
          verifiedAt: NOW,
          registeredAt: new Date(NOW.getTime() - 3600_000),
        })),
      )
      .returning({ id: schema.domains.id });
    const key = generateApiKey();
    await db.insert(schema.apiKeys).values({
      teamId: warm,
      name: "smtp",
      tokenPrefix: key.tokenPrefix,
      keyHash: key.keyHash,
      last4: key.last4,
    });
    const send = (from: string, to: string | string[] = "r@example.com") =>
      transport({ user: SMTP_USERNAME, pass: key.token }).sendMail({
        from,
        to,
        subject: "s",
        text: "t",
      });
    return { warm, domains, send };
  }

  it("parks a young domain's mail past its cap, then answers 452 naming the limit once the backlog is full", async () => {
    const { warm, domains, send: sendFrom } = await warmTeam("smtp-warm", ["fresh-smtp.com"]);
    const domain = domains[0];
    if (!domain) throw new Error("domain insert failed");
    await db
      .insert(schema.domainWarmupUsage)
      .values({ registrableDomain: "fresh-smtp.com", day: utcDay(NOW), accepted: 100 });
    const send = () => sendFrom("a@fresh-smtp.com");

    const info = await send();
    expect(await emailRow(info.response ?? "")).toMatchObject({
      latestStatus: "queued_quota",
      parkReason: "warmup",
    });
    // Free's backlog: three days of its 100 a day.
    await db.insert(schema.emails).values(
      Array.from({ length: 299 }, () => ({
        teamId: warm,
        domainId: domain.id,
        from: "a@fresh-smtp.com",
        to: ["r@example.com"],
        subject: "s",
        latestStatus: "queued_quota" as const,
        parkReason: "warmup" as const,
      })),
    );
    await expect(send()).rejects.toMatchObject({
      responseCode: 452,
      response:
        "452 New domain limit: fresh-smtp.com sends up to 100 emails a day for now, and 300 are already waiting. Retry after 00:00 UTC.",
    });
  });

  it("holds a team's second young domain once their shared day is spent", async () => {
    const { send } = await warmTeam("smtp-pool", ["pool-one-smtp.com", "pool-two-smtp.com"]);
    const fifty = (prefix: string) =>
      Array.from({ length: 50 }, (_, i) => `${prefix}${i}@example.com`);
    for (const prefix of ["a", "b"]) {
      const info = await send("a@pool-one-smtp.com", fifty(prefix));
      expect(await emailRow(info.response ?? "")).toMatchObject({ latestStatus: "queued" });
    }
    const info = await send("a@pool-two-smtp.com");
    expect(await emailRow(info.response ?? "")).toMatchObject({
      latestStatus: "queued_quota",
      parkReason: "warmup",
    });
  });
});
