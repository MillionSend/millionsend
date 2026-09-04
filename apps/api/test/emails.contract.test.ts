import { randomBytes, randomUUID } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { Resend } from "resend";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

/**
 * THE wire-compat gate: the official `resend` npm SDK, pointed at a live
 * MillionSend API via its own baseUrl option. If these fail, migration by
 * env-var (docs/resend-compatibility.md) is broken.
 */

let db: Db;
let closeDb: () => Promise<void>;
let server: ServerType;
let resend: Resend;
let teamId: string;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  teamId = await createTeam(db, "contract");
  await db.insert(schema.domains).values({
    teamId,
    name: "acme.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
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

describe("official resend SDK against MillionSend", () => {
  it("sends an email and reads it back", async () => {
    const sent = await resend.emails.send({
      from: "Acme <onboarding@acme.dev>",
      to: ["delivered@example.com"],
      subject: "hello world",
      html: "<p>oi</p>",
      text: "oi",
      tags: [{ name: "campaign", value: "welcome" }],
    });
    expect(sent.error).toBeNull();
    expect(sent.data?.id).toMatch(/^[0-9a-f-]{36}$/);

    const fetched = await resend.emails.get(sent.data?.id ?? "");
    expect(fetched.error).toBeNull();
    expect(fetched.data).toMatchObject({
      object: "email",
      to: ["delivered@example.com"],
      from: "Acme <onboarding@acme.dev>",
      subject: "hello world",
      html: "<p>oi</p>",
      last_event: "queued",
    });
  });

  it("surfaces validation errors in the SDK's error channel", async () => {
    const res = await resend.emails.send({
      from: "Acme <onboarding@acme.dev>",
      to: ["x@example.com"],
      subject: "no body",
      // no html, no text
    } as Parameters<typeof resend.emails.send>[0]);
    expect(res.data).toBeNull();
    expect(res.error?.name).toBe("validation_error");
  });

  it("rejects a bad key the way the SDK expects", async () => {
    const bad = new Resend("ms_test_definitelywrongkey12345678901", {
      baseUrl: resend.baseUrl as string,
    });
    const res = await bad.emails.send({
      from: "a@b.co",
      to: ["x@example.com"],
      subject: "s",
      text: "t",
    });
    expect(res.data).toBeNull();
    expect(res.error?.name).toBe("invalid_api_key");
  });

  it("sends a batch through resend.batch.send", async () => {
    const res = await resend.batch.send([
      { from: "Acme <onboarding@acme.dev>", to: ["a@example.com"], subject: "one", text: "1" },
      { from: "Acme <onboarding@acme.dev>", to: ["b@example.com"], subject: "two", text: "2" },
    ]);
    expect(res.error).toBeNull();
    expect(res.data?.data).toHaveLength(2);
    for (const item of res.data?.data ?? []) expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sends a permissive batch and reports per-item failures", async () => {
    const items = [
      { from: "Acme <onboarding@acme.dev>", to: ["p1@example.com"], subject: "ok", text: "1" },
      // Invalid: neither html nor text.
      { from: "Acme <onboarding@acme.dev>", to: ["p2@example.com"], subject: "bad" },
    ] as Parameters<typeof resend.batch.send>[0];
    const res = await resend.batch.send(items, { batchValidation: "permissive" } as const);
    expect(res.error).toBeNull();
    expect(res.data?.data).toHaveLength(1);
    expect(res.data?.errors).toEqual([
      { index: 1, message: expect.stringMatching(/html or text/) },
    ]);
  });

  it("reschedules a scheduled email through resend.emails.update", async () => {
    const scheduled = await resend.emails.send({
      from: "Acme <onboarding@acme.dev>",
      to: ["move-me@example.com"],
      subject: "scheduled",
      text: "later",
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(scheduled.error).toBeNull();
    const id = scheduled.data?.id ?? "";
    const updated = await resend.emails.update({ id, scheduledAt: "in 2 hours" });
    expect(updated.error).toBeNull();
    expect(updated.data).toMatchObject({ object: "email", id });
  });

  it("accepts a natural-language scheduled_at ('in 1 min')", async () => {
    const before = Date.now();
    const sent = await resend.emails.send({
      from: "Acme <onboarding@acme.dev>",
      to: ["soon@example.com"],
      subject: "soon",
      text: "soon",
      scheduledAt: "in 1 min",
    });
    expect(sent.error).toBeNull();
    const fetched = await resend.emails.get(sent.data?.id ?? "");
    expect(fetched.error).toBeNull();
    const at = new Date(fetched.data?.scheduled_at ?? "").getTime();
    expect(at).toBeGreaterThanOrEqual(before + 60_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("cancels a scheduled email through resend.emails.cancel", async () => {
    const scheduled = await resend.emails.send({
      from: "Acme <onboarding@acme.dev>",
      to: ["later@example.com"],
      subject: "scheduled",
      text: "later",
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(scheduled.error).toBeNull();
    const id = scheduled.data?.id ?? "";
    const canceled = await resend.emails.cancel(id);
    expect(canceled.error).toBeNull();
    expect(canceled.data).toMatchObject({ object: "email", id });

    const fetched = await resend.emails.get(id);
    expect(fetched.data?.last_event).toBe("canceled");
  });
});

describe("topic-scoped sends (topicId)", () => {
  let topicId: string;

  beforeAll(async () => {
    const topic = await resend.topics.create({ name: "News", defaultSubscription: "opt_in" });
    expect(topic.error).toBeNull();
    topicId = topic.data?.id ?? "";
    const contact = await resend.contacts.create({ email: "optedout@example.com" });
    expect(contact.error).toBeNull();
    const optOut = await resend.contacts.topics.update({
      id: contact.data?.id ?? "",
      topics: [{ id: topicId, subscription: "opt_out" }],
    });
    expect(optOut.error).toBeNull();
  });

  it("strips opted-out recipients — the drop is visible via emails.get", async () => {
    const sent = await resend.emails.send({
      from: "Acme <onboarding@acme.dev>",
      to: ["optedout@example.com", "kept@example.com"],
      subject: "topic mail",
      text: "hi",
      topicId,
    });
    expect(sent.error).toBeNull();
    const fetched = await resend.emails.get(sent.data?.id ?? "");
    expect(fetched.error).toBeNull();
    expect(fetched.data?.to).toEqual(["kept@example.com"]);
  });

  it("errors when every recipient opted out of the topic", async () => {
    const sent = await resend.emails.send({
      from: "Acme <onboarding@acme.dev>",
      to: ["optedout@example.com"],
      subject: "topic mail",
      text: "hi",
      topicId,
    });
    expect(sent.data).toBeNull();
    expect(sent.error?.name).toBe("all_recipients_suppressed");
    expect(sent.error?.statusCode).toBe(422);
  });

  it("404s an unknown topic id instead of sending", async () => {
    const sent = await resend.emails.send({
      from: "Acme <onboarding@acme.dev>",
      to: ["x@example.com"],
      subject: "s",
      text: "t",
      topicId: randomUUID(),
    });
    expect(sent.data).toBeNull();
    expect(sent.error?.name).toBe("not_found");
  });
});
