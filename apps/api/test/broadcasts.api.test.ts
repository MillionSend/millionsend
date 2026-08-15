import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let tokenA: string;
let tokenB: string;
let teamA: string;
let audienceId: string;

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
  audience_id: audienceId,
  from: "Acme <hi@acme.dev>",
  subject: "hello",
  html: "<p>hi</p>",
});

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  for (const [slug, setToken] of [
    ["bc-team-a", (t: string) => (tokenA = t)],
    ["bc-team-b", (t: string) => (tokenB = t)],
  ] as const) {
    const teamId = await createTeam(db, slug);
    if (slug === "bc-team-a") teamA = teamId;
    const key = generateApiKey("live");
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
  const [audience] = await db
    .insert(schema.audiences)
    .values({ teamId: teamA, name: "news" })
    .returning({ id: schema.audiences.id });
  if (!audience) throw new Error("audience insert failed");
  audienceId = audience.id;
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

  it("422s a create without html or text, or without an audience", async () => {
    const { html: _html, ...noBody } = draftBody();
    expect((await call(tokenA, "POST", "/broadcasts", noBody)).status).toBe(422);
    const { audience_id: _aud, ...noAudience } = draftBody();
    expect((await call(tokenA, "POST", "/broadcasts", noAudience)).status).toBe(422);
  });

  it("rejects unsupported Resend knobs loudly instead of stripping them", async () => {
    for (const extra of [{ send: true }, { preview_text: "peek" }, { topic_id: "t_1" }]) {
      const res = await call(tokenA, "POST", "/broadcasts", { ...draftBody(), ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(422);
    }
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
        audienceId,
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

    // Team B cannot even create against team A's audience.
    const create = await call(tokenB, "POST", "/broadcasts", draftBody());
    expect(create.status).toBe(404);

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

  it("draft update cannot move the broadcast to a foreign audience", async () => {
    const [foreign] = await db
      .insert(schema.audiences)
      .values({ teamId: await createTeam(db, "bc-team-c"), name: "foreign" })
      .returning({ id: schema.audiences.id });
    const res = await call(tokenA, "PATCH", `/broadcasts/${broadcastId}`, {
      audience_id: foreign?.id,
    });
    expect(res.status).toBe(404);
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
