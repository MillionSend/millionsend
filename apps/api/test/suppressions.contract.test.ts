import { randomBytes } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import { EnvKeyring, generateApiKey, hashRecipient } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { Resend, type SuppressionOrigin } from "resend";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

/**
 * Wire-compat gate for suppressions: the official `resend` npm SDK against a
 * live MillionSend API — add/list/get/remove by id and by email, plus
 * suppressions.batch.add/remove.
 */

let db: Db;
let closeDb: () => Promise<void>;
let server: ServerType;
let resend: Resend;
let teamId: string;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  teamId = await createTeam(db, "suppressions-contract");
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "contract",
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
  resend = new Resend(key.token, { baseUrl: `http://127.0.0.1:${address.port}` });
});

afterAll(async () => {
  server.close();
  await closeDb();
});

describe("official resend SDK: suppressions", () => {
  let suppressionId: string;

  it("adds a suppression, idempotently", async () => {
    const added = await resend.suppressions.add({ email: "Contract@Example.com" });
    expect(added.error).toBeNull();
    expect(added.data).toEqual({ object: "suppression", id: expect.any(String) });
    suppressionId = added.data?.id ?? "";

    const again = await resend.suppressions.add({ email: "contract@example.com" });
    expect(again.data?.id).toBe(suppressionId);
  });

  it("gets the suppression by id and by email", async () => {
    const expected = {
      object: "suppression",
      id: suppressionId,
      email: "contract@example.com",
      origin: "manual",
      source_id: null,
      created_at: expect.any(String),
    };
    const byId = await resend.suppressions.get(suppressionId);
    expect(byId.error).toBeNull();
    expect(byId.data).toEqual(expected);

    const byEmail = await resend.suppressions.get("contract@example.com");
    expect(byEmail.error).toBeNull();
    expect(byEmail.data).toEqual(expected);
  });

  it("lists suppressions, filtered by origin", async () => {
    await db.insert(schema.suppressions).values({
      teamId,
      email: "bounced@example.com",
      emailHash: hashRecipient("bounced@example.com"),
      reason: "hard_bounce",
    });

    const listed = await resend.suppressions.list({ limit: 100 });
    expect(listed.error).toBeNull();
    expect(listed.data?.object).toBe("list");
    expect(listed.data?.has_more).toBe(false);
    expect(listed.data?.data).toEqual([
      {
        id: suppressionId,
        email: "contract@example.com",
        origin: "manual",
        source_id: null,
        created_at: expect.any(String),
      },
      {
        id: expect.any(String),
        email: "bounced@example.com",
        origin: "bounce",
        source_id: null,
        created_at: expect.any(String),
      },
    ]);

    const bounces = await resend.suppressions.list({ origin: "bounce" });
    expect(bounces.data?.data.map((r) => r.email)).toEqual(["bounced@example.com"]);

    // Superset origin value beyond the SDK's own union.
    const unsubscribes = await resend.suppressions.list({
      origin: "unsubscribe" as SuppressionOrigin,
    });
    expect(unsubscribes.error).toBeNull();
    expect(unsubscribes.data?.data).toEqual([]);
  });

  it("422s an unknown origin filter", async () => {
    const bad = await resend.suppressions.list({ origin: "hard_bounce" as SuppressionOrigin });
    expect(bad.data).toBeNull();
    expect(bad.error).toMatchObject({ statusCode: 422, name: "validation_error" });
  });

  it("batch-adds addresses, returning one id per distinct address in order", async () => {
    const added = await resend.suppressions.batch.add({
      emails: ["batch-1@example.com", "BATCH-1@example.com", "batch-2@example.com"],
    });
    expect(added.error).toBeNull();
    expect(added.data?.data).toEqual([
      { object: "suppression", id: expect.any(String) },
      { object: "suppression", id: expect.any(String) },
    ]);
    const one = await resend.suppressions.get("batch-1@example.com");
    expect(one.data?.id).toBe(added.data?.data[0]?.id);
  });

  it("batch-removes by emails and by ids", async () => {
    const byEmails = await resend.suppressions.batch.remove({
      emails: ["batch-1@example.com", "never-added@example.com"],
    });
    expect(byEmails.error).toBeNull();
    expect(byEmails.data?.data).toEqual([
      { object: "suppression", id: expect.any(String), deleted: true },
    ]);

    const two = await resend.suppressions.get("batch-2@example.com");
    const byIds = await resend.suppressions.batch.remove({ ids: [two.data?.id ?? ""] });
    expect(byIds.error).toBeNull();
    expect(byIds.data?.data).toEqual([{ object: "suppression", id: two.data?.id, deleted: true }]);
    expect((await resend.suppressions.get("batch-2@example.com")).error?.name).toBe("not_found");
  });

  it("removes the suppression by email, then 404s", async () => {
    const removed = await resend.suppressions.remove("contract@example.com");
    expect(removed.error).toBeNull();
    expect(removed.data).toEqual({ object: "suppression", id: suppressionId, deleted: true });

    const gone = await resend.suppressions.get(suppressionId);
    expect(gone.data).toBeNull();
    expect(gone.error?.name).toBe("not_found");
  });
});
