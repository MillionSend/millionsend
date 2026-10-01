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
