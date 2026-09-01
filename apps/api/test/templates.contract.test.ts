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
 * Wire-compat gate for templates: the official `resend` npm SDK against a live
 * MillionSend API — create/get/list/update/publish/duplicate/remove, the
 * chainable create().publish(), alias lookups, and the loud 422 for the
 * fields we do not model (from, replyTo, variables).
 */

let db: Db;
let closeDb: () => Promise<void>;
let server: ServerType;
let resend: Resend;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  const teamId = await createTeam(db, "templates-contract");
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

describe("official resend SDK: templates", () => {
  let templateId: string;

  it("creates a template", async () => {
    const created = await resend.templates.create({
      name: "Welcome",
      subject: "Welcome aboard",
      html: "<h1>Hi {{{FIRST_NAME|there}}}</h1>",
      text: "Hi there",
      alias: "welcome",
    });
    expect(created.error).toBeNull();
    expect(created.data).toEqual({ object: "template", id: expect.any(String) });
    templateId = created.data?.id ?? "";
  });

  it("gets the template with the SDK's full Template key set, by id and by alias", async () => {
    const expected = {
      object: "template",
      id: templateId,
      current_version_id: templateId,
      name: "Welcome",
      alias: "welcome",
      from: null,
      subject: "Welcome aboard",
      reply_to: null,
      html: "<h1>Hi {{{FIRST_NAME|there}}}</h1>",
      text: "Hi there",
      variables: [],
      status: "published",
      published_at: expect.any(String),
      has_unpublished_versions: false,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    };
    const byId = await resend.templates.get(templateId);
    expect(byId.error).toBeNull();
    expect(byId.data).toEqual(expected);
    expect(byId.data?.published_at).toBe(byId.data?.created_at);

    const byAlias = await resend.templates.get("welcome");
    expect(byAlias.error).toBeNull();
    expect(byAlias.data).toEqual(expected);
  });

  it("lists templates", async () => {
    const listed = await resend.templates.list({ limit: 10 });
    expect(listed.error).toBeNull();
    expect(listed.data?.object).toBe("list");
    expect(listed.data?.has_more).toBe(false);
    expect(listed.data?.data).toEqual([
      {
        id: templateId,
        name: "Welcome",
        alias: "welcome",
        status: "published",
        published_at: expect.any(String),
        created_at: expect.any(String),
        updated_at: expect.any(String),
      },
    ]);
  });

  it("updates name, subject and alias", async () => {
    const updated = await resend.templates.update(templateId, {
      name: "Welcome v2",
      subject: "Welcome!",
      alias: "welcome-v2",
    });
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual({ object: "template", id: templateId });

    const fetched = await resend.templates.get("welcome-v2");
    expect(fetched.data).toMatchObject({
      name: "Welcome v2",
      subject: "Welcome!",
      alias: "welcome-v2",
      html: "<h1>Hi {{{FIRST_NAME|there}}}</h1>",
    });
    const stale = await resend.templates.get("welcome");
    expect(stale.error?.name).toBe("not_found");
  });

  it("clears subject/text with the SDK-typed null", async () => {
    const cleared = await resend.templates.update(templateId, { subject: null, text: null });
    expect(cleared.error).toBeNull();
    expect((await resend.templates.get(templateId)).data).toMatchObject({
      subject: null,
      text: null,
    });
    const restored = await resend.templates.update(templateId, {
      subject: "Welcome!",
      text: "Hi there",
    });
    expect(restored.error).toBeNull();

    const nullOnCreate = await resend.templates.create({
      name: "Null create",
      html: "<p>x</p>",
      subject: null,
      text: null,
      alias: null,
    });
    expect(nullOnCreate.error).toBeNull();
    expect((await resend.templates.get(nullOnCreate.data?.id ?? "")).data).toMatchObject({
      subject: null,
      text: null,
      alias: null,
    });
  });

  it("publishes as a no-op, standalone and chained off create/duplicate", async () => {
    const published = await resend.templates.publish(templateId);
    expect(published.error).toBeNull();
    expect(published.data).toEqual({ object: "template", id: templateId });

    const chained = await resend.templates
      .create({ name: "Chained", html: "<p>chained</p>" })
      .publish();
    expect(chained.error).toBeNull();
    expect(chained.data).toEqual({ object: "template", id: expect.any(String) });
    const fetched = await resend.templates.get(chained.data?.id ?? "");
    expect(fetched.data).toMatchObject({ status: "published", has_unpublished_versions: false });
  });

  it("duplicates into a new alias-less copy", async () => {
    const copy = await resend.templates.duplicate(templateId);
    expect(copy.error).toBeNull();
    expect(copy.data).toEqual({ object: "template", id: expect.any(String) });
    expect(copy.data?.id).not.toBe(templateId);

    const fetched = await resend.templates.get(copy.data?.id ?? "");
    expect(fetched.data).toMatchObject({
      name: "Welcome v2 (copy)",
      alias: null,
      subject: "Welcome!",
      html: "<h1>Hi {{{FIRST_NAME|there}}}</h1>",
      text: "Hi there",
    });
  });

  it("422s from, replyTo and variables with a precise message", async () => {
    const cases: [string, Parameters<Resend["templates"]["update"]>[1]][] = [
      ["from", { from: "Acme <hi@acme.com>" }],
      ["reply_to", { replyTo: "reply@acme.com" }],
      ["variables", { variables: [{ key: "name", type: "string" }] }],
    ];
    for (const [field, payload] of cases) {
      const bad = await resend.templates.create({ name: "Bad", html: "<p>x</p>", ...payload });
      expect(bad.data, field).toBeNull();
      expect(bad.error).toEqual({
        statusCode: 422,
        name: "validation_error",
        message: `${field} is not supported on templates yet`,
      });
      const badUpdate = await resend.templates.update(templateId, payload);
      expect(badUpdate.data, field).toBeNull();
      expect(badUpdate.error?.statusCode).toBe(422);
    }
  });

  it("409s a duplicate alias", async () => {
    const dup = await resend.templates.create({
      name: "Dup",
      html: "<p>x</p>",
      alias: "welcome-v2",
    });
    expect(dup.data).toBeNull();
    expect(dup.error).toEqual({
      statusCode: 409,
      name: "validation_error",
      message: "Template alias already exists",
    });
  });

  it("removes the template", async () => {
    const removed = await resend.templates.remove("welcome-v2");
    expect(removed.error).toBeNull();
    expect(removed.data).toEqual({ object: "template", id: templateId, deleted: true });

    const gone = await resend.templates.get(templateId);
    expect(gone.data).toBeNull();
    expect(gone.error?.name).toBe("not_found");
  });
});
