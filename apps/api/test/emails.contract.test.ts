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
  const key = generateApiKey("test");
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "contract",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  const app = createApi({ db, keyring, isCloud: true });
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
});
