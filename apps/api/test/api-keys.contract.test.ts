import { randomBytes } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { Resend } from "resend";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

/**
 * Wire-compat gate for API-key management: the official `resend` npm SDK
 * against a live MillionSend API — apiKeys.create/list/remove, the once-only
 * token, domain scoping, and revocation taking effect immediately.
 */

let db: Db;
let closeDb: () => Promise<void>;
let server: ServerType;
let resend: Resend;
let teamId: string;
let baseUrl: string;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  teamId = await createTeam(db, "apikeys-contract");
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "bootstrap",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  const app = createApi({ db, keyring, isCloud: true, enqueueEmailSend: async () => {} });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
  resend = new Resend(key.token, { baseUrl });
});

afterAll(async () => {
  server.close();
  await closeDb();
});

describe("official resend SDK: apiKeys", () => {
  let createdId: string;

  it("creates a key and returns the token exactly once", async () => {
    const created = await resend.apiKeys.create({ name: "ci-key" });
    expect(created.error).toBeNull();
    expect(created.data?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.data?.token).toMatch(/^ms_/);
    createdId = created.data?.id ?? "";

    // The new token authenticates in its own right.
    const minted = new Resend(created.data?.token ?? "", { baseUrl });
    const listed = await minted.apiKeys.list();
    expect(listed.error).toBeNull();
  });

  it("lists keys in the list envelope, without tokens", async () => {
    const listed = await resend.apiKeys.list();
    expect(listed.error).toBeNull();
    expect(listed.data?.object).toBe("list");
    expect(listed.data?.has_more).toBe(false);
    const row = listed.data?.data.find((k) => k.id === createdId);
    expect(row).toMatchObject({ name: "ci-key", created_at: expect.any(String) });
    expect(JSON.stringify(listed.data)).not.toContain("ms_");

    const page = await resend.apiKeys.list({ limit: 1 });
    expect(page.data?.data).toHaveLength(1);
    expect(page.data?.has_more).toBe(true);
  });

  it("creates a sending_access key confined away from key management", async () => {
    const created = await resend.apiKeys.create({
      name: "send-only",
      permission: "sending_access",
    });
    expect(created.error).toBeNull();
    const restricted = new Resend(created.data?.token ?? "", { baseUrl });
    const denied = await restricted.apiKeys.list();
    expect(denied.data).toBeNull();
    expect(denied.error?.name).toBe("restricted_api_key");
  });

  it("scopes a key to a verified domain and rejects unverified ones", async () => {
    const [verified] = await db
      .insert(schema.domains)
      .values({
        teamId,
        name: "scoped.dev",
        region: "us-east-1",
        status: "verified",
        verifiedAt: new Date(),
      })
      .returning({ id: schema.domains.id });
    const [pending] = await db
      .insert(schema.domains)
      .values({ teamId, name: "pending.dev", region: "us-east-1", status: "pending" })
      .returning({ id: schema.domains.id });
    if (!verified || !pending) throw new Error("domain insert failed");

    const ok = await resend.apiKeys.create({ name: "scoped", domain_id: verified.id });
    expect(ok.error).toBeNull();

    const bad = await resend.apiKeys.create({ name: "scoped-bad", domain_id: pending.id });
    expect(bad.data).toBeNull();
    expect(bad.error?.name).toBe("validation_error");
    expect(bad.error?.statusCode).toBe(422);
  });

  it("removes a key: it disappears from the list and stops authenticating", async () => {
    const created = await resend.apiKeys.create({ name: "short-lived" });
    expect(created.error).toBeNull();
    const id = created.data?.id ?? "";
    const token = created.data?.token ?? "";

    const removed = await resend.apiKeys.remove(id);
    expect(removed.error).toBeNull();
    expect(removed.data).toMatchObject({ object: "api_key", id, deleted: true });

    const listed = await resend.apiKeys.list();
    expect(listed.data?.data.some((k) => k.id === id)).toBe(false);

    const revoked = new Resend(token, { baseUrl });
    const denied = await revoked.apiKeys.list();
    expect(denied.data).toBeNull();
    expect(denied.error?.name).toBe("invalid_api_key");

    // Removing an already-revoked key is a 404, like Resend.
    const again = await resend.apiKeys.remove(id);
    expect(again.error?.name).toBe("not_found");
  });
});
