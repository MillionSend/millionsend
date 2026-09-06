import { randomBytes } from "node:crypto";
import { deriveUnsubscribeKey, EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApi } from "../src/app.js";
import { LOGGED_JSON_MAX_BYTES, redactLoggedBody } from "../src/request-log.js";

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
// What the log keeps of validBody: every content field is a size marker.
const loggedValidBody = {
  ...validBody,
  html: "[html, 13 B]",
  text: "[text, 6 B]",
};

async function post(body: unknown, headers: Record<string, string> = {}) {
  return app.request("/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
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

async function call(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
    appBaseUrl: "https://app.example.com",
    unsubscribeSecretKey: deriveUnsubscribeKey(randomBytes(32)),
  });
});
afterAll(() => close());

describe("redactLoggedBody", () => {
  it("replaces content fields with size markers and secrets with a fixed marker, keeps the rest", () => {
    expect(
      redactLoggedBody("/webhooks", {
        to: ["r@example.com"],
        html: "é".repeat(6_000),
        nested: [{ text: "x", token: "t", signing_secret: "s", previous_secret: "p", url: "u" }],
        attachments: [{ filename: "a.pdf", content: "Q".repeat(850 * 1024) }],
        content: "not an attachment",
        password: null,
        properties: { plan: "pro" },
      }),
    ).toEqual({
      to: ["r@example.com"],
      html: "[html, 11.7 KB]",
      nested: [
        {
          text: "[text, 1 B]",
          token: "[redacted]",
          signing_secret: "[redacted]",
          previous_secret: "[redacted]",
          url: "u",
        },
      ],
      attachments: [{ filename: "a.pdf", content: "[attachment content, 850 KB]" }],
      content: "not an attachment",
      password: null,
      properties: { plan: "pro" },
    });
  });

  it("treats url as a secret only on preferences-link paths", () => {
    expect(redactLoggedBody("/contacts/[email]/preferences-link", { url: "u" })).toEqual({
      url: "[redacted]",
    });
  });
});

describe("api request logging", () => {
  it("logs a successful send: redacted request body, {id} response, no headers", async () => {
    const res = await post(validBody);
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    const [row] = await waitForRows(1);
    expect(row).toMatchObject({
      teamId,
      method: "POST",
      path: "/emails",
      statusCode: 200,
      requestBody: loggedValidBody,
      responseBody: { id },
    });
    // Neither the API key nor any content lands in the row.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("secret");
  });

  it("stores both bodies for failed requests too", async () => {
    await db.delete(schema.apiRequests);
    const res = await post({ ...validBody, html: undefined, text: undefined });
    expect(res.status).toBe(422);

    const [row] = await waitForRows(1);
    expect(row?.statusCode).toBe(422);
    expect(row?.requestBody).toEqual({ from: validBody.from, to: validBody.to, subject: "s" });
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
    expect(row?.requestBody).toBeNull();
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

  it("replaces content in a read-back response (GET /emails/{id} serves decrypted content)", async () => {
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
    expect(logged?.responseBody).toMatchObject({
      id,
      to: ["readback@example.com"],
      html: "[html, 13 B]",
      text: "[text, 6 B]",
    });
    expect(JSON.stringify(rows)).not.toContain("secret");
  });

  it("logs batch bodies item by item", async () => {
    await db.delete(schema.apiRequests);
    const res = await postBatch([validBody, { ...validBody, to: ["second@example.com"] }]);
    expect(res.status).toBe(200);

    const [row] = await waitForRows(1);
    expect(row).toMatchObject({
      path: "/emails/batch",
      requestBody: [loggedValidBody, { ...loggedValidBody, to: ["second@example.com"] }],
      responseBody: { data: [{ id: expect.any(String) }, { id: expect.any(String) }] },
    });
  });

  it("keeps an attachment's filename but not its content", async () => {
    await db.delete(schema.apiRequests);
    const content = Buffer.from("%PDF-1.4 fake pdf bytes").toString("base64");
    const res = await post({
      ...validBody,
      attachments: [{ filename: "x.pdf", content, content_type: "application/pdf" }],
    });
    expect(res.status).toBe(200);

    const [row] = await waitForRows(1);
    expect(row?.requestBody).toMatchObject({
      attachments: [
        {
          filename: "x.pdf",
          content: "[attachment content, 32 B]",
          content_type: "application/pdf",
        },
      ],
    });
    expect(JSON.stringify(row)).not.toContain(content);
  });

  it("redacts the capability url of a preferences link", async () => {
    await db.delete(schema.apiRequests);
    const created = await call("POST", "/contacts", { email: "prefs@example.com" });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    const res = await call("POST", `/contacts/${id}/preferences-link`);
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };

    const rows = await waitForRows(2);
    const link = rows.find((r) => r.path.endsWith("/preferences-link"));
    expect(link?.responseBody).toEqual({
      object: "preferences_link",
      contact: id,
      url: "[redacted]",
    });
    expect(JSON.stringify(rows)).not.toContain(url);
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

  it("stores a truncation marker with the size instead of a body over the cap", async () => {
    await db.delete(schema.apiRequests);
    const res = await post({ ...validBody, headers: { "X-Entity-Ref-ID": "v".repeat(70_000) } });
    expect(res.status).toBe(200);

    const [row] = await waitForRows(1);
    const marker = row?.requestBody as { truncated: boolean; bytes: number };
    expect(marker).toEqual({ truncated: true, bytes: expect.any(Number) });
    expect(marker.bytes).toBeGreaterThan(LOGGED_JSON_MAX_BYTES);
    expect(row?.responseBody).toEqual({ id: expect.any(String) });
  });

  it("caps oversized error bodies the same way", async () => {
    await db.delete(schema.apiRequests);
    // The validation message echoes the offending header name.
    const res = await post({ ...validBody, headers: { ["Y".repeat(70_000)]: "v" } });
    expect(res.status).toBe(422);

    const [row] = await waitForRows(1);
    expect(row?.responseBody).toEqual({ truncated: true, bytes: expect.any(Number) });
  });

  it("never reads a request body declared over 1 MiB: the marker carries the declared size", async () => {
    await db.delete(schema.apiRequests);
    const declared = 2 * 1024 * 1024;
    const res = await post(validBody, { "content-length": String(declared) });
    expect(res.status).toBe(200);

    const [row] = await waitForRows(1);
    expect(row?.requestBody).toEqual({ truncated: true, bytes: declared });
    expect(row?.requestBytes).toBe(declared);
  });

  it("stores null for a non-JSON response", async () => {
    await db.delete(schema.apiRequests);
    // Authenticated but unrouted: Hono answers with a text/plain 404.
    const res = await call("GET", "/emails/x/y");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toContain("json");

    const [row] = await waitForRows(1);
    expect(row).toMatchObject({ statusCode: 404, requestBody: null, responseBody: null });
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
