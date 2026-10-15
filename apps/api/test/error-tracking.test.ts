import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApi } from "../src/app.js";

const h = vi.hoisted(() => ({ captureError: vi.fn(async () => {}) }));
vi.mock("@millionsend/core/error-tracking-node", () => ({ captureError: h.captureError }));

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

it("reports an unhandled error with its route pattern and the key's team, still answering in Resend's format", async () => {
  const teamId = await createTeam(db, "error-tracking");
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "k",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  const app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: false,
    enqueueEmailSend: async () => {},
  });
  const boom = new Error("boom");
  app.get("/topics/:id/boom", () => {
    throw boom;
  });
  vi.spyOn(console, "error").mockImplementation(() => {});

  const res = await app.request("/topics/abc/boom", {
    headers: { authorization: `Bearer ${key.token}` },
  });
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({
    statusCode: 500,
    name: "internal_server_error",
    message: "An unexpected error occurred",
  });
  expect(h.captureError).toHaveBeenCalledExactlyOnceWith(boom, {
    teamId,
    tags: { route: "/topics/:id/boom" },
  });
});

it("answers a malformed or non-JSON body as the caller's error, without reporting it", async () => {
  const teamId = await createTeam(db, "error-tracking-client");
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "k",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  const app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: false,
    enqueueEmailSend: async () => {},
  });
  h.captureError.mockClear();
  const auth = { authorization: `Bearer ${key.token}` };
  const malformed = await app.request("/emails", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: "{not json",
  });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({
    statusCode: 400,
    name: "invalid_parameter",
    message: "Malformed JSON in request body",
  });
  const text = await app.request("/emails", {
    method: "POST",
    headers: { ...auth, "content-type": "text/plain" },
    body: "{}",
  });
  expect(text.status).toBe(415);
  expect(await text.json()).toMatchObject({ statusCode: 415, name: "invalid_parameter" });
  expect(h.captureError).not.toHaveBeenCalled();
});

it("answers an unknown route or method in Resend's format, after authentication", async () => {
  const teamId = await createTeam(db, "error-tracking-not-found");
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "k",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  const app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: false,
    enqueueEmailSend: async () => {},
  });
  h.captureError.mockClear();
  const auth = { authorization: `Bearer ${key.token}` };
  for (const [method, path, headers] of [
    ["GET", "/inboxes/00000000-0000-4000-8000-000000000000/nope", auth],
    ["PUT", "/emails", auth],
    ["GET", "/nope", {}],
  ] as const) {
    const res = await app.request(path, { method, headers });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      statusCode: 404,
      name: "not_found",
      message: "The requested endpoint does not exist.",
    });
  }
  expect((await app.request("/inboxes/x/nope")).status).toBe(401);
  expect(h.captureError).not.toHaveBeenCalled();
});
