import { randomBytes } from "node:crypto";
import { DAY_MS, EnvKeyring, generateApiKey, hashRecipient } from "@millionsend/core";
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

const base = { from: "Acme <a@acme.dev>", subject: "s", text: "t" };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "sec-team");
  await db.insert(schema.domains).values({
    teamId,
    name: "acme.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  await db.insert(schema.domains).values({
    teamId,
    name: "pending.dev",
    region: "us-east-1",
    status: "pending",
  });
  const key = generateApiKey();
  token = key.token;
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "k",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  await db.insert(schema.suppressions).values({
    teamId,
    email: "bounced@example.com",
    emailHash: hashRecipient("bounced@example.com"),
    reason: "hard_bounce",
  });
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
  });
});
afterAll(() => close());

describe("sender domain enforcement", () => {
  it("rejects an unverified team domain", async () => {
    const res = await post({ ...base, from: "x@pending.dev", to: ["a@example.com"] });
    expect(res.status).toBe(422);
  });

  it("rejects a domain the team never added", async () => {
    const res = await post({ ...base, from: "ceo@victim.com", to: ["a@example.com"] });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ name: "validation_error" });
  });

  it("rejects a multi-mailbox From spoof outright", async () => {
    // A lenient parser could verify the last mailbox yet emit the first.
    for (const from of [
      "Acme <evil@evil.test> <ok@verified.test>",
      "Acme <evil@evil.test> <ok@acme.dev>",
      "evil@evil.test <ok@acme.dev>",
      "evil@evil.test, ok@acme.dev",
    ]) {
      const res = await post({ ...base, from, to: ["a@example.com"] });
      expect(res.status, from).toBe(422);
      expect(await res.json()).toMatchObject({ name: "validation_error" });
    }
  });

  it("attributes accepted emails to the verified domain", async () => {
    const res = await post({ ...base, to: ["ok@example.com"] });
    const { id } = (await res.json()) as { id: string };
    const [row] = await db
      .select({ domainId: schema.emails.domainId })
      .from(schema.emails)
      .where(eq(schema.emails.id, id));
    expect(row?.domainId).toBeTruthy();
  });
});

describe("suppression hardening", () => {
  it("is not fooled by duplicate suppressed recipients", async () => {
    const res = await post({
      ...base,
      to: ["bounced@example.com", "bounced@example.com"],
    });
    expect(res.status).toBe(422);
  });

  it("strips suppressed recipients from partially-suppressed lists (to, cc, bcc)", async () => {
    const res = await post({
      ...base,
      to: ["ok@example.com", "bounced@example.com"],
      cc: ["bounced@example.com"],
      bcc: ["fine@example.com", "bounced@example.com"],
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const [row] = await db
      .select({ to: schema.emails.to, cc: schema.emails.cc, bcc: schema.emails.bcc })
      .from(schema.emails)
      .where(eq(schema.emails.id, id));
    expect(row?.to).toEqual(["ok@example.com"]);
    expect(row?.cc).toBeNull();
    expect(row?.bcc).toEqual(["fine@example.com"]);
  });
});

describe("resend-compat error surfaces", () => {
  it("rejects attachments loudly instead of stripping them", async () => {
    const res = await post({
      ...base,
      to: ["a@example.com"],
      attachments: [{ filename: "x.pdf", content: "..." }],
    });
    expect(res.status).toBe(422);
    expect((await res.json()) as object).toMatchObject({
      message: expect.stringMatching(/not yet supported/i),
    });
  });

  it("rejects headers and topic_id loudly instead of stripping them", async () => {
    const withHeaders = await post({
      ...base,
      to: ["a@example.com"],
      headers: { "X-Entity-Ref-ID": "1" },
    });
    expect(withHeaders.status).toBe(422);
    expect(await withHeaders.json()).toMatchObject({
      message: expect.stringMatching(/headers are not yet supported/),
    });

    const withTopic = await post({ ...base, to: ["a@example.com"], topic_id: "t_1" });
    expect(withTopic.status).toBe(422);
    expect(await withTopic.json()).toMatchObject({
      message: expect.stringMatching(/topic_id is not yet supported/),
    });
  });

  it("rejects invalid recipient addresses", async () => {
    for (const bad of ["", "not-an-email", [""], ["not-an-email"]]) {
      const res = await post({ ...base, to: bad });
      expect(res.status).toBe(422);
    }
  });

  it("stores and echoes scheduled_at", async () => {
    // Within the 30-day scheduling cap.
    const when = new Date(Date.now() + DAY_MS).toISOString();
    const res = await post({ ...base, to: ["later@example.com"], scheduled_at: when });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const read = await app.request(`/emails/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(((await read.json()) as { scheduled_at: string }).scheduled_at).toBe(when);
  });

  it("uses 409 with Resend's names for idempotency conditions", async () => {
    await post({ ...base, to: ["idem@example.com"] }, { "idempotency-key": "k-409" });
    const drift = await post(
      { ...base, to: ["other@example.com"] },
      { "idempotency-key": "k-409" },
    );
    expect(drift.status).toBe(409);
    expect(await drift.json()).toMatchObject({ name: "invalid_idempotent_request" });
  });
});

describe("idempotency resilience", () => {
  it("does not brick the key when the guarded request fails", async () => {
    // All recipients suppressed → 422 releases the freshly-claimed key.
    const first = await post(
      { ...base, to: ["bounced@example.com"] },
      { "idempotency-key": "k-brick" },
    );
    expect(first.status).toBe(422);
    // Same key immediately reusable with a sendable payload.
    const second = await post(
      { ...base, to: ["ok2@example.com"] },
      { "idempotency-key": "k-brick" },
    );
    expect(second.status).toBe(200);
  });

  it("replays suppressed-after-send requests instead of 422ing", async () => {
    const victim = "later-suppressed@example.com";
    const first = await post({ ...base, to: [victim] }, { "idempotency-key": "k-replay" });
    const { id } = (await first.json()) as { id: string };
    await db.insert(schema.suppressions).values({
      teamId,
      email: victim,
      emailHash: hashRecipient(victim),
      reason: "hard_bounce",
    });
    const retry = await post({ ...base, to: [victim] }, { "idempotency-key": "k-replay" });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { id: string }).id).toBe(id);
  });
});
