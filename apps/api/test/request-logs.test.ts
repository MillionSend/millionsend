import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let teamId: string;
let token: string;

const validBody = {
  from: "Acme <a@acme.dev>",
  to: ["r@example.com"],
  subject: "s",
  html: "<p>secret</p>",
  text: "secret",
};

async function post(body: unknown) {
  return app.request("/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postBatch(body: unknown) {
  return app.request("/emails/batch", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function loggedRows() {
  return db.select().from(schema.apiRequests).orderBy(schema.apiRequests.createdAt);
}

/** The middleware inserts fire-and-forget; wait until the expected count lands. */
async function waitForRows(count: number) {
  return vi.waitFor(async () => {
    const rows = await loggedRows();
    expect(rows).toHaveLength(count);
    return rows;
  });
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "logs-team");
  await db.insert(schema.domains).values({
    teamId,
    name: "acme.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  const key = generateApiKey();
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
    isCloud: false,
    enqueueEmailSend: async () => {},
    sns: {
      allowedTopicArns: [],
      fetchCert: async () => "",
      enqueueSesEvent: async () => {},
    },
  });
});
afterAll(() => close());

describe("api request logging", () => {
  it("logs an authenticated request as metadata only: no bodies, no headers", async () => {
    const res = await post(validBody);
    expect(res.status).toBe(200);

    const [row] = await waitForRows(1);
    expect(row).toMatchObject({
      teamId,
      method: "POST",
      path: "/emails",
      statusCode: 200,
      requestBody: null,
      responseBody: null,
    });
    // Neither the API key nor any recipient/content lands in the row.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("r@example.com");
    expect(serialized).not.toContain("secret");
  });

  it("stores the API's own error body for failed requests, still no request body", async () => {
    await db.delete(schema.apiRequests);
    const res = await post({ ...validBody, html: undefined, text: undefined });
    expect(res.status).toBe(422);

    const [row] = await waitForRows(1);
    expect(row?.statusCode).toBe(422);
    expect(row?.requestBody).toBeNull();
    expect(row?.responseBody).toMatchObject({ statusCode: 422, name: "validation_error" });
  });

  it("masks email path segments", async () => {
    await db.delete(schema.apiRequests);
    const res = await app.request("/contacts/someone%40example.com", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    const [row] = await waitForRows(1);
    expect(row?.path).toBe("/contacts/[email]");
    expect(JSON.stringify(row)).not.toContain("someone");
  });

  it("skips unauthenticated requests and the SNS endpoint", async () => {
    await db.delete(schema.apiRequests);

    const unauthed = await app.request("/emails", { method: "POST" });
    expect(unauthed.status).toBe(401);
    const sns = await app.request("/ses/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonsense: true }),
    });
    expect(sns.status).toBe(400);

    // A logged request after both proves the writes above had settled: only
    // the authenticated one lands.
    const res = await post({ ...validBody, to: ["settle@example.com"] });
    expect(res.status).toBe(200);
    const rows = await waitForRows(1);
    expect(rows[0]?.path).toBe("/emails");
    expect(rows[0]?.statusCode).toBe(200);
  });

  it("never stores a success response body (GET /emails/{id} serves decrypted content)", async () => {
    await db.delete(schema.apiRequests);
    const res = await post({ ...validBody, to: ["readback@example.com"] });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    const read = await app.request(`/emails/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.status).toBe(200);
    // The live response still serves the decrypted content...
    expect(await read.json()).toMatchObject({ html: "<p>secret</p>", text: "secret" });

    // ...but the log must not become a plaintext copy of the encrypted body.
    const rows = await waitForRows(2);
    const logged = rows.find((r) => r.method === "GET");
    expect(logged?.responseBody).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("secret");
  });

  it("stores no body for batch requests either", async () => {
    await db.delete(schema.apiRequests);
    const res = await postBatch([validBody, { ...validBody, to: ["second@example.com"] }]);
    expect(res.status).toBe(200);

    const [row] = await waitForRows(1);
    expect(row).toMatchObject({ path: "/emails/batch", requestBody: null, responseBody: null });
  });

  it("rejects oversized bodies before authentication or parsing", async () => {
    await db.delete(schema.apiRequests);
    const res = await app.request("/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": String(25 * 1024 * 1024 + 1),
      },
      body: "{}",
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      statusCode: 413,
      name: "payload_too_large",
      message: "Request body exceeds 25 MiB",
    });
    expect(await loggedRows()).toHaveLength(0);
  });

  it("stores a truncation marker instead of an oversized error body", async () => {
    await db.delete(schema.apiRequests);
    // The validation message echoes the offending header name.
    const res = await post({ ...validBody, headers: { ["Y".repeat(20_000)]: "v" } });
    expect(res.status).toBe(422);

    const [row] = await waitForRows(1);
    expect(row?.responseBody).toEqual({ truncated: true });
  });

  // Kept last: it destroys the api_requests table for this suite's db.
  it("never fails the response when the log insert fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await db.execute(sql`drop table api_requests`);

    const res = await post({ ...validBody, to: ["still-works@example.com"] });
    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(errors).toHaveBeenCalledWith("api request log failed", expect.anything());
    });
    errors.mockRestore();
  });
});
