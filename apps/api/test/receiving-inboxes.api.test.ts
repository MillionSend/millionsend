import { randomBytes } from "node:crypto";
import {
  acquireWaitSlot,
  type DeliverEnvelope,
  deriveInboxKeys,
  EnvKeyring,
  encodeEnvelopeHeader,
  generateApiKey,
  MX_DELIVER_PATH,
  MX_ENVELOPE_HEADER,
  MX_INGEST_PATH,
  WAITS_PER_TEAM_PER_PROCESS,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiDeps, createApi } from "../src/app.js";

/**
 * The receiving surface with inboxes: who sees held mail, MillionSend's
 * extension keys, the long-poll, erase, the virus block and codes/latest.
 */

const SECRET = "y".repeat(40);
const API_BASE = "https://api.example.test";
const DELIVER = `${MX_INGEST_PATH}${MX_DELIVER_PATH}`;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const ZWSP = "​";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let team: string;
let teamKey: string;
let sendKey: string;
let botKey: string;
let bot: string;
let vip: string;

function makeApp(overrides: Partial<ApiDeps> = {}) {
  return createApi({
    db,
    keyring,
    isCloud: false,
    enqueueEmailSend: async () => {},
    publicApiUrl: API_BASE,
    receivedDownloadKey: randomBytes(32),
    receiving: { mxHost: "mx.millionsend.test", ingestSecret: SECRET },
    inboxKeys: deriveInboxKeys(randomBytes(32)),
    ...overrides,
  });
}

let seq = 0;
function message(
  to: string,
  p: { subject?: string; text?: string; html?: string; attachment?: boolean } = {},
) {
  seq++;
  const boundary = `b${seq}`;
  return Buffer.from(
    [
      "From: Sender Person <sender@sender.example>",
      `To: ${to}`,
      `Subject: ${p.subject ?? `Subject ${seq}`}`,
      `Message-ID: <api-${seq}@sender.example>`,
      "Date: Mon, 12 Oct 2026 12:00:00 +0000",
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: multipart/alternative; boundary="alt"',
      "",
      "--alt",
      "Content-Type: text/plain; charset=utf-8",
      "",
      p.text ?? `Plain ${seq}`,
      "--alt",
      "Content-Type: text/html; charset=utf-8",
      "",
      p.html ?? `<p>${p.text ?? `Plain ${seq}`}</p>`,
      "--alt--",
      ...(p.attachment
        ? [
            `--${boundary}`,
            'Content-Type: application/pdf; name="a.pdf"',
            'Content-Disposition: attachment; filename="a.pdf"',
            "",
            "%PDF-1.4",
          ]
        : []),
      `--${boundary}--`,
      "",
    ].join("\r\n"),
  );
}

async function deliver(raw: Buffer, recipients: string[], via = app) {
  const envelope: DeliverEnvelope = {
    mailFrom: "sender@sender.example",
    recipients,
    clientIp: "192.0.2.25",
    helo: "mail.sender.example",
    tls: null,
    auth: { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" },
    receivedAt: new Date().toISOString(),
  };
  const res = await via.request(DELIVER, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/octet-stream",
      [MX_ENVELOPE_HEADER]: encodeEnvelopeHeader(envelope),
    },
    body: new Uint8Array(raw),
  });
  expect(res.status).toBe(200);
  const [row] = await db
    .select({ id: schema.receivedEmails.id })
    .from(schema.receivedEmails)
    .where(eq(schema.receivedEmails.messageId, `<api-${seq}@sender.example>`));
  return row?.id as string;
}

const get = (token: string, path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
type List = { data: Record<string, unknown>[]; has_more: boolean; held?: unknown[] };

async function addKey(values: Partial<typeof schema.apiKeys.$inferInsert> = {}) {
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId: team,
    name: "k",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
    ...values,
  });
  return key.token;
}

async function addInbox(emailAddress: string, domainId: string, safety: Record<string, unknown>) {
  const [row] = await db
    .insert(schema.inboxes)
    .values({
      teamId: team,
      kind: "agent",
      emailAddress,
      localPart: emailAddress.split("@")[0] as string,
      domainId,
      name: emailAddress,
      safety: {
        accept_from: "anyone",
        allowlist: [],
        owner_addresses: [],
        screening: true,
        extract_codes: true,
        send_policy: "reply_only",
        require_approval: false,
        private_codes: true,
        send_cap: 200,
        forward_to: [],
        ...safety,
      },
    })
    .returning({ id: schema.inboxes.id });
  return row?.id as string;
}

let delivered: string;
let held: string;
let catchAll: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  team = await createTeam(db, "recv-inboxes");
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId: team,
      name: "in.acme.test",
      region: "us-east-1",
      status: "verified",
      receivingEnabled: true,
      receivingCatchAll: true,
    })
    .returning({ id: schema.domains.id });
  const domainId = domain?.id as string;
  bot = await addInbox("bot@in.acme.test", domainId, {});
  vip = await addInbox("vip@in.acme.test", domainId, { accept_from: "allowlist" });
  teamKey = await addKey();
  sendKey = await addKey({ permission: "sending_access" });
  botKey = await addKey({ inboxId: bot });
  app = makeApp();
  delivered = await deliver(
    message("bot@in.acme.test", {
      subject: "Your verification code",
      text: `Your verification${ZWSP} code is 482913`,
    }),
    ["bot@in.acme.test"],
  );
  held = await deliver(message("vip@in.acme.test", { subject: "Held" }), ["vip@in.acme.test"]);
  catchAll = await deliver(message("sales@in.acme.test", { subject: "Catch-all" }), [
    "sales@in.acme.test",
  ]);
});
afterAll(() => close());

describe("GET /emails/receiving with inboxes (S4)", () => {
  it("leaves held mail out of the default list, flags every item with its screening", async () => {
    const list = await json<List>(await get(teamKey, "/emails/receiving"));
    expect(list.data.map((d) => d.id).sort()).toEqual([delivered, catchAll].sort());
    const item = list.data.find((d) => d.id === delivered);
    expect(item).toMatchObject({
      inbox_id: bot,
      thread_id: expect.any(String),
      inboxes: [{ inbox_id: bot, thread_id: expect.any(String), verdict: "clean" }],
      screening: { verdict: "clean", sender_trust: "external" },
      spam_verdict: "pass",
      virus_verdict: null,
      extracted: { kinds: ["code"] },
    });
    // SECURITY: a list item never carries the code itself (S7).
    expect(JSON.stringify(list)).not.toContain("482913");
    expect(list.data.find((d) => d.id === catchAll)).toMatchObject({ inbox_id: null, inboxes: [] });
  });

  it("shows owners held mail on request: alongside, or alone", async () => {
    const all = await json<List>(await get(teamKey, "/emails/receiving?include_quarantined=true"));
    expect(all.data.find((d) => d.id === held)).toMatchObject({
      inbox_id: vip,
      screening: { verdict: "quarantined" },
    });
    const only = await json<List>(await get(teamKey, "/emails/receiving?quarantined=true"));
    expect(only.data.map((d) => d.id)).toEqual([held]);
  });

  it("confines an inbox key to its inbox's delivered mail, never held mail or another inbox (S3)", async () => {
    const list = await json<List>(await get(botKey, "/emails/receiving"));
    expect(list.data.map((d) => d.id)).toEqual([delivered]);
    expect(list.data[0]).not.toHaveProperty("inboxes");
    expect(list.data[0]).toMatchObject({ inbox_id: bot, read: false });
    const wantsHeld = await get(botKey, "/emails/receiving?include_quarantined=true");
    expect(wantsHeld.status).toBe(403);
    expect(await wantsHeld.json()).toMatchObject({
      name: "restricted_api_key",
      message: "include_quarantined needs a full access key",
    });
    expect((await get(botKey, `/emails/receiving?inbox_id=${vip}`)).status).toBe(403);
  });

  it("filters by inbox, recipient, sender domain, subject and read state", async () => {
    const ids = async (query: string) =>
      (await json<List>(await get(teamKey, `/emails/receiving?${query}`))).data.map((d) => d.id);
    expect(await ids(`inbox_id=${bot}`)).toEqual([delivered]);
    expect(await ids("to=SALES@in.acme.test")).toEqual([catchAll]);
    expect((await ids("from=sender.example")).length).toBe(2);
    expect(await ids("from=other.example")).toEqual([]);
    expect(await ids("subject_contains=VERIFICATION")).toEqual([delivered]);
    expect(await ids(`inbox_id=${bot}&unread=true`)).toEqual([delivered]);
    expect(await ids(`inbox_id=${bot}&unread=false`)).toEqual([]);
    expect((await get(teamKey, "/emails/receiving?unread=true")).status).toBe(422);
  });
});

describe("GET /emails/receiving/{id} with inboxes", () => {
  it("serves the extracted read and the code to whoever may read it, and records the read", async () => {
    const res = await get(botKey, `/emails/receiving/${delivered}`);
    expect(res.status).toBe(200);
    const email = await json(res);
    expect(email).toMatchObject({
      inbox_id: bot,
      screening: {
        verdict: "clean",
        sender_trust: "external",
        quarantine_reason: null,
        reasons: [],
        injection_score: null,
        phishing_score: null,
        hidden_text_removed: true,
      },
      spam_verdict: "pass",
      spam_score: 0,
      virus_verdict: null,
      virus_signature: null,
      extracted_text: "Your verification code is 482913",
      extracted: {
        kinds: ["code"],
        code: "482913",
        link: null,
        link_domain_matches_sender: null,
        ambiguous: false,
      },
    });
    // D23: text loses its invisible characters; html stays as sent.
    expect(email.text).toBe("Your verification code is 482913");
    expect(email.html).toContain(ZWSP);
    const reads = await db
      .select()
      .from(schema.inboxActivity)
      .where(
        and(eq(schema.inboxActivity.inboxId, bot), eq(schema.inboxActivity.action, "code.read")),
      );
    expect(reads).toHaveLength(1);
  });

  it("answers an agent 403 email_quarantined for held mail it reached, 404 for mail it did not", async () => {
    const owner = await get(teamKey, `/emails/receiving/${held}`);
    expect(owner.status).toBe(200);
    expect(await json(owner)).toMatchObject({
      screening: { verdict: "quarantined", quarantine_reason: "not_allowlisted" },
      extracted: { code: null },
    });
    expect((await get(botKey, `/emails/receiving/${held}`)).status).toBe(404);
    const vipKey = await addKey({ inboxId: vip });
    const quarantined = await get(vipKey, `/emails/receiving/${held}`);
    expect(quarantined.status).toBe(403);
    expect(await quarantined.json()).toEqual({
      statusCode: 403,
      name: "email_quarantined",
      message: "This email is quarantined; a person can release it in the dashboard",
    });
  });

  it("answers 404 while mail is being screened", async () => {
    const judged = await addInbox(
      "judged@in.acme.test",
      (await db.select().from(schema.domains))[0]?.id as string,
      {},
    );
    const id = await deliver(message("judged@in.acme.test"), ["judged@in.acme.test"]);
    await db
      .update(schema.receivedEmailInboxes)
      .set({ verdict: "pending", deliveredAt: null })
      .where(eq(schema.receivedEmailInboxes.receivedEmailId, id));
    const judgedKey = await addKey({ inboxId: judged });
    expect((await get(judgedKey, `/emails/receiving/${id}`)).status).toBe(404);
  });
});

describe("mail that carries malware (S18)", () => {
  it("is never served whole: no raw link, and every download answers 410", async () => {
    const virusApp = makeApp({
      scanVirus: async () => ({ verdict: "fail", signature: "Eicar-Test-Signature" }),
    });
    const id = await deliver(
      message("bot@in.acme.test", { attachment: true }),
      ["bot@in.acme.test"],
      virusApp,
    );
    const email = await json<{ raw: unknown; attachments: { id: string }[] }>(
      await virusApp.request(`/emails/receiving/${id}`, {
        headers: { authorization: `Bearer ${teamKey}` },
      }),
    );
    expect(email.raw).toBeNull();
    expect(email).toMatchObject({ virus_verdict: "fail", virus_signature: "Eicar-Test-Signature" });
    const [attachment] = (
      await json<{ data: { download_url: string }[] }>(
        await virusApp.request(`/emails/receiving/${id}/attachments`, {
          headers: { authorization: `Bearer ${teamKey}` },
        }),
      )
    ).data;
    const url = new URL(attachment?.download_url ?? "");
    const blocked = await virusApp.request(`${url.pathname}${url.search}`);
    expect(blocked.status).toBe(410);
    expect(await blocked.json()).toMatchObject({ name: "email_blocked" });
  });
});

describe("DELETE /emails/receiving/{id}", () => {
  it("erases with a team key only: sending and inbox keys are refused", async () => {
    const id = await deliver(message("erase@in.acme.test"), ["erase@in.acme.test"]);
    expect((await get(sendKey, `/emails/receiving/${id}`, { method: "DELETE" })).status).toBe(403);
    expect((await get(botKey, `/emails/receiving/${id}`, { method: "DELETE" })).status).toBe(403);
    const res = await get(teamKey, `/emails/receiving/${id}`, { method: "DELETE" });
    expect(await json(res)).toEqual({ object: "email", id, deleted: true });
    expect((await get(teamKey, `/emails/receiving/${id}`)).status).toBe(404);
    expect((await get(teamKey, `/emails/receiving/${id}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("long-poll (S28)", () => {
  it("returns mail that arrives while it waits, and an empty page at the deadline", async () => {
    const started = Date.now();
    // Without a cursor the wait also counts the last minute's mail: since names the start.
    const pending = get(botKey, `/emails/receiving?wait=10&since=${new Date().toISOString()}`);
    setTimeout(
      () => void deliver(message("bot@in.acme.test", { subject: "Late" }), ["bot@in.acme.test"]),
      300,
    );
    const list = await json<List>(await pending);
    expect(list.data.map((d) => d.subject)).toContain("Late");
    expect(Date.now() - started).toBeLessThan(5_000);

    const quiet = await json<List>(
      await get(botKey, `/emails/receiving?wait=1&since=${new Date().toISOString()}`),
    );
    expect(quiet).toEqual({ object: "list", has_more: false, data: [], held: [] });
  });

  it("ends the wait on a quarantined match, reporting its id only", async () => {
    const pending = get(
      teamKey,
      `/emails/receiving?wait=10&inbox_id=${vip}&since=${new Date().toISOString()}`,
    );
    setTimeout(
      () =>
        void deliver(message("vip@in.acme.test", { subject: "Held later" }), ["vip@in.acme.test"]),
      300,
    );
    const list = await json<List>(await pending);
    expect(list.data).toEqual([]);
    expect(list.held).toEqual([
      {
        id: expect.any(String),
        inbox_id: vip,
        reason: "quarantined",
        quarantine_reason: "not_allowlisted",
        created_at: expect.any(String),
      },
    ]);
  });

  it("never matches held mail on its subject for an agent, so it cannot probe what held mail says", async () => {
    const vipKey = await addKey({ inboxId: vip });
    const pending = get(
      vipKey,
      `/emails/receiving?wait=10&subject_contains=no-such-words&since=${new Date().toISOString()}`,
    );
    setTimeout(
      () =>
        void deliver(message("vip@in.acme.test", { subject: "Held probe" }), ["vip@in.acme.test"]),
      300,
    );
    const list = await json<List>(await pending);
    expect(list.data).toEqual([]);
    expect(list.held).toHaveLength(1);
  });

  it("allows a team twenty waits at once in a process; the next gets 429", async () => {
    const releases = Array.from({ length: WAITS_PER_TEAM_PER_PROCESS }, () =>
      acquireWaitSlot(team),
    );
    const res = await get(teamKey, "/emails/receiving?wait=5");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(await res.json()).toMatchObject({ name: "too_many_waits" });
    for (const release of releases) release?.();
  });
});

describe("GET /inboxes/{id}/codes/latest", () => {
  it("finds the latest delivered code for the inbox, or says none", async () => {
    const found = await json(await get(botKey, `/inboxes/${bot}/codes/latest`));
    expect(found).toMatchObject({
      object: "verification_code",
      status: "found",
      kind: "otp",
      code: "482913",
    });
    expect(await json(await get(teamKey, `/inboxes/${vip}/codes/latest`))).toMatchObject({
      status: "none",
    });
    const waited = await json(await get(teamKey, `/inboxes/${vip}/codes/latest?wait=1`));
    expect(waited).toMatchObject({ status: "timeout", code: null });
    // Another inbox's codes are out of an inbox key's reach.
    expect((await get(botKey, `/inboxes/${vip}/codes/latest`)).status).toBe(403);
    const otherTeam = await createTeam(db, "codes-other");
    const key = generateApiKey();
    await db.insert(schema.apiKeys).values({
      teamId: otherTeam,
      name: "k",
      tokenPrefix: key.tokenPrefix,
      keyHash: key.keyHash,
      last4: key.last4,
    });
    expect((await get(key.token, `/inboxes/${bot}/codes/latest`)).status).toBe(404);
  });
});
