import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey, utcDay } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let tokenA: string;
let tokenB: string;
let teamA: string;

const json = async (res: Response) =>
  (await res.json()) as { id: string; data?: unknown[] } & Record<string, unknown>;

async function call(token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const draftBody = () => ({
  from: "Acme <hi@acme.dev>",
  subject: "hello",
  html: "<p>hi</p>",
});

// A fresh team with its own key, verified domain, and one draft broadcast —
// isolated so seeding its usage_counters can't affect the shared team-A
// happy-path tests.
async function makeSendableTeam(slug: string) {
  const teamId = await createTeam(db, slug);
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: slug,
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  await db.insert(schema.domains).values({
    teamId,
    name: "acme.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  const [bc] = await db
    .insert(schema.broadcasts)
    .values({ teamId, from: "Acme <hi@acme.dev>", subject: "s", html: "<p>hi</p>" })
    .returning({ id: schema.broadcasts.id });
  if (!bc) throw new Error("broadcast insert failed");
  return { teamId, token: key.token, broadcastId: bc.id };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  for (const [slug, setToken] of [
    ["bc-team-a", (t: string) => (tokenA = t)],
    ["bc-team-b", (t: string) => (tokenB = t)],
  ] as const) {
    const teamId = await createTeam(db, slug);
    if (slug === "bc-team-a") teamA = teamId;
    const key = generateApiKey();
    setToken(key.token);
    await db.insert(schema.apiKeys).values({
      teamId,
      name: slug,
      tokenPrefix: key.tokenPrefix,
      keyHash: key.keyHash,
      last4: key.last4,
    });
  }
  await db.insert(schema.domains).values({
    teamId: teamA,
    name: "acme.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
    enqueueBroadcastSend: async () => {},
    appBaseUrl: "https://app.example.test",
  });
});

afterAll(async () => {
  await close();
});

describe("broadcasts API", () => {
  let broadcastId: string;

  it("requires an API key", async () => {
    const res = await app.request("/broadcasts");
    expect(res.status).toBe(401);
  });

  it("creates a draft broadcast", async () => {
    const res = await call(tokenA, "POST", "/broadcasts", draftBody());
    expect(res.status).toBe(200);
    broadcastId = (await json(res)).id;
    expect(broadcastId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("422s a create without html or text", async () => {
    const { html: _html, ...noBody } = draftBody();
    expect((await call(tokenA, "POST", "/broadcasts", noBody)).status).toBe(422);
  });

  it("422s a create with an unknown segment_id", async () => {
    const res = await call(tokenA, "POST", "/broadcasts", {
      ...draftBody(),
      segment_id: crypto.randomUUID(),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ name: "validation_error" });
  });

  it("round-trips preview_text through create, GET, and PATCH; null when unset", async () => {
    const unset = await call(tokenA, "GET", `/broadcasts/${broadcastId}`);
    expect(await unset.json()).toMatchObject({ preview_text: null });

    const created = await call(tokenA, "POST", "/broadcasts", {
      ...draftBody(),
      preview_text: "peek",
    });
    expect(created.status).toBe(200);
    const id = (await json(created)).id;
    expect(await (await call(tokenA, "GET", `/broadcasts/${id}`)).json()).toMatchObject({
      preview_text: "peek",
    });

    const patched = await call(tokenA, "PATCH", `/broadcasts/${id}`, { preview_text: "peek 2" });
    expect(patched.status).toBe(200);
    expect(await (await call(tokenA, "GET", `/broadcasts/${id}`)).json()).toMatchObject({
      preview_text: "peek 2",
    });
  });

  it("send 422s when the sender domain is not verified for the team", async () => {
    const res = await call(tokenA, "POST", "/broadcasts", {
      ...draftBody(),
      from: "Other <hi@other.dev>",
    });
    const id = (await json(res)).id;
    const sent = await call(tokenA, "POST", `/broadcasts/${id}/send`, {});
    expect(sent.status).toBe(422);
    expect(await sent.json()).toMatchObject({ statusCode: 422, name: "validation_error" });
  });

  it("send 422s from a domain that exists but is not fully verified (pending status)", async () => {
    // The row exists for the team, but strict verification left it 'pending';
    // the send gate must refuse it exactly like an unknown domain.
    await db.insert(schema.domains).values({
      teamId: teamA,
      name: "pending.dev",
      region: "us-east-1",
      status: "pending",
    });
    const res = await call(tokenA, "POST", "/broadcasts", {
      ...draftBody(),
      from: "Pending <hi@pending.dev>",
    });
    const id = (await json(res)).id;
    const sent = await call(tokenA, "POST", `/broadcasts/${id}/send`, {});
    expect(sent.status).toBe(422);
    expect(await sent.json()).toMatchObject({ statusCode: 422, name: "validation_error" });
  });

  it("cancel of a draft is a 400 with a RESEND_ERROR_CODE_KEY name", async () => {
    const res = await call(tokenA, "POST", `/broadcasts/${broadcastId}/cancel`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ name: "invalid_parameter" });
  });

  it("rejects a multi-mailbox From on create and update", async () => {
    const spoof = "Acme <evil@evil.test> <ok@acme.dev>";
    const created = await call(tokenA, "POST", "/broadcasts", { ...draftBody(), from: spoof });
    expect(created.status).toBe(422);
    expect(await created.json()).toMatchObject({ name: "validation_error" });

    const updated = await call(tokenA, "PATCH", `/broadcasts/${broadcastId}`, { from: spoof });
    expect(updated.status).toBe(422);
  });

  it("send rejects a stored multi-mailbox From (pre-validation rows)", async () => {
    // Bypasses request validation the way a legacy row would.
    const [row] = await db
      .insert(schema.broadcasts)
      .values({
        teamId: teamA,
        from: "Acme <evil@evil.test> <ok@acme.dev>",
        subject: "s",
        html: "<p>hi</p>",
      })
      .returning({ id: schema.broadcasts.id });
    const sent = await call(tokenA, "POST", `/broadcasts/${row?.id}/send`, {});
    expect(sent.status).toBe(422);
    expect(await sent.json()).toMatchObject({
      name: "validation_error",
      message: "from must be a single address",
    });
  });

  it("send 422s when APP_BASE_URL is not configured", async () => {
    const bare = createApi({
      db,
      keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
      isCloud: true,
      enqueueEmailSend: async () => {},
      enqueueBroadcastSend: async () => {},
    });
    const created = await call(tokenA, "POST", "/broadcasts", draftBody());
    const id = (await json(created)).id;
    const sent = await bare.request(`/broadcasts/${id}/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(sent.status).toBe(422);
    expect(await sent.json()).toMatchObject({
      name: "validation_error",
      message: expect.stringContaining("APP_BASE_URL"),
    });
  });

  it("honors limit and has_more on the list", async () => {
    const res = await call(tokenA, "GET", "/broadcasts?limit=1");
    expect(res.status).toBe(200);
    const body = (await json(res)) as unknown as { data: unknown[]; has_more: boolean };
    expect(body.data).toHaveLength(1);
    expect(body.has_more).toBe(true);
  });

  it("isolates tenants: team B cannot see or touch team A broadcasts", async () => {
    const list = await call(tokenB, "GET", "/broadcasts");
    expect((await json(list)).data).toEqual([]);

    for (const [method, path, body] of [
      ["GET", `/broadcasts/${broadcastId}`, undefined],
      ["PATCH", `/broadcasts/${broadcastId}`, { subject: "stolen" }],
      ["DELETE", `/broadcasts/${broadcastId}`, undefined],
      ["POST", `/broadcasts/${broadcastId}/send`, {}],
      ["POST", `/broadcasts/${broadcastId}/cancel`, undefined],
    ] as const) {
      const res = await call(tokenB, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }

    // Team A's draft is untouched.
    const still = await call(tokenA, "GET", `/broadcasts/${broadcastId}`);
    expect(await still.json()).toMatchObject({ status: "draft", subject: "hello" });
  });

  it("draft update cannot move the broadcast to a foreign segment", async () => {
    const [foreign] = await db
      .insert(schema.segments)
      .values({
        teamId: await createTeam(db, "bc-team-c"),
        name: "foreign",
        filter: { match: "any", conditions: [] },
      })
      .returning({ id: schema.segments.id });
    const res = await call(tokenA, "PATCH", `/broadcasts/${broadcastId}`, {
      segment_id: foreign?.id,
    });
    expect(res.status).toBe(422);
  });

  it("send → queued on the wire; update and delete then 400; cancel → canceled", async () => {
    const sent = await call(tokenA, "POST", `/broadcasts/${broadcastId}/send`, {});
    expect(sent.status).toBe(200);
    const got = await call(tokenA, "GET", `/broadcasts/${broadcastId}`);
    // Internally scheduled; the SDK's status union has no 'scheduled'.
    expect(await got.json()).toMatchObject({ status: "queued" });

    expect(
      (await call(tokenA, "PATCH", `/broadcasts/${broadcastId}`, { subject: "late" })).status,
    ).toBe(400);
    expect((await call(tokenA, "DELETE", `/broadcasts/${broadcastId}`)).status).toBe(400);

    const canceled = await call(tokenA, "POST", `/broadcasts/${broadcastId}/cancel`);
    expect(canceled.status).toBe(200);
    const after = await call(tokenA, "GET", `/broadcasts/${broadcastId}`);
    expect(await after.json()).toMatchObject({ status: "canceled" });
  });
});

describe("broadcasts API deliverability guardrail", () => {
  let enqueued: string[];
  let guarded: ReturnType<typeof createApi>;

  const sendGuarded = (token: string, id: string) =>
    guarded.request(`/broadcasts/${id}/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });

  beforeAll(() => {
    enqueued = [];
    guarded = createApi({
      db,
      keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
      isCloud: true,
      enqueueEmailSend: async () => {},
      enqueueBroadcastSend: async (id) => {
        enqueued.push(id);
      },
      appBaseUrl: "https://app.example.test",
    });
  });

  it("403s sending_paused when past the complaint pause line, leaving the draft unsent", async () => {
    const { teamId, token, broadcastId } = await makeSendableTeam("bc-paused");
    // Over the floor (1000) and over the 0.1% complaint pause line.
    await db.insert(schema.usageCounters).values({
      teamId,
      day: utcDay(),
      sent: 2000,
      complained: 5,
    });

    const res = await sendGuarded(token, broadcastId);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ statusCode: 403, name: "sending_paused" });

    const [row] = await db
      .select({ status: schema.broadcasts.status })
      .from(schema.broadcasts)
      .where(eq(schema.broadcasts.id, broadcastId));
    expect(row?.status).toBe("draft");
    expect(enqueued).not.toContain(broadcastId);
  });

  it("sends normally at volume over the floor but under the warn line", async () => {
    const { teamId, token, broadcastId } = await makeSendableTeam("bc-healthy");
    // Over the floor, but 0.05% bounce / 0% complaint — below both warn lines.
    await db.insert(schema.usageCounters).values({
      teamId,
      day: utcDay(),
      sent: 2000,
      bounced: 1,
    });

    const res = await sendGuarded(token, broadcastId);
    expect(res.status).toBe(200);
    expect(enqueued).toContain(broadcastId);
  });
});

describe("broadcasts send-on-create", () => {
  let enq: { id: string; startAfter: Date | undefined }[];
  let sendApp: ReturnType<typeof createApi>;

  const post = (token: string, body: unknown, viaApp?: ReturnType<typeof createApi>) =>
    (viaApp ?? sendApp).request("/broadcasts", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const statusOf = async (id: string) =>
    (
      await db
        .select({ status: schema.broadcasts.status, scheduledAt: schema.broadcasts.scheduledAt })
        .from(schema.broadcasts)
        .where(eq(schema.broadcasts.id, id))
    )[0];

  beforeAll(() => {
    enq = [];
    sendApp = createApi({
      db,
      keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
      isCloud: true,
      enqueueEmailSend: async () => {},
      enqueueBroadcastSend: async (id, opts) => {
        enq.push({ id, startAfter: opts?.startAfter });
      },
      appBaseUrl: "https://app.example.test",
    });
  });

  it("send: true creates and schedules in one call", async () => {
    const res = await post(tokenA, { ...draftBody(), send: true });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect((await statusOf(id))?.status).toBe("scheduled");
    expect(enq.map((e) => e.id)).toContain(id);
  });

  it("send: true with scheduled_at schedules at that time", async () => {
    const at = new Date(Date.now() + 60 * 60 * 1000);
    const res = await post(tokenA, {
      ...draftBody(),
      send: true,
      scheduled_at: at.toISOString(),
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const row = await statusOf(id);
    expect(row?.status).toBe("scheduled");
    expect(row?.scheduledAt?.getTime()).toBe(at.getTime());
    expect(enq.find((e) => e.id === id)?.startAfter?.getTime()).toBe(at.getTime());
  });

  it("422s scheduled_at without send: true", async () => {
    const res = await post(tokenA, {
      ...draftBody(),
      scheduled_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ name: "validation_error" });
  });

  it("send: true with a relative scheduled_at resolves it against now", async () => {
    const before = Date.now();
    const res = await post(tokenA, { ...draftBody(), send: true, scheduled_at: "in 2 days" });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const row = await statusOf(id);
    expect(row?.status).toBe("scheduled");
    const at = row?.scheduledAt?.getTime() ?? 0;
    expect(at).toBeGreaterThanOrEqual(before + 2 * 86_400_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 2 * 86_400_000);
  });

  it("422s a scheduled_at more than 30 days out or unparseable", async () => {
    for (const scheduled_at of [
      new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
      "in 2 weeks",
      "tomorrow",
    ]) {
      const res = await post(tokenA, { ...draftBody(), send: true, scheduled_at });
      expect(res.status, scheduled_at).toBe(422);
    }
  });

  it("422s when APP_BASE_URL is not configured, keeping the draft", async () => {
    const bare = createApi({
      db,
      keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
      isCloud: true,
      enqueueEmailSend: async () => {},
      enqueueBroadcastSend: async () => {},
    });
    const res = await post(tokenA, { ...draftBody(), subject: "no-base-url", send: true }, bare);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      name: "validation_error",
      message: expect.stringContaining("APP_BASE_URL"),
    });
    const [row] = await db
      .select({ status: schema.broadcasts.status })
      .from(schema.broadcasts)
      .where(
        and(eq(schema.broadcasts.teamId, teamA), eq(schema.broadcasts.subject, "no-base-url")),
      );
    expect(row?.status).toBe("draft");
  });

  it("403s sending_paused, keeping the draft unsent", async () => {
    const { teamId, token } = await makeSendableTeam("bc-create-paused");
    await db.insert(schema.usageCounters).values({
      teamId,
      day: utcDay(),
      sent: 2000,
      complained: 5,
    });
    const res = await post(token, { ...draftBody(), subject: "paused-create", send: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ statusCode: 403, name: "sending_paused" });
    const [row] = await db
      .select({ id: schema.broadcasts.id, status: schema.broadcasts.status })
      .from(schema.broadcasts)
      .where(
        and(eq(schema.broadcasts.teamId, teamId), eq(schema.broadcasts.subject, "paused-create")),
      );
    expect(row?.status).toBe("draft");
    expect(enq.map((e) => e.id)).not.toContain(row?.id);
  });

  it("422s an unverified sender domain, keeping the draft", async () => {
    const res = await post(tokenA, {
      ...draftBody(),
      from: "Other <hi@unverified-create.dev>",
      send: true,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      name: "validation_error",
      message: expect.stringContaining("not verified"),
    });
    const [row] = await db
      .select({ status: schema.broadcasts.status })
      .from(schema.broadcasts)
      .where(eq(schema.broadcasts.from, "Other <hi@unverified-create.dev>"));
    expect(row?.status).toBe("draft");
  });
});

describe("domain-scoped keys cannot cross domains on broadcasts", () => {
  let scopedToken: string;
  let fullToken: string;
  let scopeTeam: string;
  let enq: string[];
  let scopedApp: ReturnType<typeof createApi>;
  const fromOther = "Other <hi@other-scope.dev>";

  const req = (token: string, method: string, path: string, body?: unknown) =>
    scopedApp.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const draft = (from: string) => ({ from, subject: "hi", html: "<p>hi</p>" });

  beforeAll(async () => {
    const team = await makeSendableTeam("bc-scope");
    scopeTeam = team.teamId;
    fullToken = team.token;
    const [acme] = await db
      .select({ id: schema.domains.id })
      .from(schema.domains)
      .where(eq(schema.domains.teamId, scopeTeam));
    if (!acme) throw new Error("seed missing");
    await db.insert(schema.domains).values({
      teamId: scopeTeam,
      name: "other-scope.dev",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
    });
    const key = generateApiKey();
    scopedToken = key.token;
    await db.insert(schema.apiKeys).values({
      teamId: scopeTeam,
      name: "scoped",
      tokenPrefix: key.tokenPrefix,
      keyHash: key.keyHash,
      last4: key.last4,
      domainId: acme.id,
    });
    enq = [];
    scopedApp = createApi({
      db,
      keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
      isCloud: true,
      enqueueEmailSend: async () => {},
      enqueueBroadcastSend: async (id) => {
        enq.push(id);
      },
      appBaseUrl: "https://app.example.test",
    });
  });

  it("403s a scoped key creating from another domain, staging nothing", async () => {
    const before = await db
      .select({ id: schema.broadcasts.id })
      .from(schema.broadcasts)
      .where(and(eq(schema.broadcasts.teamId, scopeTeam), eq(schema.broadcasts.from, fromOther)));
    const res = await req(scopedToken, "POST", "/broadcasts", draft(fromOther));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ statusCode: 403, name: "restricted_api_key" });
    const after = await db
      .select({ id: schema.broadcasts.id })
      .from(schema.broadcasts)
      .where(and(eq(schema.broadcasts.teamId, scopeTeam), eq(schema.broadcasts.from, fromOther)));
    expect(after.length).toBe(before.length);
  });

  it("403s a scoped key using send-on-create from another domain", async () => {
    const res = await req(scopedToken, "POST", "/broadcasts", {
      ...draft(fromOther),
      send: true,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ statusCode: 403, name: "restricted_api_key" });
    expect(enq).toHaveLength(0);
  });

  it("403s a scoped key sending from another domain, leaving it unsent", async () => {
    const [bc] = await db
      .insert(schema.broadcasts)
      .values({ teamId: scopeTeam, from: fromOther, subject: "s", html: "<p>hi</p>" })
      .returning({ id: schema.broadcasts.id });
    if (!bc) throw new Error("insert failed");
    const res = await req(scopedToken, "POST", `/broadcasts/${bc.id}/send`, {});
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ statusCode: 403, name: "restricted_api_key" });
    const [row] = await db
      .select({ status: schema.broadcasts.status })
      .from(schema.broadcasts)
      .where(eq(schema.broadcasts.id, bc.id));
    expect(row?.status).toBe("draft");
    expect(enq).not.toContain(bc.id);
  });

  it("lets the scoped key send from its own domain", async () => {
    const [bc] = await db
      .insert(schema.broadcasts)
      .values({ teamId: scopeTeam, from: "Acme <hi@acme.dev>", subject: "s", html: "<p>hi</p>" })
      .returning({ id: schema.broadcasts.id });
    if (!bc) throw new Error("insert failed");
    const res = await req(scopedToken, "POST", `/broadcasts/${bc.id}/send`, {});
    expect(res.status).toBe(200);
    expect(enq).toContain(bc.id);
  });

  it("leaves a full, unscoped key free to cross domains", async () => {
    const created = await req(fullToken, "POST", "/broadcasts", draft(fromOther));
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    const sent = await req(fullToken, "POST", `/broadcasts/${id}/send`, {});
    expect(sent.status).toBe(200);
    expect(enq).toContain(id);
  });
});
