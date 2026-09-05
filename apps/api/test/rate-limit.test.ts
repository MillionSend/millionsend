import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let token: string;
let teamId: string;

async function insertKey(team: string): Promise<string> {
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId: team,
    name: "limited",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  return key.token;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "rate-limit");
  token = await insertKey(teamId);
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: false,
    rateLimitPerMinute: 2,
    enqueueEmailSend: async () => {},
  });
});

afterAll(() => close());

// The limiter counts in fixed minute windows; a test whose calls straddle a
// boundary sees a fresh window and no 429. Wait out the last seconds of one.
beforeEach(async () => {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 3_000) await new Promise((resolve) => setTimeout(resolve, left));
});

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

it("caps a team across all of its keys, so minting keys cannot multiply the limit", async () => {
  const team = await createTeam(db, "team-cap");
  const keys = [await insertKey(team), await insertKey(team)];
  const teamApp = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: false,
    rateLimitPerMinute: 100,
    teamRateLimitPerMinute: 3,
    enqueueEmailSend: async () => {},
  });
  const call = (key: string) =>
    teamApp.request("/topics", { headers: { authorization: `Bearer ${key}` } });

  expect((await call(keys[0] ?? "")).status).toBe(200);
  expect((await call(keys[1] ?? "")).status).toBe(200);
  expect((await call(keys[0] ?? "")).status).toBe(200);
  const limited = await call(keys[1] ?? "");
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
});

it("throttles repeated authentication failures per client IP (cloud reads cf-connecting-ip)", async () => {
  const cloudApp = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
  });
  const fail = (ip: string) =>
    cloudApp.request("/emails", {
      headers: { authorization: "Bearer ms_nopenopenopenope", "cf-connecting-ip": ip },
    });
  let last: Response | undefined;
  for (let i = 0; i < 20; i++) {
    last = await fail("203.0.113.7");
    expect(last.status).toBe(401);
  }
  const limited = await fail("203.0.113.7");
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(await limited.json()).toMatchObject({ name: "rate_limit_exceeded" });
  // Another address is untouched, and a valid key from the throttled one still works.
  expect((await fail("203.0.113.8")).status).toBe(401);
  const ok = await cloudApp.request("/topics", {
    headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": "203.0.113.7" },
  });
  expect(ok.status).toBe(200);
});
