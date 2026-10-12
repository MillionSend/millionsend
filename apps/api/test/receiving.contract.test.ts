import { randomBytes } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import {
  EnvKeyring,
  encodeEnvelopeHeader,
  generateApiKey,
  MX_DELIVER_PATH,
  MX_ENVELOPE_HEADER,
  MX_INGEST_PATH,
  openAttachments,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SesIdentityClient } from "@millionsend/ses";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { createTransport } from "nodemailer";
import { Resend } from "resend";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

/**
 * Wire-compat gate for receiving: the official `resend` SDK against a live
 * MillionSend API. emails.receiving.forward() is the strictest client: it
 * downloads raw.download_url with a bare fetch (no API key), parses it with
 * postal-mime and posts the parts back to POST /emails.
 */

const SECRET = "c".repeat(32);
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PDF = Buffer.from("%PDF-1.4 contract pdf");

let db: Db;
let closeDb: () => Promise<void>;
let server: ServerType;
let base: string;
let resend: Resend;
let teamId: string;
let emailId: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));

const fakeSes: SesIdentityClient = {
  async send(command) {
    if (command.constructor.name === "GetEmailIdentityCommand") {
      return {
        VerifiedForSendingStatus: true,
        DkimAttributes: { Status: "SUCCESS" },
        MailFromAttributes: { MailFromDomainStatus: "SUCCESS" },
      };
    }
    return {};
  },
};

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  teamId = await createTeam(db, "receiving-contract");
  await db.insert(schema.domains).values([
    { teamId, name: "acme.dev", region: "us-east-1", status: "verified", verifiedAt: new Date() },
    {
      teamId,
      name: "inbound.acme.dev",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
      receivingEnabled: true,
      receivingCatchAll: true,
    },
  ]);
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "contract",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  // The download links must name the live server, so the app is built once its port is known.
  let app: ReturnType<typeof createApi> | undefined;
  await new Promise<void>((resolve) => {
    server = serve(
      { fetch: (req) => (app ? app.fetch(req) : new Response(null, { status: 503 })), port: 0 },
      () => resolve(),
    );
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
  app = createApi({
    db,
    keyring,
    isCloud: false,
    enqueueEmailSend: async () => {},
    publicApiUrl: base,
    receivedDownloadKey: randomBytes(32),
    receiving: { mxHost: "mx.millionsend.test", ingestSecret: SECRET },
    ses: {
      clientForRegion: () => fakeSes,
      dns: {
        resolveTxt: async () => [],
        resolveMx: async (name: string) =>
          name === "inbound.acme.dev" ? [{ priority: 10, exchange: "mx.millionsend.test" }] : [],
        resolveCname: async () => [],
      },
      regions: ["us-east-1"],
    },
  });
  resend = new Resend(key.token, { baseUrl: base });

  // What the MX hands over: an html part with an unnamed inline image, and a PDF.
  const transport = createTransport({ streamTransport: true, buffer: true });
  const info = await transport.sendMail({
    from: "Sender <sender@sender.example>",
    to: "support@inbound.acme.dev",
    subject: "Invoice question",
    text: "See the invoice.",
    html: '<p>See the invoice.</p><img src="cid:logo@sender">',
    attachments: [
      { content: PNG, contentType: "image/png", cid: "logo@sender", filename: false },
      { filename: "invoice.pdf", content: PDF, contentType: "application/pdf" },
    ],
  });
  const delivered = await fetch(`${base}${MX_INGEST_PATH}${MX_DELIVER_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/octet-stream",
      [MX_ENVELOPE_HEADER]: encodeEnvelopeHeader({
        mailFrom: "sender@sender.example",
        recipients: ["support@inbound.acme.dev"],
        clientIp: "192.0.2.1",
        helo: "sender.example",
        tls: null,
        auth: { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" },
        receivedAt: new Date().toISOString(),
      }),
    },
    body: new Uint8Array(info.message as Buffer),
  });
  expect(delivered.status).toBe(200);
});

afterAll(async () => {
  server.close();
  await closeDb();
});

const sentAttachments = async (id: string) => {
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
  return openAttachments(row?.attachments ?? "", keyring, { teamId, rowId: id });
};

describe("official resend SDK: receiving", () => {
  it("lists received emails", async () => {
    const listed = await resend.emails.receiving.list();
    expect(listed.error).toBeNull();
    expect(listed.data?.has_more).toBe(false);
    expect(listed.data?.data).toHaveLength(1);
    const [email] = listed.data?.data ?? [];
    expect(email).toMatchObject({
      from: "sender@sender.example",
      to: ["support@inbound.acme.dev"],
      received_for: ["support@inbound.acme.dev"],
      subject: "Invoice question",
    });
    emailId = email?.id ?? "";
  });

  it("gets one, in both html formats", async () => {
    const got = await resend.emails.receiving.get(emailId);
    expect(got.error).toBeNull();
    expect(got.data).toMatchObject({
      object: "email",
      id: emailId,
      text: "See the invoice.",
      raw: { download_url: expect.stringContaining(`${base}/receiving/raw/${emailId}?`) },
    });
    expect(got.data?.html).toContain("data:image/png;base64,");
    expect(got.data?.attachments.map((a) => a.filename)).toEqual([null, "invoice.pdf"]);
    const cid = await resend.emails.receiving.get(emailId, { html_format: "cid" });
    expect(cid.data?.html).toContain('src="cid:logo@sender"');
  });

  it("lists and gets attachments", async () => {
    const listed = await resend.emails.receiving.attachments.list({ emailId });
    expect(listed.error).toBeNull();
    const [logo, invoice] = listed.data?.data ?? [];
    expect(logo).toMatchObject({ content_disposition: "inline", content_id: "logo@sender" });
    expect(logo).not.toHaveProperty("filename");
    expect(invoice).toMatchObject({ filename: "invoice.pdf", size: PDF.length });
    const got = await resend.emails.receiving.attachments.get({ emailId, id: invoice?.id ?? "" });
    expect(got.error).toBeNull();
    expect(got.data).toMatchObject({ object: "attachment", filename: "invoice.pdf" });
    const bytes = await fetch(got.data?.download_url ?? "");
    expect(Buffer.from(await bytes.arrayBuffer()).equals(PDF)).toBe(true);
  });

  it("forwards as is: the unnamed inline image keeps its content id", async () => {
    const forwarded = await resend.emails.receiving.forward({
      emailId,
      from: "Acme Support <support@acme.dev>",
      to: "team@example.com",
    });
    expect(forwarded.error).toBeNull();
    const id = forwarded.data?.id ?? "";
    const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
    expect(row).toMatchObject({ subject: "Invoice question", to: ["team@example.com"] });
    expect(await sentAttachments(id)).toEqual([
      { content: PNG.toString("base64"), contentType: "image/png", contentId: "logo@sender" },
      { filename: "invoice.pdf", content: PDF.toString("base64"), contentType: "application/pdf" },
    ]);
  });

  it("forwards wrapped: the original travels as message/rfc822", async () => {
    const forwarded = await resend.emails.receiving.forward({
      emailId,
      from: "support@acme.dev",
      to: ["team@example.com"],
      passthrough: false,
      text: "FYI",
    });
    expect(forwarded.error).toBeNull();
    const [attachment] = await sentAttachments(forwarded.data?.id ?? "");
    expect(attachment).toMatchObject({
      filename: "forwarded_message.eml",
      contentType: "message/rfc822",
    });
    expect(Buffer.from(attachment?.content ?? "", "base64").toString("utf8")).toContain(
      "Subject: Invoice question",
    );
  });

  it("subscribes a webhook to email.received", async () => {
    const created = await resend.webhooks.create({
      endpoint: "https://acme.dev/hooks/inbound",
      events: ["email.received"],
    });
    expect(created.error).toBeNull();
  });

  it("switches receiving on through domains.update and reads it back", async () => {
    const [row] = await db
      .select({ id: schema.domains.id })
      .from(schema.domains)
      .where(eq(schema.domains.name, "acme.dev"));
    const id = row?.id ?? "";
    const updated = await resend.domains.update({ id, capabilities: { receiving: "enabled" } });
    expect(updated.error).toBeNull();
    const got = await resend.domains.get(id);
    expect(got.data?.capabilities).toEqual({ sending: "enabled", receiving: "enabled" });
    expect(got.data?.records).toContainEqual(
      expect.objectContaining({ record: "Receiving", type: "MX", value: "mx.millionsend.test" }),
    );
  });
});
