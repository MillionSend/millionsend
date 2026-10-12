import { createHash, randomUUID } from "node:crypto";
import { generateApiKey, SHARED_REPLY_ONLY_MESSAGE, utcDay } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addInbox,
  addThread,
  type InboxRow,
  mime,
  receive,
  seedWorld,
  type World,
} from "../../../packages/core/test/inbox-send-fixtures.js";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let w: World;
let app: ReturnType<typeof createApi>;
let teamKey: string;
let sendKey: string;
let inbox: InboxRow;
let inboxKey: string;
let otherDomainKey: string;

async function addKey(values: Partial<typeof schema.apiKeys.$inferInsert> = {}) {
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId: w.teamId,
    name: "k",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
    ...values,
  });
  return key.token;
}

const call = (token: string, method: string, path: string, body?: unknown, headers = {}) =>
  app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  w = await seedWorld(db, "api");
  app = createApi({
    ...w.deps,
    receiving: { mxHost: "mx.example.test", ingestSecret: "s".repeat(40) },
    sharedInboxDomain: w.sharedDomain,
  });
  teamKey = await addKey();
  sendKey = await addKey({ permission: "sending_access" });
  inbox = await addInbox(w, { local: "help", fromName: "Help Desk" });
  inboxKey = await addKey({ inboxId: inbox.id });
  const [other] = await db
    .insert(schema.domains)
    .values({ teamId: w.teamId, name: "other.acme.test", region: "us-east-1", status: "verified" })
    .returning({ id: schema.domains.id });
  otherDomainKey = await addKey({ domainId: other?.id ?? null });
});
afterAll(() => close());

const threadPath = (t: { threadId: string; id: string }, action: string, of = inbox) =>
  `/inboxes/${of.id}/threads/${t.threadId}/emails/${t.id}/${action}`;

async function thread(of = inbox) {
  const threadId = await addThread(w, of.id);
  return { threadId, ...(await receive(w, { inbox: of, threadId })) };
}

describe("thread email reply and forward", () => {
  it("answers 200 with the SentEmail, 202 with the Draft a held reply became", async () => {
    const t = await thread();
    const res = await call(teamKey, "POST", threadPath(t, "reply"), { text: "Thanks" });
    expect(res.status).toBe(200);
    const email = await json(res);
    expect(email).toMatchObject({
      direction: "outbound",
      from: "Help Desk <help@api.acme.test>",
      to: ["ada@sender.example"],
      message_id: null,
      reply_to: [],
      thread_id: t.threadId,
      inbox_id: inbox.id,
    });
    expect(email.email_id).toBe(email.id);
    const held = await call(teamKey, "POST", threadPath(t, "reply"), {
      text: "Check with a person",
      requires_approval: true,
    });
    expect(held.status).toBe(202);
    expect(await json(held)).toMatchObject({
      object: "inbox_draft",
      status: "pending_approval",
      approval_reasons: ["approval_required"],
    });
  });

  it("replays an Idempotency-Key and refuses another body under it", async () => {
    const t = await thread();
    const headers = { "idempotency-key": "reply-1" };
    const first = await json(
      await call(teamKey, "POST", threadPath(t, "reply"), { text: "a" }, headers),
    );
    const again = await call(teamKey, "POST", threadPath(t, "reply"), { text: "a" }, headers);
    expect(again.status).toBe(200);
    expect((await json(again)).id).toBe(first.id);
    const other = await call(teamKey, "POST", threadPath(t, "reply"), { text: "b" }, headers);
    expect(other.status).toBe(409);
    expect((await json(other)).name).toBe("invalid_idempotent_request");
  });

  it("forwards inline (200) and validates the body (422)", async () => {
    const t = await thread();
    const res = await call(teamKey, "POST", threadPath(t, "forward"), { to: w.owner, text: "FYI" });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ subject: "Fwd: Question", to: [w.owner] });
    expect((await call(teamKey, "POST", threadPath(t, "forward"), { text: "no to" })).status).toBe(
      422,
    );
    expect((await call(teamKey, "POST", threadPath(t, "reply"), {})).status).toBe(422);
    expect(
      (
        await call(
          teamKey,
          "POST",
          `/inboxes/not-a-uuid/threads/${t.threadId}/emails/${t.id}/reply`,
          {
            text: "x",
          },
        )
      ).status,
    ).toBe(422);
  });

  it("answers 429 with retry-after when the inbox's daily cap is spent", async () => {
    const capped = await addInbox(w, { local: "capped", safety: { send_cap: 1 } });
    await db
      .insert(schema.inboxUsageDaily)
      .values({ inboxId: capped.id, day: utcDay(), recipients: 1 });
    const t = await thread(capped);
    const res = await call(teamKey, "POST", threadPath(t, "reply", capped), { text: "x" });
    expect(res.status).toBe(429);
    expect((await json(res)).name).toBe("inbox_send_cap_reached");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("holds a domain-scoped key to the inboxes of its domain", async () => {
    const t = await thread();
    const res = await call(otherDomainKey, "POST", threadPath(t, "reply"), { text: "x" });
    expect(res.status).toBe(403);
    expect((await json(res)).name).toBe("restricted_api_key");
    expect((await call(otherDomainKey, "GET", `/inboxes/${inbox.id}/drafts`)).status).toBe(403);
    expect(
      (await call(otherDomainKey, "POST", `/emails/receiving/${t.id}/reply`, { text: "x" })).status,
    ).toBe(404);
  });
});

describe("drafts and rejection", () => {
  it("runs the Resend draft lifecycle, with the approval an agent cannot give", async () => {
    const base = `/inboxes/${inbox.id}/drafts`;
    const created = await call(inboxKey, "POST", base, {
      to: "new@example.org",
      subject: "Hi",
      text: "Hello",
    });
    expect(created.status).toBe(201);
    const draft = await json<{ id: string }>(created);
    const list = await json<{ object: string; has_more: boolean; data: { id: string }[] }>(
      await call(inboxKey, "GET", base),
    );
    expect(list).toMatchObject({ object: "list", has_more: false });
    expect(list.data.map((d) => d.id)).toContain(draft.id);
    const badCursor = await call(inboxKey, "GET", `${base}?after=${randomUUID()}`);
    expect(badCursor.status).toBe(404);
    expect((await json(badCursor)).message).toMatch(/^The pagination cursor references an object/);

    const patched = await call(inboxKey, "PATCH", `${base}/${draft.id}`, { text: "Hello there" });
    expect(await json(patched)).toMatchObject({ text: "Hello there", html: null });

    const held = await call(inboxKey, "POST", `${base}/${draft.id}/send`);
    expect(held.status).toBe(202);
    expect(await json(held)).toMatchObject({
      status: "pending_approval",
      approval_reasons: ["send_policy"],
    });
    const refused = await call(inboxKey, "POST", `${base}/${draft.id}/send`);
    expect(refused.status).toBe(403);
    expect((await json(refused)).name).toBe("approval_required");

    const approved = await call(teamKey, "POST", `${base}/${draft.id}/send`);
    expect(approved.status).toBe(200);
    const ack = await json(approved);
    expect(ack).toMatchObject({ object: "inbox_draft", id: draft.id });
    expect(typeof ack.email_id).toBe("string");
    expect(typeof ack.thread_id).toBe("string");
    expect(await json(await call(inboxKey, "GET", `${base}/${draft.id}`))).toMatchObject({
      status: "sent",
      email_id: ack.email_id,
    });
    expect((await call(teamKey, "DELETE", `${base}/${draft.id}`)).status).toBe(409);
  });

  it("deletes, and lets only a team-wide key reject", async () => {
    const base = `/inboxes/${inbox.id}/drafts`;
    const a = await json<{ id: string }>(
      await call(teamKey, "POST", base, { to: "x@example.org", text: "a" }),
    );
    expect(await json(await call(teamKey, "DELETE", `${base}/${a.id}`))).toEqual({
      object: "inbox_draft",
      id: a.id,
      deleted: true,
    });
    const b = await json<{ id: string }>(
      await call(teamKey, "POST", base, { to: "x@example.org", text: "b" }),
    );
    const asAgent = await call(inboxKey, "POST", `${base}/${b.id}/reject`);
    expect(asAgent.status).toBe(403);
    expect((await json(asAgent)).name).toBe("restricted_api_key");
    expect(await json(await call(teamKey, "POST", `${base}/${b.id}/reject`))).toMatchObject({
      status: "rejected",
    });
  });

  it("answers an existing reply draft with 200", async () => {
    const t = await thread();
    const body = { thread_id: t.threadId, reply_to_email_id: t.id, text: "x" };
    expect((await call(teamKey, "POST", `/inboxes/${inbox.id}/drafts`, body)).status).toBe(201);
    expect((await call(teamKey, "POST", `/inboxes/${inbox.id}/drafts`, body)).status).toBe(200);
  });
});

describe("POST /emails/receiving/{id}/reply and /forward", () => {
  async function catchAll(): Promise<{ id: string; messageId: string }> {
    const raw = await mime({
      from: "Ann <ann@outside.example>",
      to: `sales@${w.domain}`,
      subject: "Pricing",
      text: "How much?",
      messageId: `<${randomUUID()}@outside.example>`,
      attachments: [
        { filename: "q.pdf", content: Buffer.from("%PDF-1.4 q"), contentType: "application/pdf" },
      ],
    });
    const { sealReceivedRaw } = await import("@millionsend/core");
    const id = randomUUID();
    const sealed = await sealReceivedRaw(raw, w.deps.keyring, { teamId: w.teamId, rowId: id });
    const messageId = `<${id}@outside.example>`;
    await db.insert(schema.receivedEmails).values({
      id,
      teamId: w.teamId,
      domainIds: [w.domainId],
      rawSha256: createHash("sha256").update(raw).digest("hex"),
      messageId,
      from: "ann@outside.example",
      to: [`sales@${w.domain}`],
      receivedFor: [`sales@${w.domain}`],
      subject: "Pricing",
      envelope: { mailFrom: "ann@outside.example", clientIp: "192.0.2.1", helo: "mx", tls: null },
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" },
      sizeBytes: raw.length,
      rawCiphertext: sealed.ciphertext,
      rawIv: sealed.iv,
      rawWrappedDek: sealed.wrappedDek,
      rawKeyVersion: sealed.keyVersion,
      catchAll: true,
    });
    return { id, messageId };
  }

  it("answers catch-all mail from the address it reached, threaded, with no inbox rails", async () => {
    const row = await catchAll();
    const res = await call(teamKey, "POST", `/emails/receiving/${row.id}/reply`, {
      text: "Hi Ann",
    });
    expect(res.status).toBe(200);
    const out = await json<{ id: string }>(res);
    expect(out).toEqual({ object: "email", id: out.id, thread_id: null, inbox_id: null });
    const [email] = await db.select().from(schema.emails).where(eq(schema.emails.id, out.id));
    expect(email).toMatchObject({
      from: `sales@${w.domain}`,
      to: ["ann@outside.example"],
      inboxId: null,
    });
    expect(email?.headers?.["In-Reply-To"]).toBe(row.messageId);
    expect(email?.headers?.["Auto-Submitted"]).toBeUndefined();
  });

  it("answers inbox mail from the inbox, in its thread", async () => {
    const t = await thread();
    const res = await call(teamKey, "POST", `/emails/receiving/${t.id}/reply`, { text: "On it" });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      object: "email",
      thread_id: t.threadId,
      inbox_id: inbox.id,
    });
  });

  it("forwards with the original attached as a .eml", async () => {
    const row = await catchAll();
    const res = await call(teamKey, "POST", `/emails/receiving/${row.id}/forward`, {
      to: w.owner,
      text: "See attached",
      mode: "attachment",
    });
    expect(res.status).toBe(200);
    const out = await json<{ id: string }>(res);
    const [email] = await db.select().from(schema.emails).where(eq(schema.emails.id, out.id));
    expect(email?.subject).toBe("Fwd: Pricing");
    expect(email?.attachments).not.toBeNull();
  });

  it("needs a full access key, and an inbox key reaches only its inbox's mail", async () => {
    const row = await catchAll();
    expect(
      (await call(sendKey, "POST", `/emails/receiving/${row.id}/reply`, { text: "x" })).status,
    ).toBe(403);
    expect(
      (await call(inboxKey, "POST", `/emails/receiving/${row.id}/reply`, { text: "x" })).status,
    ).toBe(404);
    expect(
      (await call(teamKey, "POST", `/emails/receiving/${randomUUID()}/reply`, { text: "x" }))
        .status,
    ).toBe(404);
  });
});

describe("the inbox rails on POST /emails and the batch", () => {
  it("refuses an agent inbox's new conversation with inbox_send_policy, naming the draft route", async () => {
    const res = await call(teamKey, "POST", "/emails", {
      from: inbox.emailAddress,
      to: "stranger@example.org",
      subject: "Hi",
      text: "Hello",
    });
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body).toMatchObject({ name: "inbox_send_policy" });
    expect(String(body.message)).toContain("POST /inboxes/{inbox_id}/drafts");
    const batch = await call(teamKey, "POST", "/emails/batch", [
      { from: `plain@${w.domain}`, to: "a@example.org", subject: "x", text: "x" },
      { from: inbox.emailAddress, to: "stranger@example.org", subject: "Hi", text: "Hello" },
    ]);
    expect(batch.status).toBe(403);
    expect((await json(batch)).name).toBe("inbox_send_policy");
  });

  it("refuses a shared-domain From: those addresses send only through the inbox routes", async () => {
    const shared = await addInbox(w, { local: "shared-from", shared: true });
    const res = await call(teamKey, "POST", "/emails", {
      from: shared.emailAddress,
      to: w.owner,
      subject: "Hi",
      text: "Hello",
    });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({
      name: "inbox_send_policy",
      message: SHARED_REPLY_ONLY_MESSAGE,
    });
    expect(
      await db.select().from(schema.emails).where(eq(schema.emails.inboxId, shared.id)),
    ).toEqual([]);
  });

  it("holds an inbox key to its own address", async () => {
    const res = await call(inboxKey, "POST", "/emails", {
      from: `plain@${w.domain}`,
      to: "a@example.org",
      subject: "Hi",
      text: "Hello",
    });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({
      name: "restricted_api_key",
      message: "This API key can only send from its inbox address",
    });
  });
});

describe("openapi", () => {
  it("documents every inbox send route", async () => {
    const doc = await json<{ paths: Record<string, unknown> }>(await app.request("/openapi.json"));
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        "/inboxes/{inbox_id}/threads/{thread_id}/emails/{email_id}/reply",
        "/inboxes/{inbox_id}/threads/{thread_id}/emails/{email_id}/forward",
        "/inboxes/{inbox_id}/drafts",
        "/inboxes/{inbox_id}/drafts/{draft_id}",
        "/inboxes/{inbox_id}/drafts/{draft_id}/send",
        "/inboxes/{inbox_id}/drafts/{draft_id}/reject",
        "/emails/receiving/{id}/reply",
        "/emails/receiving/{id}/forward",
      ]),
    );
  });
});
