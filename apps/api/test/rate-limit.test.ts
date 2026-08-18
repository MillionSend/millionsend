import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let token: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const teamId = await createTeam(db, "rate-limit");
  const key = generateApiKey("live");
  token = key.token;
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "limited",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: false,
    rateLimitPerMinute: 2,
    enqueueEmailSend: async () => {},
  });
});

afterAll(() => close());

it("atomically limits each API key and returns a retry boundary", async () => {
  const call = () => app.request("/topics", { headers: { authorization: `Bearer ${token}` } });

  expect((await call()).status).toBe(200);
  expect((await call()).status).toBe(200);
  const limited = await call();
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(await limited.json()).toEqual({
    statusCode: 429,
    name: "rate_limit_exceeded",
    message: "Too many requests",
  });

  const [bucket] = await db.select().from(schema.apiRateLimits);
  expect(bucket?.count).toBe(3);
});
