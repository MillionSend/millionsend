import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let teamId: string;
let otherTeamId: string;
let fullKey: string;
let sendKey: string;
let otherTeamKey: string;
let verifiedDomainId: string;
let pendingDomainId: string;
let otherTeamDomainId: string;

function call(token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function insertKey(
  team: string,
  overrides: Partial<typeof schema.apiKeys.$inferInsert> = {},
) {
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId: team,
    name: "seed",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
    ...overrides,
  });
  return key.token;
}

async function insertDomain(team: string, name: string, status: "verified" | "pending") {
  const [row] = await db
    .insert(schema.domains)
    .values({ teamId: team, name, region: "us-east-1", status })
    .returning({ id: schema.domains.id });
  if (!row) throw new Error("domain insert failed");
  return row.id;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "keys-team");
  otherTeamId = await createTeam(db, "keys-other-team");
  fullKey = await insertKey(teamId);
  sendKey = await insertKey(teamId, { permission: "sending_access" });
  otherTeamKey = await insertKey(otherTeamId);
  verifiedDomainId = await insertDomain(teamId, "verified.example.com", "verified");
  pendingDomainId = await insertDomain(teamId, "pending.example.com", "pending");
  otherTeamDomainId = await insertDomain(otherTeamId, "other.example.com", "verified");

  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: false,
    enqueueEmailSend: async () => {},
  });
});
afterAll(() => close());

describe("POST /api-keys", () => {
  it("returns the token exactly once, storing only prefix + hash + last4", async () => {
    const res = await call(fullKey, "POST", "/api-keys", { name: "ci" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; token: string };
    expect(body.token).toMatch(/^ms_/);

    const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, body.id));
    expect(row).toMatchObject({ teamId, name: "ci", permission: "full_access", domainId: null });
    // No column of the persisted row contains the secret.
    for (const [column, value] of Object.entries(row ?? {})) {
      expect(String(value), `column ${column}`).not.toBe(body.token);
    }
    expect(row?.last4).toBe(body.token.slice(-4));

    // The new key authenticates.
    const authed = await call(body.token, "GET", "/api-keys");
    expect(authed.status).toBe(200);

    // The fire-and-forget request log must not become a copy of the secret.
    await vi.waitFor(async () => {
      const logs = await db
        .select()
        .from(schema.apiRequests)
        .where(eq(schema.apiRequests.path, "/api-keys"));
      const created = logs.find((l) => l.method === "POST" && l.statusCode === 200);
      expect(created).toBeDefined();
      expect(created?.responseBody).toMatchObject({ id: body.id, token: "[redacted]" });
      expect(JSON.stringify(created)).not.toContain(body.token);
    });
  });

  it("creates sending_access keys", async () => {
    const res = await call(fullKey, "POST", "/api-keys", {
      name: "sender",
      permission: "sending_access",
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id));
    expect(row?.permission).toBe("sending_access");
  });

  it("scopes a key to a verified team domain via domain_id", async () => {
    const res = await call(fullKey, "POST", "/api-keys", {
      name: "scoped",
      domain_id: verifiedDomainId,
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id));
    expect(row?.domainId).toBe(verifiedDomainId);
  });

  it("422s an unverified or foreign domain_id", async () => {
    for (const domainId of [pendingDomainId, otherTeamDomainId, crypto.randomUUID()]) {
      const res = await call(fullKey, "POST", "/api-keys", { name: "bad", domain_id: domainId });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ statusCode: 422, name: "validation_error" });
    }
  });

  it("422s a blank or oversized name", async () => {
    expect((await call(fullKey, "POST", "/api-keys", { name: "  " })).status).toBe(422);
    expect((await call(fullKey, "POST", "/api-keys", { name: "x".repeat(81) })).status).toBe(422);
  });
});

describe("GET /api-keys", () => {
  it("lists only the caller team's live keys, never tokens or hashes", async () => {
    const res = await call(fullKey, "GET", "/api-keys");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      has_more: boolean;
      data: Record<string, unknown>[];
    };
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
    for (const item of body.data) {
      // Exactly the oracle's masked item shape — no token, prefix, or hash.
      expect(Object.keys(item).sort()).toEqual(["created_at", "id", "last_used_at", "name"]);
    }
    expect(JSON.stringify(body)).not.toContain(fullKey);

    const foreign = await call(otherTeamKey, "GET", "/api-keys");
    const foreignBody = (await foreign.json()) as { data: { id: string }[] };
    const ours = new Set(body.data.map((k) => k.id));
    expect(foreignBody.data.every((k) => !ours.has(k.id))).toBe(true);
  });

  it("paginates with keyset cursors", async () => {
    const first = await call(fullKey, "GET", "/api-keys?limit=1");
    const firstBody = (await first.json()) as { data: { id: string }[]; has_more: boolean };
    expect(firstBody.data).toHaveLength(1);
    expect(firstBody.has_more).toBe(true);

    const next = await call(fullKey, "GET", `/api-keys?limit=100&after=${firstBody.data[0]?.id}`);
    const nextBody = (await next.json()) as { data: { id: string }[] };
    expect(nextBody.data.some((k) => k.id === firstBody.data[0]?.id)).toBe(false);
  });
});

describe("DELETE /api-keys/{id}", () => {
  it("revokes the key so it stops authenticating and leaves the list", async () => {
    const created = await call(fullKey, "POST", "/api-keys", { name: "doomed" });
    const { id, token } = (await created.json()) as { id: string; token: string };

    const res = await call(fullKey, "DELETE", `/api-keys/${id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ object: "api_key", id, deleted: true });

    expect((await call(token, "GET", "/api-keys")).status).toBe(401);
    const list = await call(fullKey, "GET", "/api-keys?limit=100");
    const listBody = (await list.json()) as { data: { id: string }[] };
    expect(listBody.data.some((k) => k.id === id)).toBe(false);

    // Already revoked reads as gone.
    expect((await call(fullKey, "DELETE", `/api-keys/${id}`)).status).toBe(404);
  });

  it("404s a foreign team's key without revoking it", async () => {
    const created = await call(fullKey, "POST", "/api-keys", { name: "kept" });
    const { id } = (await created.json()) as { id: string };
    const res = await call(otherTeamKey, "DELETE", `/api-keys/${id}`);
    expect(res.status).toBe(404);
    const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id));
    expect(row?.revokedAt).toBeNull();
  });
});

describe("permission confinement", () => {
  it("403s a sending_access key on every /api-keys route", async () => {
    for (const [method, path, body] of [
      ["GET", "/api-keys", undefined],
      ["POST", "/api-keys", { name: "nope" }],
      ["DELETE", `/api-keys/${crypto.randomUUID()}`, undefined],
    ] as const) {
      const res = await call(sendKey, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toMatchObject({ statusCode: 403, name: "restricted_api_key" });
    }
  });
});
