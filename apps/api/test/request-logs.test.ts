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
  it("logs an authenticated request with content fields redacted and no headers", async () => {
    const res = await post(validBody);
    expect(res.status).toBe(200);
    const { id: emailId } = (await res.json()) as { id: string };

    const [row] = await waitForRows(1);
    expect(row).toMatchObject({
      teamId,
      method: "POST",
      path: "/emails",
      statusCode: 200,
    });
    expect(row?.requestBody).toMatchObject({
      from: validBody.from,
      subject: "s",
      html: "[redacted]",
      text: "[redacted]",
    });
    expect(row?.responseBody).toEqual({ id: emailId });
    // Headers are never stored — the API key must not appear anywhere in the row.
    expect(JSON.stringify(row)).not.toContain(token);
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

  it("stores a truncation marker instead of oversized bodies", async () => {
    await db.delete(schema.apiRequests);
    const res = await post({ ...validBody, subject: "x".repeat(20_000) });
    expect(res.status).toBe(200);

    const [row] = await waitForRows(1);
    expect(row?.requestBody).toEqual({ truncated: true });
    expect(row?.responseBody).toMatchObject({ id: expect.any(String) });
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
