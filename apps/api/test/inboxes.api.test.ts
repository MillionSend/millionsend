import { randomBytes, randomUUID } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiDeps, createApi } from "../src/app.js";

/** /inboxes/** over one real database: Resend's shapes and errors, inbox-scoped keys, filters. */

const SHARED = "agents.example.test";
const CURSOR_404 =
  "The pagination cursor references an object that does not exist. See https://resend.com/docs/api-reference/pagination for more information.";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let teamId: string;
let teamKey: string;
let sendKey: string;
let otherKey: string;
let domainId: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const queued: string[] = [];

function makeApp(overrides: Partial<ApiDeps> = {}) {
  return createApi({
    db,
    keyring,
    isCloud: true,
    enqueueEmailSend: async () => {},
    enqueueWebhookDeliveries: async (rows) => {
      queued.push(...rows.map((r) => r.endpointId));
    },
    receiving: { mxHost: "mx.millionsend.test", ingestSecret: "s".repeat(40) },
    sharedInboxDomain: SHARED,
    ...overrides,
  });
}

async function key(
  team: string,
  extra: Partial<typeof schema.apiKeys.$inferInsert> = {},
): Promise<string> {
  const k = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId: team,
    name: "test",
    tokenPrefix: k.tokenPrefix,
    keyHash: k.keyHash,
    last4: k.last4,
    ...extra,
  });
  return k.token;
}

const call = (token: string, method: string, path: string, body?: unknown, via = app) =>
  via.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

async function inbox(token: string, body: Record<string, unknown>) {
  const res = await call(token, "POST", "/inboxes", body);
  if (res.status !== 201) throw new Error(`create ${res.status}: ${await res.text()}`);
  return json<{ id: string; email_address: string }>(res);
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "inbox-api");
  await db.update(schema.teams).set({ plan: "pro" }).where(eq(schema.teams.id, teamId));
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: "in.acme.test",
      region: "us-east-1",
      status: "verified",
      receivingEnabled: true,
    })
    .returning({ id: schema.domains.id });
  domainId = domain?.id as string;
  teamKey = await key(teamId);
  sendKey = await key(teamId, { permission: "sending_access" });
  const other = await createTeam(db, "inbox-api-other");
  otherKey = await key(other);
  app = makeApp();
});
afterAll(() => close());

describe("POST /inboxes and the inbox object", () => {
  it("creates an inbox and answers Resend's fields plus MillionSend's", async () => {
    const res = await call(teamKey, "POST", "/inboxes", {
      email_address: "support@in.acme.test",
      name: "Support",
      from_name: "Acme Support",
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(Object.keys(body).sort()).toEqual(
      [
        "object",
        "id",
        "name",
        "email_address",
        "domain_id",
        "receiving_address",
        "from_name",
        "unread",
        "drafts",
        "last_received",
        "created_at",
        "kind",
        "shared",
        "expires_at",
        "quarantined",
        "pending_approval",
      ].sort(),
    );
    expect(body).toMatchObject({
      object: "inbox",
      email_address: "support@in.acme.test",
      domain_id: domainId,
      kind: "agent",
      shared: false,
    });
  });

  it("refuses with Resend's names: 409 in use, 422 domain rules, 403 plan, 429 rate", async () => {
    await inbox(teamKey, { email_address: "dup@in.acme.test" });
    const dup = await call(teamKey, "POST", "/inboxes", { email_address: "dup@in.acme.test" });
    expect(dup.status).toBe(409);
    expect(await json(dup)).toEqual({
      statusCode: 409,
      name: "validation_error",
      message: "This address is already used by an inbox",
    });
    const foreign = await call(teamKey, "POST", "/inboxes", { email_address: "a@other.test" });
    expect(foreign.status).toBe(422);
    const unknownKey = await call(teamKey, "POST", "/inboxes", { kind: "robot" });
    expect(unknownKey.status).toBe(422);
    const extraSafety = await call(teamKey, "POST", "/inboxes", { safety: { colour: "red" } });
    expect(extraSafety.status).toBe(422);

    const freeTeam = await createTeam(db, "inbox-api-free");
    await db.insert(schema.domains).values({
      teamId: freeTeam,
      name: "in.free.test",
      region: "us-east-1",
      status: "verified",
      receivingEnabled: true,
    });
    const freeKey = await key(freeTeam);
    for (const local of ["a", "b", "c"])
      await inbox(freeKey, { email_address: `${local}@in.free.test` });
    const capped = await call(freeKey, "POST", "/inboxes", { email_address: "d@in.free.test" });
    expect(capped.status).toBe(403);
    expect(await json(capped)).toMatchObject({
      name: "validation_error",
      message: "You have reached the inbox limit of your plan. Upgrade to add more.",
    });
    for (let n = 0; n < 10; n += 1) {
      await db.insert(schema.inboxActivity).values({
        teamId: freeTeam,
        inboxId: randomUUID(),
        actor: "system",
        action: "inbox.created",
      });
    }
    await db.delete(schema.inboxes).where(eq(schema.inboxes.teamId, freeTeam));
    const rated = await call(freeKey, "POST", "/inboxes", { email_address: "e@in.free.test" });
    expect(rated.status).toBe(429);
    expect((await json(rated)).name).toBe("rate_limit_exceeded");
    expect(Number(rated.headers.get("retry-after"))).toBeGreaterThan(0);

    const sending = await call(sendKey, "POST", "/inboxes", { email_address: "s@in.acme.test" });
    expect(sending.status).toBe(403);
    const off = await call(
      teamKey,
      "POST",
      "/inboxes",
      { email_address: "off@in.acme.test" },
      makeApp({ receiving: undefined }),
    );
    expect(await json(off)).toMatchObject({
      statusCode: 422,
      message: "This instance does not receive mail",
    });
  });

  it("gives an inbox without an address a shared one that expires", async () => {
    const res = await call(teamKey, "POST", "/inboxes", { name: "Signup bot", kind: "agent" });
    expect(res.status).toBe(201);
    const body = await json<{ email_address: string; shared: boolean; expires_at: string }>(res);
    expect(body.email_address).toMatch(/^signup-bot-[a-z0-9]{4}@inbox-api\.agents\.example\.test$/);
    expect(body.shared).toBe(true);
    expect(new Date(body.expires_at).getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
    const never = await call(teamKey, "POST", "/inboxes", { expires_in: null });
    expect(never.status).toBe(422);
  });

  it("reads by id or address, lists newest first with Resend's paging errors", async () => {
    const a = await inbox(teamKey, { email_address: "list-a@in.acme.test", kind: "human" });
    const b = await inbox(teamKey, { email_address: "list-b@in.acme.test" });
    const byAddress = await call(teamKey, "GET", "/inboxes/LIST-A%40in.acme.test");
    expect((await json(byAddress)).id).toBe(a.id);
    expect((await call(teamKey, "GET", `/inboxes/${a.id}`)).status).toBe(200);
    expect((await call(otherKey, "GET", `/inboxes/${a.id}`)).status).toBe(404);
    const bad = await call(teamKey, "GET", "/inboxes/not-an-id");
    expect(bad.status).toBe(422);

    const list = await json<{ object: string; has_more: boolean; data: { id: string }[] }>(
      await call(teamKey, "GET", "/inboxes?limit=2"),
    );
    expect(list.object).toBe("list");
    expect(list.data.map((i) => i.id)).toEqual([b.id, a.id]);
    expect(list.has_more).toBe(true);
    const humans = await json<{ data: { id: string }[] }>(
      await call(teamKey, "GET", "/inboxes?kind=human"),
    );
    expect(humans.data.map((i) => i.id)).toEqual([a.id]);

    const limit = await call(teamKey, "GET", "/inboxes?limit=101");
    expect(await json(limit)).toEqual({
      statusCode: 422,
      name: "validation_error",
      message:
        "The pagination limit must be a number between 1 and 100. See https://resend.com/docs/api-reference/pagination for more information.",
    });
    const both = await call(teamKey, "GET", `/inboxes?after=${a.id}&before=${b.id}`);
    expect((await json(both)).message).toBe(
      "You can only pass one of `before` or `after` for pagination. See https://resend.com/docs/api-reference/pagination for more information.",
    );
    const missing = await call(teamKey, "GET", `/inboxes?after=${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect((await json(missing)).message).toBe(CURSOR_404);
    const notId = await call(teamKey, "GET", "/inboxes?after=2026-01-01");
    expect((await json(notId)).message).toBe("The `after` parameter must be an inbox ID.");
  });

  it("updates and deletes; an expired inbox is gone", async () => {
    const created = await inbox(teamKey, { email_address: "change@in.acme.test" });
    const empty = await call(teamKey, "PATCH", `/inboxes/${created.id}`, {});
    expect(empty.status).toBe(422);
    const renamed = await call(teamKey, "PATCH", `/inboxes/${created.id}`, {
      name: "Desk",
      from_name: "",
      expires_in: "2h",
    });
    expect(renamed.status).toBe(200);
    expect(await json(renamed)).toMatchObject({ object: "inbox", name: "Desk", from_name: null });
    const deleted = await call(teamKey, "DELETE", `/inboxes/${created.id}`);
    expect(await json(deleted)).toEqual({ object: "inbox", id: created.id, deleted: true });
    expect((await call(teamKey, "DELETE", `/inboxes/${created.id}`)).status).toBe(404);

    const expiring = await inbox(teamKey, {
      email_address: "brief@in.acme.test",
      expires_in: "1h",
    });
    await db
      .update(schema.inboxes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.inboxes.id, expiring.id));
    const gone = await call(teamKey, "GET", `/inboxes/${expiring.id}`);
    expect(gone.status).toBe(404);
    expect(await json(gone)).toEqual({
      statusCode: 404,
      name: "not_found",
      message: "Inbox not found.",
    });
  });

  it("answers Resend's no-agent shape and refuses agent settings (D9)", async () => {
    const created = await inbox(teamKey, { email_address: "agentless@in.acme.test" });
    expect(await json(await call(teamKey, "GET", `/inboxes/${created.id}/agent`))).toEqual({
      object: "inbox_agent",
      instructions: null,
      tone: null,
      enabled_actions: [],
    });
    const patched = await call(teamKey, "PATCH", `/inboxes/${created.id}/agent`, {
      instructions: "Be nice",
    });
    expect(patched.status).toBe(422);
    expect((await json(patched)).message).toBe(
      "Hosted agent settings are not supported; MillionSend runs no agent of its own",
    );
    expect((await call(teamKey, "GET", `/inboxes/${randomUUID()}/agent`)).status).toBe(404);
  });

  it("reads and patches safety rules", async () => {
    const created = await inbox(teamKey, { email_address: "rules@in.acme.test" });
    const got = await json(await call(teamKey, "GET", `/inboxes/${created.id}/safety`));
    expect(got).toMatchObject({
      object: "inbox_safety",
      inbox_id: created.id,
      accept_from: "verified",
      send_policy: "reply_only",
    });
    const patched = await call(teamKey, "PATCH", `/inboxes/${created.id}/safety`, {
      accept_from: "allowlist",
      allowlist: ["*@Partner.test"],
    });
    expect(await json(patched)).toMatchObject({
      accept_from: "allowlist",
      allowlist: ["*@partner.test"],
    });
    const refused = await call(teamKey, "PATCH", `/inboxes/${created.id}/safety`, { send_cap: 0 });
    expect(refused.status).toBe(422);
    const unknown = await call(teamKey, "PATCH", `/inboxes/${created.id}/safety`, { hidden: true });
    expect(unknown.status).toBe(422);
  });
});

describe("labels and threads over HTTP", () => {
  let inboxId: string;
  let threadId: string;

  beforeAll(async () => {
    inboxId = (await inbox(teamKey, { email_address: "threads@in.acme.test" })).id;
    const [thread] = await db
      .insert(schema.inboxThreads)
      .values({ teamId, inboxId, subject: "Question" })
      .returning({ id: schema.inboxThreads.id });
    threadId = thread?.id as string;
    const [row] = await db
      .insert(schema.receivedEmails)
      .values({
        teamId,
        domainIds: [domainId],
        rawSha256: randomUUID(),
        messageId: "<q@sender.test>",
        from: "ana@sender.test",
        receivedFor: ["threads@in.acme.test"],
        subject: "Question",
        envelope: { mailFrom: "ana@sender.test", clientIp: "192.0.2.1", helo: "h", tls: null },
        authentication: { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" },
        sizeBytes: 1,
        catchAll: false,
      })
      .returning({ id: schema.receivedEmails.id });
    await db.insert(schema.receivedEmailInboxes).values({
      receivedEmailId: row?.id as string,
      inboxId,
      teamId,
      threadId,
      address: "threads@in.acme.test",
      senderTrust: "external",
      verdict: "clean",
      deliveredAt: new Date(),
    });
  });

  it("creates, lists, renames and deletes labels with Resend's acks", async () => {
    const created = await call(teamKey, "POST", `/inboxes/${inboxId}/labels`, {
      name: "Billing",
      color: "#e93d82",
    });
    expect(created.status).toBe(201);
    const label = await json<{ id: string }>(created);
    expect(label).toEqual({
      object: "inbox_label",
      id: label.id,
      name: "Billing",
      color: "#E93D82",
      created_at: expect.any(String),
    });
    const list = await json(await call(teamKey, "GET", `/inboxes/${inboxId}/labels`));
    expect(list).toEqual({ object: "list", data: [expect.objectContaining({ id: label.id })] });
    const dup = await call(teamKey, "POST", `/inboxes/${inboxId}/labels`, { name: "billing" });
    expect(dup.status).toBe(422);
    expect(
      await json(
        await call(teamKey, "PATCH", `/inboxes/${inboxId}/labels/${label.id}`, { name: "Bills" }),
      ),
    ).toMatchObject({ object: "inbox_label", id: label.id, name: "Bills" });
    const applied = await call(teamKey, "PATCH", `/inboxes/${inboxId}/threads/${threadId}`, {
      label_id: label.id,
    });
    expect(await json(applied)).toMatchObject({ labels: [{ id: label.id, name: "Bills" }] });
    expect(
      await json(await call(teamKey, "DELETE", `/inboxes/${inboxId}/labels/${label.id}`)),
    ).toEqual({
      object: "inbox_label",
      id: label.id,
      deleted: true,
    });
    const gone = await call(teamKey, "DELETE", `/inboxes/${inboxId}/labels/${label.id}`);
    expect(await json(gone)).toEqual({
      statusCode: 404,
      name: "not_found",
      message: `Label "${label.id}" not found.`,
    });
  });

  it("lists, searches, reads and trashes threads with Resend's errors", async () => {
    const list = await json<{ data: { id: string; subject: string }[] }>(
      await call(teamKey, "GET", `/inboxes/${inboxId}/threads`),
    );
    expect(list.data.map((t) => t.id)).toEqual([threadId]);
    const search = await json<{ data: { id: string; highlights: unknown }[] }>(
      await call(teamKey, "GET", `/inboxes/${inboxId}/threads/search?query=question`),
    );
    expect(search.data).toEqual([
      expect.objectContaining({ id: threadId, highlights: { subject: ["**Question**"] } }),
    ]);
    const errors: [string, string][] = [
      [
        "?folders=inbox,drafts",
        'The `folders` value "drafts" must be one of: inbox, archive, spam, sent, trash.',
      ],
      ["?labels=billing", 'The `labels` value "billing" must be a valid UUID.'],
      [
        `?labels=${Array.from({ length: 60 }, () => randomUUID()).join(",")}`,
        "The `labels` parameter must contain at most 50 label IDs, but received 60.",
      ],
      ["?read=yes", "The `read` parameter must be `true` or `false`."],
      [
        "?after=2026-09-01",
        "The `after` parameter must be a thread ID. To filter by date, use `GET /inboxes/:id/threads/search` with `start_date`.",
      ],
      [
        "?before=2026-09-01",
        "The `before` parameter must be a thread ID. To filter by date, use `GET /inboxes/:id/threads/search` with `end_date`.",
      ],
      [
        "/search?from=a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y",
        "The `from` parameter must contain at most 20 values, but received 25.",
      ],
      ["/search?has_attachment=maybe", "The `has_attachment` parameter must be `true` or `false`."],
      ["/search?start_date=soon", "The `start_date` must be a valid ISO 8601 date."],
    ];
    for (const [suffix, message] of errors) {
      const path = suffix.startsWith("/search")
        ? `/inboxes/${inboxId}/threads${suffix}`
        : `/inboxes/${inboxId}/threads${suffix}`;
      const res = await call(teamKey, "GET", path);
      expect(res.status, suffix).toBe(422);
      expect((await json(res)).message, suffix).toBe(message);
    }
    const repeated = await call(
      teamKey,
      "GET",
      `/inboxes/${inboxId}/threads?folders=inbox&folders=sent`,
    );
    expect(repeated.status).toBe(422);
    const label404 = await call(
      teamKey,
      "GET",
      `/inboxes/${inboxId}/threads?labels=${randomUUID()}`,
    );
    expect(label404.status).toBe(404);
    const noInbox = await call(teamKey, "GET", `/inboxes/${randomUUID()}/threads`);
    expect((await json(noInbox)).message).toBe("Inbox not found.");

    expect(
      await json(await call(teamKey, "GET", `/inboxes/${inboxId}/threads/${threadId}`)),
    ).toEqual({
      object: "inbox_thread",
      id: threadId,
      subject: "Question",
      folder: "inbox",
      labels: [],
      read: false,
      quarantined: 0,
    });
    const noThread = await call(teamKey, "GET", `/inboxes/${inboxId}/threads/${randomUUID()}`);
    expect((await json(noThread)).message).toBe("Thread not found.");
    expect(
      (await call(teamKey, "PATCH", `/inboxes/${inboxId}/threads/${threadId}`, {})).status,
    ).toBe(422);
    expect(
      (await call(teamKey, "PATCH", `/inboxes/${inboxId}/threads/${threadId}`, { folder: "sent" }))
        .status,
    ).toBe(422);
    const emails = await json<{ data: { id: string; direction: string }[] }>(
      await call(teamKey, "GET", `/inboxes/${inboxId}/threads/${threadId}/emails`),
    );
    expect(emails.data.map((e) => e.direction)).toEqual(["inbound"]);
    expect(
      await json(await call(teamKey, "DELETE", `/inboxes/${inboxId}/threads/${threadId}`)),
    ).toEqual({
      object: "inbox_thread",
      id: threadId,
      deleted: true,
    });
    expect(
      await json(await call(teamKey, "DELETE", `/inboxes/${inboxId}/threads/${threadId}`)),
    ).toEqual({
      object: "inbox_thread",
      id: threadId,
      deleted: false,
    });
    await call(teamKey, "PATCH", `/inboxes/${inboxId}/threads/${threadId}`, { folder: "inbox" });
  });

  it("lists quarantined mail for owners", async () => {
    const list = await json(await call(teamKey, "GET", `/inboxes/${inboxId}/quarantine`));
    expect(list).toEqual({ object: "list", has_more: false, data: [] });
  });
});

describe("inbox-scoped API keys", () => {
  let own: { id: string; email_address: string };
  let other: { id: string; email_address: string };
  let inboxKey: string;

  beforeAll(async () => {
    own = await inbox(teamKey, { email_address: "scoped@in.acme.test" });
    other = await inbox(teamKey, { email_address: "unscoped@in.acme.test" });
    const minted = await call(teamKey, "POST", "/api-keys", { name: "agent", inbox_id: own.id });
    expect(minted.status).toBe(200);
    inboxKey = (await json<{ token: string }>(minted)).token;
  });

  it("reaches its own inbox's routes and nothing else", async () => {
    const listed = await json<{ data: { id: string }[] }>(await call(inboxKey, "GET", "/inboxes"));
    expect(listed.data.map((i) => i.id)).toEqual([own.id]);
    expect((await call(inboxKey, "GET", `/inboxes/${own.id}`)).status).toBe(200);
    expect(
      (await call(inboxKey, "GET", `/inboxes/${encodeURIComponent(own.email_address)}`)).status,
    ).toBe(200);
    expect(
      (await call(inboxKey, "GET", `/inboxes/${encodeURIComponent(other.email_address)}`)).status,
    ).toBe(404);
    expect((await call(inboxKey, "GET", `/inboxes/${own.id}/safety`)).status).toBe(200);
    expect((await call(inboxKey, "GET", `/inboxes/${own.id}/threads`)).status).toBe(200);
    expect((await call(inboxKey, "GET", "/emails/receiving")).status).toBe(200);
    const refused: [string, string, unknown?][] = [
      ["GET", `/inboxes/${other.id}`],
      ["GET", `/inboxes/${other.id}/threads`],
      ["POST", "/inboxes", { name: "x" }],
      ["PATCH", `/inboxes/${own.id}`, { name: "x" }],
      ["DELETE", `/inboxes/${own.id}`],
      ["PATCH", `/inboxes/${own.id}/safety`, { screening: false }],
      ["GET", `/inboxes/${own.id}/quarantine`],
      ["POST", `/inboxes/${own.id}/quarantine/${randomUUID()}/release`, {}],
      ["GET", "/domains"],
      ["GET", "/api-keys"],
      ["POST", "/api-keys", { name: "child" }],
      ["GET", "/webhooks"],
      ["GET", "/emails"],
      ["GET", "/usage"],
      ["DELETE", `/emails/receiving/${randomUUID()}`],
    ];
    for (const [method, path, body] of refused) {
      const res = await call(inboxKey, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await json(res), `${method} ${path}`).toEqual({
        statusCode: 403,
        name: "restricted_api_key",
        message: "This API key is restricted to one inbox",
      });
    }
    const held = await call(inboxKey, "GET", `/inboxes/${own.id}/threads?include_quarantined=true`);
    expect(held.status).toBe(403);
    expect((await json(held)).message).toBe("include_quarantined needs a full access key");
  });

  it("mints only under the rules: full access, no domain, its team's inbox, at most 5", async () => {
    const mint = (body: Record<string, unknown>, token = teamKey) =>
      call(token, "POST", "/api-keys", body);
    expect((await mint({ name: "s", inbox_id: own.id, permission: "sending_access" })).status).toBe(
      422,
    );
    expect((await mint({ name: "d", inbox_id: own.id, domain_id: domainId })).status).toBe(422);
    expect((await mint({ name: "f", inbox_id: randomUUID() })).status).toBe(422);
    const foreignInbox = await inbox(otherKey, {});
    expect((await mint({ name: "o", inbox_id: foreignInbox.id })).status).toBe(422);
    const scopedDomainKey = await key(teamId, { domainId });
    expect((await mint({ name: "x", inbox_id: own.id }, scopedDomainKey)).status).toBe(403);
    for (let n = 1; n < 5; n += 1)
      expect((await mint({ name: `k${n}`, inbox_id: own.id })).status).toBe(200);
    const sixth = await mint({ name: "k6", inbox_id: own.id });
    expect(sixth.status).toBe(422);
    expect((await json(sixth)).message).toBe(
      "An inbox can have at most 5 active API keys; revoke one first",
    );
    const items = await json<{ data: { inbox_id: string | null }[] }>(
      await call(teamKey, "GET", "/api-keys"),
    );
    expect(items.data.filter((k) => k.inbox_id === own.id)).toHaveLength(5);
    const activity = await db
      .select({ action: schema.inboxActivity.action })
      .from(schema.inboxActivity)
      .where(
        and(
          eq(schema.inboxActivity.inboxId, own.id),
          eq(schema.inboxActivity.action, "key.created"),
        ),
      );
    expect(activity).toHaveLength(5);
  });

  it("is revoked, never widened, when its inbox is deleted", async () => {
    const doomed = await inbox(teamKey, { email_address: "doomed@in.acme.test" });
    const minted = await call(teamKey, "POST", "/api-keys", {
      name: "doomed",
      inbox_id: doomed.id,
    });
    const token = (await json<{ token: string }>(minted)).token;
    expect((await call(token, "GET", "/inboxes")).status).toBe(200);
    expect((await call(teamKey, "DELETE", `/inboxes/${doomed.id}`)).status).toBe(200);
    expect((await call(token, "GET", "/inboxes")).status).toBe(401);
    expect((await call(token, "GET", "/domains")).status).toBe(401);
  });

  it("stops working when its inbox expires, before the sweep revokes it (S21)", async () => {
    const brief = await inbox(teamKey, {
      email_address: "brief-key@in.acme.test",
      expires_in: "1h",
    });
    const minted = await call(teamKey, "POST", "/api-keys", { name: "brief", inbox_id: brief.id });
    const token = (await json<{ token: string }>(minted)).token;
    expect((await call(token, "GET", "/emails/receiving")).status).toBe(200);
    await db
      .update(schema.inboxes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.inboxes.id, brief.id));
    expect((await call(token, "GET", "/emails/receiving")).status).toBe(401);
  });
});

describe("domain-scoped API keys", () => {
  it("reach only their domain's inboxes, as their received-mail reads do", async () => {
    await db.insert(schema.domains).values({
      teamId,
      name: "elsewhere.acme.test",
      region: "us-east-1",
      status: "verified",
      receivingEnabled: true,
    });
    const own = await inbox(teamKey, { email_address: "dk-own@in.acme.test" });
    const outside = [
      await inbox(teamKey, { email_address: "dk-other@elsewhere.acme.test" }),
      await inbox(teamKey, {}),
    ];
    const scoped = await key(teamId, { domainId });
    const listed = await json<{ data: { id: string }[] }>(
      await call(scoped, "GET", "/inboxes?limit=100"),
    );
    expect(listed.data.map((i) => i.id)).toContain(own.id);
    expect((await call(scoped, "GET", `/inboxes/${own.id}/threads`)).status).toBe(200);
    for (const { id, email_address } of outside) {
      expect(listed.data.map((i) => i.id)).not.toContain(id);
      for (const [method, path, body] of [
        ["GET", `/inboxes/${id}`],
        ["GET", `/inboxes/${encodeURIComponent(email_address)}`],
        ["GET", `/inboxes/${id}/threads`],
        ["GET", `/inboxes/${id}/quarantine`],
        ["GET", `/inboxes/${id}/codes/latest`],
        ["PATCH", `/inboxes/${id}`, { name: "x" }],
        ["PATCH", `/inboxes/${id}/safety`, { screening: false }],
        ["DELETE", `/inboxes/${id}`],
      ] as [string, string, unknown?][]) {
        expect((await call(scoped, method, path, body)).status, `${method} ${path}`).toBe(404);
      }
    }
    for (const body of [{ email_address: "dk-new@elsewhere.acme.test" }, {}]) {
      const refused = await call(scoped, "POST", "/inboxes", body);
      expect(refused.status).toBe(403);
      expect((await json(refused)).name).toBe("restricted_api_key");
    }
    expect(
      (await call(scoped, "POST", "/inboxes", { email_address: "dk-new@in.acme.test" })).status,
    ).toBe(201);
  });
});

describe("webhook inbox_ids", () => {
  it("filters inbox events to the named inboxes and forgets deleted ones", async () => {
    const a = await inbox(teamKey, { email_address: "hook-a@in.acme.test" });
    const b = await inbox(teamKey, { email_address: "hook-b@in.acme.test" });
    const create = (body: Record<string, unknown>) =>
      call(teamKey, "POST", "/webhooks", {
        endpoint: "https://hooks.example.test/in",
        events: ["inbox.updated"],
        ...body,
      });
    const foreign = await create({ inbox_ids: [randomUUID()] });
    expect(foreign.status).toBe(422);
    const filtered = (await json<{ id: string }>(await create({ inbox_ids: [a.id.toUpperCase()] })))
      .id;
    const everyInbox = (await json<{ id: string }>(await create({}))).id;
    expect(await json(await call(teamKey, "GET", `/webhooks/${filtered}`))).toMatchObject({
      inbox_ids: [a.id],
    });
    expect(await json(await call(teamKey, "GET", `/webhooks/${everyInbox}`))).toMatchObject({
      inbox_ids: null,
    });

    await call(teamKey, "PATCH", `/inboxes/${a.id}`, { name: "A" });
    await call(teamKey, "PATCH", `/inboxes/${b.id}`, { name: "B" });
    const hooksFor = async (endpointId: string) =>
      (
        await db
          .select({ payload: schema.webhookDeliveries.payload })
          .from(schema.webhookDeliveries)
          .where(eq(schema.webhookDeliveries.endpointId, endpointId))
      ).map((d) => (d.payload as { data: { inbox_id: string } }).data.inbox_id);
    expect(await hooksFor(filtered)).toEqual([a.id]);
    expect((await hooksFor(everyInbox)).sort()).toEqual([a.id, b.id].sort());

    await call(teamKey, "DELETE", `/inboxes/${a.id}`);
    expect(await json(await call(teamKey, "GET", `/webhooks/${filtered}`))).toMatchObject({
      inbox_ids: [],
    });
    expect(
      (await call(teamKey, "PATCH", `/webhooks/${filtered}`, { inbox_ids: null })).status,
    ).toBe(200);
    expect(await json(await call(teamKey, "GET", `/webhooks/${filtered}`))).toMatchObject({
      inbox_ids: null,
    });
  });
});

describe("GET /usage", () => {
  it("reports the plan's inbox limit", async () => {
    const limits = async (plan: "free" | "starter" | "pro") => {
      await db.update(schema.teams).set({ plan }).where(eq(schema.teams.id, teamId));
      return (
        await json<{ limits: { inboxes: number | null } }>(await call(teamKey, "GET", "/usage"))
      ).limits.inboxes;
    };
    expect(await limits("free")).toBe(3);
    expect(await limits("starter")).toBe(25);
    expect(await limits("pro")).toBeNull();
  });
});

describe("openapi", () => {
  it("documents the inbox routes", async () => {
    const doc = await json<{ paths: Record<string, unknown> }>(await app.request("/openapi.json"));
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        "/inboxes",
        "/inboxes/{inbox_id}",
        "/inboxes/{inbox_id}/safety",
        "/inboxes/{inbox_id}/labels/{label_id}",
        "/inboxes/{inbox_id}/threads/search",
        "/inboxes/{inbox_id}/threads/{thread_id}/emails/{email_id}",
        "/inboxes/{inbox_id}/quarantine/{email_id}/release",
        "/inboxes/{inbox_id}/codes/latest",
      ]),
    );
  });
});
