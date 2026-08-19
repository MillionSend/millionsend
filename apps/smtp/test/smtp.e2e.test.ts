import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { decryptEmailBody, EnvKeyring, generateApiKey, hashRecipient } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSmtpServer, SMTP_USERNAME } from "../src/smtp.js";

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
  server = createSmtpServer({
    db,
    keyring,
    isCloud: true,
    allowInsecureAuth: true,
    enqueueEmailSend: async (emailId, opts) => {
      enqueued.push({ emailId, ...(opts?.startAfter ? { startAfter: opts.startAfter } : {}) });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.server.address() as AddressInfo).port;
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
