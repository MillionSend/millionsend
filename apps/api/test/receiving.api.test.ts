import { randomBytes } from "node:crypto";
import {
  type DeliverEnvelope,
  deriveInboxKeys,
  EnvKeyring,
  encodeEnvelopeHeader,
  generateApiKey,
  MAX_RECEIVED_MESSAGE_BYTES,
  MX_DELIVER_PATH,
  MX_ENVELOPE_HEADER,
  MX_INGEST_PATH,
  MX_RCPT_PATH,
  signReceivedDownload,
  utcDay,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb, createWebhookEndpoint } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { createTransport } from "nodemailer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ApiDeps, createApi } from "../src/app.js";

/**
 * Receiving end to end inside the API: the MX's internal endpoints, the
 * Resend-shaped reads and the signed downloads, over one real database.
 */

const SECRET = "x".repeat(40);
const API_BASE = "https://api.example.test";
const RCPT = `${MX_INGEST_PATH}${MX_RCPT_PATH}`;
const DELIVER = `${MX_INGEST_PATH}${MX_DELIVER_PATH}`;

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let acme: string;
let beta: string;
let acmeKey: string;
let acmeSendKey: string;
let acmeScopedKey: string;
let betaKey: string;
let hook: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const downloadKey = randomBytes(32);
const inboxKeys = deriveInboxKeys(randomBytes(32));
const enqueuedHooks: string[] = [];
const transport = createTransport({ streamTransport: true, buffer: true });

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PDF = Buffer.from("%PDF-1.4 received pdf bytes");

function makeApp(overrides: Partial<ApiDeps> = {}) {
  return createApi({
    db,
    keyring,
    isCloud: true,
    enqueueEmailSend: async () => {},
    enqueueWebhookDeliveries: async (rows) => {
      enqueuedHooks.push(...rows.map((r) => r.endpointId));
    },
    publicApiUrl: API_BASE,
    receivedDownloadKey: downloadKey,
    receiving: { mxHost: "mx.millionsend.test", ingestSecret: SECRET },
    inboxKeys,
    ...overrides,
  });
}

async function message(to: string, subject: string): Promise<Buffer> {
  const info = await transport.sendMail({
    from: "Sender Person <sender@sender.example>",
    to,
    subject,
    text: `Plain ${subject}`,
    html: `<p>${subject}</p><img src="cid:logo@sender">`,
    attachments: [
      { filename: "logo.png", content: PNG, contentType: "image/png", cid: "logo@sender" },
      { filename: "report.pdf", content: PDF, contentType: "application/pdf" },
    ],
  });
  return info.message as Buffer;
}

const envelope = (recipients: string[]): DeliverEnvelope => ({
  mailFrom: "bounces@sender.example",
  recipients,
  clientIp: "192.0.2.25",
  helo: "mail.sender.example",
  tls: { protocol: "TLSv1.3", cipher: "TLS_AES_128_GCM_SHA256" },
  auth: { spf: "pass", dkim: "pass", dmarc: "fail", arc: "none" },
  receivedAt: new Date().toISOString(),
});

async function deliver(
  raw: Buffer,
  recipients: string[],
  headers: Record<string, string> = {},
  via = app,
): Promise<Response> {
  return via.request(DELIVER, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/octet-stream",
      [MX_ENVELOPE_HEADER]: encodeEnvelopeHeader(envelope(recipients)),
      ...headers,
    },
    body: new Uint8Array(raw),
  });
}

function rcpt(recipient: string, authorization = `Bearer ${SECRET}`, via = app) {
  return via.request(RCPT, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({
      recipient,
      mailFrom: "bounces@sender.example",
      clientIp: "192.0.2.25",
      helo: "mail.sender.example",
    }),
  });
}

const get = (token: string, path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers: { authorization: `Bearer ${token}`, ...headers } });

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

/** A signed URL as the API returned it, as a path this test app can request. */
const local = (url: string) => {
  const u = new URL(url);
  expect(u.origin).toBe(API_BASE);
  return `${u.pathname}${u.search}`;
};

async function addDomain(teamId: string, name: string) {
  const [row] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name,
      region: "us-east-1",
      status: "verified",
      receivingEnabled: true,
      receivingCatchAll: true,
    })
    .returning({ id: schema.domains.id });
  if (!row) throw new Error("domain insert failed");
  return row.id;
}

async function addKey(teamId: string, values: Partial<typeof schema.apiKeys.$inferInsert> = {}) {
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "k",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
    ...values,
  });
  return key.token;
}

const rowsOf = (teamId: string) =>
  db.select().from(schema.receivedEmails).where(eq(schema.receivedEmails.teamId, teamId));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  acme = await createTeam(db, "recv-acme");
  beta = await createTeam(db, "recv-beta");
  await addDomain(acme, "inbound.acme.test");
  const second = await addDomain(acme, "second.acme.test");
  await addDomain(beta, "mail.beta.test");
  acmeKey = await addKey(acme);
  acmeSendKey = await addKey(acme, { permission: "sending_access" });
  acmeScopedKey = await addKey(acme, { domainId: second });
  betaKey = await addKey(beta);
  hook = await createWebhookEndpoint(db, acme, null);
  app = makeApp();
});
afterAll(() => close());

describe("internal MX endpoints", () => {
  it("do not exist on an instance that does not receive mail", async () => {
    const off = makeApp({ receiving: undefined });
    expect((await rcpt("a@inbound.acme.test", `Bearer ${SECRET}`, off)).status).toBe(404);
    const res = await deliver(
      await message("a@inbound.acme.test", "off"),
      ["a@inbound.acme.test"],
      {},
      off,
    );
    expect(res.status).toBe(404);
  });

  it("401 anything without the MX's secret", async () => {
    expect((await rcpt("a@inbound.acme.test", "")).status).toBe(401);
    expect((await rcpt("a@inbound.acme.test", `Bearer ${SECRET}x`)).status).toBe(401);
    const raw = await message("a@inbound.acme.test", "no secret");
    expect(
      (await deliver(raw, ["a@inbound.acme.test"], { authorization: "Bearer nope" })).status,
    ).toBe(401);
    expect(await rowsOf(acme)).toHaveLength(0);
  });

  it("answers RCPT for receiving domains, unknown domains and malformed requests", async () => {
    expect(await json(await rcpt("anyone@inbound.acme.test"))).toEqual({
      accept: true,
      ttlSeconds: 30,
    });
    expect(await json(await rcpt("x@nowhere.test"))).toMatchObject({
      accept: false,
      code: 550,
      enhanced: "5.1.1",
    });
    const bad = await app.request(RCPT, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ recipient: "x@inbound.acme.test" }),
    });
    expect(bad.status).toBe(400);
  });

  it("stores a delivery per team, once, and announces it with email.received", async () => {
    const raw = await message("agent@inbound.acme.test", "First");
    const first = await deliver(raw, ["agent@inbound.acme.test", "bcc@mail.beta.test"]);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    // The MX retrying after a lost 200 stores nothing new.
    expect((await deliver(raw, ["agent@inbound.acme.test"])).status).toBe(200);

    const [acmeRow] = await rowsOf(acme);
    const [betaRow] = await rowsOf(beta);
    expect((await rowsOf(acme)).length).toBe(1);
    expect(acmeRow?.receivedFor).toEqual(["agent@inbound.acme.test"]);
    expect(betaRow?.receivedFor).toEqual(["bcc@mail.beta.test"]);
    expect(enqueuedHooks).toContain(hook);
    const deliveries = await db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.endpointId, hook));
    expect(deliveries.map((d) => d.eventType)).toEqual(["email.received"]);
  });

  it("routes the shared domain's role mail to the System team, at RCPT and at delivery", async () => {
    const shared = makeApp({ sharedInboxDomain: "agents.example" });
    const system = await createTeam(db, "recv-system");
    await db.update(schema.teams).set({ plan: "system" }).where(eq(schema.teams.id, system));
    const answer = await rcpt("postmaster@agents.example", `Bearer ${SECRET}`, shared);
    expect(await json(answer)).toEqual({ accept: true, ttlSeconds: 0 });
    const raw = await message("abuse@agents.example", "Report");
    expect((await deliver(raw, ["abuse@agents.example"], {}, shared)).status).toBe(200);
    expect((await rowsOf(system)).map((r) => r.receivedFor)).toEqual([["abuse@agents.example"]]);
  });

  it("relays the app's refusals: 422 permanent, 429 temporary, 400 for a bad envelope", async () => {
    const raw = await message("x@nowhere.test", "Nobody");
    const nobody = await deliver(raw, ["x@nowhere.test"]);
    expect(nobody.status).toBe(422);
    expect(await nobody.json()).toEqual({
      code: 554,
      enhanced: "5.1.1",
      message: "No recipient address on this message receives mail here",
    });

    const missing = await app.request(DELIVER, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
      body: new Uint8Array(raw),
    });
    expect(missing.status).toBe(400);

    // A free team past its daily cap: the sender keeps the message and retries.
    const full = await createTeam(db, "recv-full");
    await addDomain(full, "full.test");
    await db.insert(schema.usageCounters).values({ teamId: full, day: utcDay(), accepted: 10_000 });
    expect(await json(await rcpt("a@full.test"))).toMatchObject({ code: 452, enhanced: "4.2.2" });
    const quota = await deliver(await message("a@full.test", "Full"), ["a@full.test"]);
    expect(quota.status).toBe(429);
    expect(await quota.json()).toMatchObject({ code: 452, enhanced: "4.2.2" });
    expect(await rowsOf(full)).toHaveLength(0);
  });

  it("refuses a body over the message limit for good, without reading it", async () => {
    const res = await app.request(DELIVER, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        [MX_ENVELOPE_HEADER]: encodeEnvelopeHeader(envelope(["a@inbound.acme.test"])),
        "content-length": String(MAX_RECEIVED_MESSAGE_BYTES + 1),
      },
      body: "x",
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      code: 552,
      enhanced: "5.3.4",
      message: "Message exceeds the maximum size",
    });
  });
});

describe("received mail reads", () => {
  let id: string;
  let scopedId: string;

  beforeAll(async () => {
    await deliver(await message("agent@inbound.acme.test", "Second"), ["agent@inbound.acme.test"]);
    await deliver(await message("ops@second.acme.test", "Scoped"), ["ops@second.acme.test"]);
    const rows = await rowsOf(acme);
    id = rows.find((r) => r.subject === "Second")?.id ?? "";
    scopedId = rows.find((r) => r.subject === "Scoped")?.id ?? "";
  });

  it("lists the team's mail newest first, Resend's shape, paged by cursor", async () => {
    const res = await get(acmeKey, "/emails/receiving");
    expect(res.status).toBe(200);
    const body = await json<{ object: string; has_more: boolean; data: Record<string, unknown>[] }>(
      res,
    );
    expect(body.object).toBe("list");
    expect(body.data.map((e) => e.subject)).toEqual(["Scoped", "Second", "First"]);
    expect(body.data[1]).toMatchObject({
      id,
      from: "sender@sender.example",
      to: ["agent@inbound.acme.test"],
      received_for: ["agent@inbound.acme.test"],
      cc: [],
      bcc: [],
      reply_to: [],
      attachments: [
        {
          filename: "logo.png",
          content_type: "image/png",
          content_disposition: "inline",
          content_id: "logo@sender",
          size: PNG.length,
        },
        {
          filename: "report.pdf",
          content_type: "application/pdf",
          content_disposition: "attachment",
          content_id: null,
          size: PDF.length,
        },
      ],
    });
    const page = await json<{ has_more: boolean; data: { id: string }[] }>(
      await get(acmeKey, "/emails/receiving?limit=1"),
    );
    expect(page.has_more).toBe(true);
    // `after` pages toward older mail, `before` back toward newer, as on Resend.
    const next = await json<{ has_more: boolean; data: { id: string; subject: string }[] }>(
      await get(acmeKey, `/emails/receiving?limit=1&after=${page.data[0]?.id}`),
    );
    expect(next).toMatchObject({ has_more: true, data: [{ subject: "Second" }] });
    const oldest = body.data[2]?.id;
    const back = await json<{ has_more: boolean; data: { subject: string }[] }>(
      await get(acmeKey, `/emails/receiving?limit=1&before=${oldest}`),
    );
    expect(back).toMatchObject({ has_more: true, data: [{ subject: "Second" }] });
    const newer = await json<{ has_more: boolean; data: { subject: string }[] }>(
      await get(acmeKey, `/emails/receiving?before=${oldest}`),
    );
    expect(newer).toMatchObject({
      has_more: false,
      data: [{ subject: "Scoped" }, { subject: "Second" }],
    });
    const foreignCursor = (await rowsOf(beta))[0]?.id;
    expect((await get(acmeKey, `/emails/receiving?after=${foreignCursor}`)).status).toBe(422);
  });

  it("keeps each team, key and domain scope to its own mail", async () => {
    expect((await get(acmeSendKey, "/emails/receiving")).status).toBe(403);
    expect((await get(acmeSendKey, `/emails/receiving/${id}`)).status).toBe(403);
    expect((await get(betaKey, `/emails/receiving/${id}`)).status).toBe(404);
    expect((await get(betaKey, `/emails/receiving/${id}/attachments`)).status).toBe(404);
    const beta = await json<{ data: { subject: string; received_for: string[] }[] }>(
      await get(betaKey, "/emails/receiving"),
    );
    expect(beta.data).toEqual([expect.objectContaining({ received_for: ["bcc@mail.beta.test"] })]);
    const scoped = await json<{ data: { id: string }[] }>(
      await get(acmeScopedKey, "/emails/receiving"),
    );
    expect(scoped.data.map((e) => e.id)).toEqual([scopedId]);
    expect((await get(acmeScopedKey, `/emails/receiving/${id}`)).status).toBe(404);
  });

  it("returns one email with html, text, headers, authentication and a signed raw link", async () => {
    const res = await get(acmeKey, `/emails/receiving/${id}`);
    expect(res.status).toBe(200);
    const email = await json<{
      html: string;
      raw: { download_url: string; expires_at: string };
      headers: Record<string, string>;
    }>(res);
    expect(email).toMatchObject({
      object: "email",
      id,
      subject: "Second",
      html_format: "data_uri",
      text: "Plain Second",
      authentication: { spf: "pass", dkim: "pass", dmarc: "fail" },
      message_id: expect.stringMatching(/^<.+>$/),
    });
    expect(email.html).toContain(`src="data:image/png;base64,${PNG.toString("base64")}"`);
    expect(email.headers.from).toBe("Sender Person <sender@sender.example>");
    expect(email.raw.download_url).toMatch(
      new RegExp(`^${API_BASE}/receiving/raw/${id}\\?expires=\\d+&signature=`),
    );
    expect(Date.parse(email.raw.expires_at) - Date.now()).toBeGreaterThan(55 * 60_000);

    const cid = await json<{ html: string; html_format: string }>(
      await get(acmeKey, `/emails/receiving/${id}?html_format=cid`),
    );
    expect(cid).toMatchObject({ html_format: "cid" });
    expect(cid.html).toContain(`src="cid:logo@sender"`);
    expect((await get(acmeKey, `/emails/receiving/${id}?html_format=png`)).status).toBe(422);
    expect((await get(acmeKey, "/emails/receiving/not-a-uuid")).status).toBe(422);
  });

  it("lists and gets attachments with signed download links", async () => {
    const list = await json<{ has_more: boolean; data: { id: string; download_url: string }[] }>(
      await get(acmeKey, `/emails/receiving/${id}/attachments`),
    );
    expect(list).toMatchObject({ object: "list", has_more: false });
    expect(list.data).toEqual([
      expect.objectContaining({
        filename: "logo.png",
        content_type: "image/png",
        content_disposition: "inline",
        content_id: "logo@sender",
        size: PNG.length,
      }),
      expect.objectContaining({
        filename: "report.pdf",
        content_disposition: "attachment",
        size: PDF.length,
      }),
    ]);
    expect(list.data[1]).not.toHaveProperty("content_id");
    const [logo, report] = list.data;
    const first = await json<{ data: { id: string }[]; has_more: boolean }>(
      await get(acmeKey, `/emails/receiving/${id}/attachments?limit=1`),
    );
    expect(first).toMatchObject({ has_more: true, data: [{ id: logo?.id }] });
    const back = await json<{ data: { id: string }[]; has_more: boolean }>(
      await get(acmeKey, `/emails/receiving/${id}/attachments?before=${report?.id}`),
    );
    expect(back).toMatchObject({ has_more: false, data: [{ id: logo?.id }] });

    const one = await get(acmeKey, `/emails/receiving/${id}/attachments/${report?.id}`);
    expect(await json(one)).toMatchObject({
      object: "attachment",
      id: report?.id,
      filename: "report.pdf",
      download_url: expect.stringContaining(`/receiving/attachments/${id}/${report?.id}?expires=`),
    });
    const unknown = await get(acmeKey, `/emails/receiving/${id}/attachments/${scopedId}`);
    expect(unknown.status).toBe(404);
  });

  it("lists every attachment when no limit is given, as Resend does", async () => {
    const info = await transport.sendMail({
      from: "sender@sender.example",
      to: "agent@inbound.acme.test",
      subject: "Many files",
      text: "25 files",
      attachments: Array.from({ length: 25 }, (_, i) => ({
        filename: `f${i}.txt`,
        content: `${i}`,
      })),
    });
    await deliver(info.message as Buffer, ["agent@inbound.acme.test"]);
    const many = (await rowsOf(acme)).find((r) => r.subject === "Many files")?.id;
    const all = await json<{ has_more: boolean; data: unknown[] }>(
      await get(acmeKey, `/emails/receiving/${many}/attachments`),
    );
    expect(all).toMatchObject({ has_more: false });
    expect(all.data).toHaveLength(25);
    const paged = await json<{ has_more: boolean; data: unknown[] }>(
      await get(acmeKey, `/emails/receiving/${many}/attachments?limit=20`),
    );
    expect(paged.has_more).toBe(true);
    expect(paged.data).toHaveLength(20);
  });

  it("serves downloads to the signed link alone, as attachments a browser will not render", async () => {
    const email = await json<{ raw: { download_url: string } }>(
      await get(acmeKey, `/emails/receiving/${id}`),
    );
    const [stored] = (await rowsOf(acme)).filter((r) => r.id === id);
    const raw = await app.request(local(email.raw.download_url));
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("message/rfc822");
    expect(raw.headers.get("content-disposition")).toBe(
      `attachment; filename="${id}.eml"; filename*=UTF-8''${id}.eml`,
    );
    expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
    expect(raw.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(raw.headers.get("cache-control")).toBe("private, no-store");
    const bytes = Buffer.from(await raw.arrayBuffer());
    expect(bytes.length).toBe(stored?.sizeBytes);
    expect(bytes.toString("utf8")).toContain("Subject: Second");

    const list = await json<{ data: { filename: string; download_url: string }[] }>(
      await get(acmeKey, `/emails/receiving/${id}/attachments`),
    );
    const pdf = list.data.find((a) => a.filename === "report.pdf");
    const file = await app.request(local(pdf?.download_url ?? ""));
    expect(file.status).toBe(200);
    // The sender's declared type never reaches the browser.
    expect(file.headers.get("content-type")).toBe("application/octet-stream");
    expect(file.headers.get("content-disposition")).toContain('filename="report.pdf"');
    expect(Buffer.from(await file.arrayBuffer()).equals(PDF)).toBe(true);
  });

  it("holds a content slot until its download has been read, not just answered", async () => {
    const email = await json<{ raw: { download_url: string } }>(
      await get(acmeKey, `/emails/receiving/${id}`),
    );
    const url = local(email.raw.download_url);
    // Four answered downloads nobody has read yet take every slot.
    const unread = await Promise.all([1, 2, 3, 4].map(() => app.request(url)));
    let answered = false;
    const fifth = Promise.resolve(app.request(url)).then((res) => {
      answered = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(answered).toBe(false);
    await unread[0]?.body?.cancel();
    const res = await fifth;
    expect(res.status).toBe(200);
    await Promise.all([...unread.slice(1), res].map((r) => r.arrayBuffer()));
  });

  it("refuses tampered, expired, misdirected and malformed links alike", async () => {
    const email = await json<{ raw: { download_url: string } }>(
      await get(acmeKey, `/emails/receiving/${id}`),
    );
    const url = new URL(email.raw.download_url);
    const signature = url.searchParams.get("signature") ?? "";
    const tampered = `${url.pathname}?expires=${url.searchParams.get("expires")}&signature=${signature.slice(0, -2)}AA`;
    const otherEmail = `/receiving/raw/${scopedId}${url.search}`;
    const expired = signReceivedDownload({
      key: downloadKey,
      baseUrl: API_BASE,
      now: new Date(Date.now() - 2 * 3_600_000),
      teamId: acme,
      emailId: id,
    });
    const wrongTeam = signReceivedDownload({
      key: downloadKey,
      baseUrl: API_BASE,
      teamId: beta,
      emailId: id,
    });
    const wrongKey = signReceivedDownload({
      key: randomBytes(32),
      baseUrl: API_BASE,
      teamId: acme,
      emailId: id,
    });
    for (const path of [
      tampered,
      otherEmail,
      local(expired.url),
      local(wrongTeam.url),
      local(wrongKey.url),
      `/receiving/raw/${id}`,
      `/receiving/raw/..%2F..%2Fetc${url.search}`,
      `/receiving/attachments/${id}/not-a-uuid${url.search}`,
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(403);
      expect(await res.json()).toMatchObject({ name: "invalid_download_link" });
    }
  });

  it("throttles a client that keeps presenting bad links", async () => {
    let last = 0;
    for (let i = 0; i < 25; i++) {
      last = (
        await app.request(`/receiving/raw/${id}?expires=1&signature=x`, {
          headers: { "cf-connecting-ip": "198.51.100.77" },
        })
      ).status;
    }
    expect(last).toBe(429);
  });

  it("logs a read without the message's headers or its signed links", async () => {
    await db.delete(schema.apiRequests);
    expect((await get(acmeKey, `/emails/receiving/${id}`)).status).toBe(200);
    const [row] = await vi.waitFor(async () => {
      const rows = await db.select().from(schema.apiRequests);
      expect(rows).toHaveLength(1);
      return rows;
    });
    const logged = JSON.stringify(row?.responseBody);
    expect(logged).toContain('"headers":"[headers,');
    expect(logged).toContain('"download_url":"[redacted]"');
    expect(logged).not.toContain("signature=");
    expect(logged).not.toContain("Plain Second");
  });

  it("reads purged content as gone: no raw link, no attachments, downloads 404", async () => {
    const before = await json<{ raw: { download_url: string } }>(
      await get(acmeKey, `/emails/receiving/${scopedId}`),
    );
    const attachments = await json<{ data: { download_url: string }[] }>(
      await get(acmeKey, `/emails/receiving/${scopedId}/attachments`),
    );
    await db
      .update(schema.receivedEmails)
      .set({
        rawCiphertext: null,
        rawIv: null,
        rawWrappedDek: null,
        rawKeyVersion: null,
        attachments: null,
        contentPurgedAt: new Date(),
      })
      .where(eq(schema.receivedEmails.id, scopedId));
    const after = await json(await get(acmeKey, `/emails/receiving/${scopedId}`));
    expect(after).toMatchObject({
      html: null,
      text: null,
      headers: null,
      raw: null,
      attachments: [],
    });
    expect((await app.request(local(before.raw.download_url))).status).toBe(404);
    expect((await app.request(local(attachments.data[0]?.download_url ?? ""))).status).toBe(404);
  });

  it("documents the reads but neither the downloads nor the MX's endpoints", async () => {
    const doc = await json<{ paths: Record<string, unknown> }>(await app.request("/openapi.json"));
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        "/emails/receiving",
        "/emails/receiving/{id}",
        "/emails/receiving/{email_id}/attachments",
        "/emails/receiving/{email_id}/attachments/{id}",
      ]),
    );
    expect(
      Object.keys(doc.paths).filter((p) => p.startsWith("/receiving") || p.startsWith("/internal")),
    ).toEqual([]);
  });
});
