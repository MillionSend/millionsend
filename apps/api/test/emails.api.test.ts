import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey, hashRecipient } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let teamId: string;
let token: string;

async function post(body: unknown, headers: Record<string, string> = {}) {
  return app.request("/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const validBody = {
  from: "Acme <a@acme.dev>",
  to: ["r@example.com"],
  subject: "s",
  text: "t",
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "api-team");
  await db.insert(schema.domains).values({
    teamId,
    name: "acme.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  const key = generateApiKey("live");
  token = key.token;
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "t",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
  });
});
afterAll(() => close());

describe("auth", () => {
  it("401s without a key, with Resend's error shape", async () => {
    const res = await app.request("/emails", { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ statusCode: 401, name: "missing_api_key" });
  });
});

describe("send edge cases", () => {
  it("parks the 101st email of the day as queued_quota but still accepts it", async () => {
    // Free plan cap is 100/day; burn it, then send one more.
    for (let i = 0; i < 4; i++) {
      const res = await post({ ...validBody, to: [`bulk${i}@example.com`] });
      expect(res.status).toBe(200);
    }
    await db
      .update(schema.usageCounters)
      .set({ accepted: 100 })
      .where(eq(schema.usageCounters.teamId, teamId));
    const res = await post({ ...validBody, to: ["overflow@example.com"] });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const [row] = await db
      .select({ s: schema.emails.latestStatus })
      .from(schema.emails)
      .where(eq(schema.emails.id, id));
    expect(row?.s).toBe("queued_quota");
  });

  it("rejects when all recipients are suppressed", async () => {
    await db.insert(schema.suppressions).values({
      teamId,
      email: "dead@example.com",
      emailHash: hashRecipient("dead@example.com"),
      reason: "hard_bounce",
    });
    const res = await post({ ...validBody, to: ["dead@example.com"] });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ name: "validation_error" });
  });

  it("replays an idempotent send and conflicts on payload drift", async () => {
    const first = await post(validBody, { "idempotency-key": "same-key" });
    const { id } = (await first.json()) as { id: string };
    const replay = await post(validBody, { "idempotency-key": "same-key" });
    expect(((await replay.json()) as { id: string }).id).toBe(id);
    const drifted = await post(
      { ...validBody, subject: "different" },
      { "idempotency-key": "same-key" },
    );
    expect(drifted.status).toBe(409);
  });

  it("stores bodies encrypted at rest", async () => {
    const res = await post({ ...validBody, to: ["sealed@example.com"], html: "<p>secret</p>" });
    const { id } = (await res.json()) as { id: string };
    const [row] = await db
      .select({ ct: schema.emails.bodyCiphertext })
      .from(schema.emails)
      .where(eq(schema.emails.id, id));
    expect(row?.ct).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(row?.ct ?? []).includes("secret")).toBe(false);
  });

  it("is tenant-isolated on reads", async () => {
    const res = await post(validBody);
    const { id } = (await res.json()) as { id: string };
    const otherTeam = await createTeam(db, "intruder");
    const otherKey = generateApiKey("live");
    await db.insert(schema.apiKeys).values({
      teamId: otherTeam,
      name: "o",
      tokenPrefix: otherKey.tokenPrefix,
      keyHash: otherKey.keyHash,
      last4: otherKey.last4,
    });
    const stolen = await app.request(`/emails/${id}`, {
      headers: { authorization: `Bearer ${otherKey.token}` },
    });
    expect(stolen.status).toBe(404);
  });
});

describe("openapi", () => {
  it("serves the generated spec without auth", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/emails", "/emails/{id}"]));
  });
});
