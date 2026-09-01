import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
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
let fullKey: string;
let sendKey: string;
let otherTeamKey: string;

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

async function createTemplate(body: unknown, token = fullKey): Promise<string> {
  const res = await call(token, "POST", "/templates", body);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { object: string; id: string };
  expect(json.object).toBe("template");
  return json.id;
}

async function getTemplate(idOrAlias: string, token = fullKey) {
  const res = await call(token, "GET", `/templates/${idOrAlias}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const UNSUPPORTED_ERROR = (field: string) => ({
  statusCode: 422,
  name: "validation_error",
  message: `${field} is not supported on templates yet`,
});

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "templates-team");
  const otherTeamId = await createTeam(db, "templates-other-team");
  fullKey = await insertKey(teamId);
  sendKey = await insertKey(teamId, { permission: "sending_access" });
  otherTeamKey = await insertKey(otherTeamId);
  const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  app = createApi({ db, keyring, isCloud: false, enqueueEmailSend: async () => {} });
});
afterAll(() => close());

describe("POST /templates", () => {
  it("creates a live template, storing html raw and blank subject/text as null", async () => {
    const html = '<h1>Hi {{{FIRST_NAME|there}}}</h1><script>alert(1)</script><p onclick="x">x</p>';
    const id = await createTemplate({
      name: "  Welcome  ",
      subject: "",
      html,
      text: "",
      alias: "welcome-v1",
    });

    const [row] = await db.select().from(schema.templates).where(eq(schema.templates.id, id));
    expect(row).toMatchObject({
      teamId,
      name: "Welcome",
      alias: "welcome-v1",
      subject: null,
      html,
      text: null,
      document: null,
    });

    const got = await getTemplate(id);
    expect(got.status).toBe(200);
    expect(got.body).toEqual({
      object: "template",
      id,
      current_version_id: id,
      name: "Welcome",
      alias: "welcome-v1",
      from: null,
      subject: null,
      reply_to: null,
      html,
      text: null,
      variables: [],
      status: "published",
      published_at: row?.createdAt.toISOString(),
      has_unpublished_versions: false,
      created_at: row?.createdAt.toISOString(),
      updated_at: row?.updatedAt.toISOString(),
    });
  });

  it("422s from, reply_to and variables with a precise message", async () => {
    const base = { name: "Unsupported", html: "<p>x</p>" };
    for (const [field, value] of [
      ["from", "Acme <hi@acme.com>"],
      ["reply_to", ["a@acme.com"]],
      ["reply_to", "a@acme.com"],
      ["variables", [{ key: "name", type: "string" }]],
    ] as const) {
      const res = await call(fullKey, "POST", "/templates", { ...base, [field]: value });
      expect(res.status, field).toBe(422);
      expect(await res.json()).toEqual(UNSUPPORTED_ERROR(field));
    }
    // A null / empty value carries nothing to drop.
    const ok = await call(fullKey, "POST", "/templates", {
      ...base,
      from: null,
      reply_to: null,
      variables: [],
    });
    expect(ok.status).toBe(200);
  });

  it("422s missing name/html, oversize fields and malformed aliases", async () => {
    for (const body of [
      { html: "<p>x</p>" },
      { name: "No html" },
      { name: "Empty html", html: "" },
      { name: "", html: "<p>x</p>" },
      { name: "x".repeat(201), html: "<p>x</p>" },
      { name: "Subject", html: "<p>x</p>", subject: "s".repeat(999) },
      { name: "Alias", html: "<p>x</p>", alias: "" },
      { name: "Alias", html: "<p>x</p>", alias: "-leading-dash" },
      { name: "Alias", html: "<p>x</p>", alias: "has space" },
      { name: "Alias", html: "<p>x</p>", alias: "a".repeat(101) },
      { name: "Alias", html: "<p>x</p>", alias: crypto.randomUUID() },
    ]) {
      const res = await call(fullKey, "POST", "/templates", body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(422);
      expect(((await res.json()) as { name: string }).name).toBe("validation_error");
    }
  });

  it("409s a duplicate alias within the team; the same alias is free on another team", async () => {
    await createTemplate({ name: "A", html: "<p>a</p>", alias: "shared.alias_1" });
    const dup = await call(fullKey, "POST", "/templates", {
      name: "B",
      html: "<p>b</p>",
      alias: "shared.alias_1",
    });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({
      statusCode: 409,
      name: "validation_error",
      message: "Template alias already exists",
    });
    await createTemplate({ name: "C", html: "<p>c</p>", alias: "shared.alias_1" }, otherTeamKey);
  });
});

describe("GET /templates/{id-or-alias}", () => {
  it("resolves a uuid by id and anything else by alias, case-sensitively", async () => {
    const id = await createTemplate({ name: "Lookup", html: "<p>l</p>", alias: "Lookup-Me" });
    expect((await getTemplate(id)).body.id).toBe(id);
    expect((await getTemplate("Lookup-Me")).body.id).toBe(id);
    expect((await getTemplate("lookup-me")).status).toBe(404);
    expect((await getTemplate(crypto.randomUUID())).status).toBe(404);
    expect((await getTemplate("Lookup-Me", otherTeamKey)).status).toBe(404);
    expect((await getTemplate(id, otherTeamKey)).status).toBe(404);
  });
});

describe("GET /templates", () => {
  it("lists the SDK list-item key set and paginates with keyset cursors", async () => {
    const list = await call(fullKey, "GET", "/templates?limit=100");
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      object: string;
      data: Record<string, unknown>[];
      has_more: boolean;
    };
    expect(body.object).toBe("list");
    expect(body.has_more).toBe(false);
    expect(body.data.length).toBeGreaterThanOrEqual(3);
    for (const row of body.data) {
      expect(Object.keys(row).sort()).toEqual([
        "alias",
        "created_at",
        "id",
        "name",
        "published_at",
        "status",
        "updated_at",
      ]);
      expect(row.status).toBe("published");
      expect(row.published_at).toBe(row.created_at);
    }
    // Oldest first, like the other lists.
    const times = body.data.map((r) => String(r.created_at));
    expect([...times].sort()).toEqual(times);

    const first = await call(fullKey, "GET", "/templates?limit=1");
    const firstBody = (await first.json()) as { data: { id: string }[]; has_more: boolean };
    expect(firstBody.data).toHaveLength(1);
    expect(firstBody.has_more).toBe(true);
    const next = await call(fullKey, "GET", `/templates?limit=100&after=${firstBody.data[0]?.id}`);
    const nextBody = (await next.json()) as { data: { id: string }[] };
    expect(nextBody.data.some((r) => r.id === firstBody.data[0]?.id)).toBe(false);
    expect(nextBody.data).toHaveLength(body.data.length - 1);

    // Tenant isolation: the other team sees only its own row.
    const other = await call(otherTeamKey, "GET", "/templates?limit=100");
    const otherBody = (await other.json()) as { data: { alias: string | null }[] };
    expect(otherBody.data.map((r) => r.alias)).toEqual(["shared.alias_1"]);
  });
});

describe("PATCH /templates/{id}", () => {
  it("updates fields, bumps updated_at, clears alias with null, no-ops on an empty body", async () => {
    const id = await createTemplate({
      name: "Patch",
      subject: "Old",
      html: "<p>old</p>",
      text: "old",
      alias: "patch-me",
    });
    const before = await getTemplate(id);

    const res = await call(fullKey, "PATCH", `/templates/${id}`, {
      name: "Patched",
      subject: "",
      html: "<p>new</p>",
      text: "new",
      alias: null,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ object: "template", id });
    const after = await getTemplate(id);
    expect(after.body).toMatchObject({
      name: "Patched",
      subject: null,
      html: "<p>new</p>",
      text: "new",
      alias: null,
      created_at: before.body.created_at,
    });
    expect(after.body.updated_at).not.toBe(before.body.updated_at);
    expect((await getTemplate("patch-me")).status).toBe(404);

    const noop = await call(fullKey, "PATCH", `/templates/${id}`, {});
    expect(noop.status).toBe(200);
    expect(await noop.json()).toEqual({ object: "template", id });
    expect((await getTemplate(id)).body.updated_at).toBe(after.body.updated_at);

    // Reachable by alias too, once it has one again.
    await call(fullKey, "PATCH", `/templates/${id}`, { alias: "patch-me" });
    const viaAlias = await call(fullKey, "PATCH", "/templates/patch-me", { name: "Via alias" });
    expect(viaAlias.status).toBe(200);
    expect((await getTemplate(id)).body.name).toBe("Via alias");
  });

  it("accepts null for subject/text (SDK-typed) on create and update", async () => {
    const id = await createTemplate({
      name: "Nulls",
      subject: null,
      html: "<p>n</p>",
      text: null,
      alias: null,
    });
    expect((await getTemplate(id)).body).toMatchObject({ subject: null, text: null, alias: null });

    await call(fullKey, "PATCH", `/templates/${id}`, { subject: "S", text: "t" });
    expect((await getTemplate(id)).body).toMatchObject({ subject: "S", text: "t" });
    const res = await call(fullKey, "PATCH", `/templates/${id}`, { subject: null, text: null });
    expect(res.status).toBe(200);
    expect((await getTemplate(id)).body).toMatchObject({ subject: null, text: null });
  });

  it("drops the dashboard's block document when html or text is written, keeps it otherwise", async () => {
    const id = await createTemplate({ name: "Doc", subject: "s", html: "<p>doc</p>", text: "doc" });
    const document = { type: "doc", content: [] };
    const seed = () =>
      db.update(schema.templates).set({ document }).where(eq(schema.templates.id, id));
    const stored = async () =>
      (await db.select().from(schema.templates).where(eq(schema.templates.id, id)))[0];

    await seed();
    expect((await call(fullKey, "PATCH", `/templates/${id}`, { name: "Renamed" })).status).toBe(
      200,
    );
    expect((await stored())?.document).toEqual(document);
    expect((await call(fullKey, "PATCH", `/templates/${id}`, { subject: "x" })).status).toBe(200);
    expect((await stored())?.document).toEqual(document);

    expect((await call(fullKey, "PATCH", `/templates/${id}`, { html: "<p>new</p>" })).status).toBe(
      200,
    );
    expect(await stored()).toMatchObject({ html: "<p>new</p>", document: null });

    await seed();
    expect((await call(fullKey, "PATCH", `/templates/${id}`, { text: "" })).status).toBe(200);
    expect(await stored()).toMatchObject({ text: null, document: null });
  });

  it("422s unsupported fields and bad values, 409s a taken alias, 404s foreign ids", async () => {
    const id = await createTemplate({ name: "Patch bad", html: "<p>x</p>" });
    for (const field of ["from", "reply_to", "variables"] as const) {
      const res = await call(fullKey, "PATCH", `/templates/${id}`, {
        [field]: field === "variables" ? [{ key: "k", type: "string" }] : "x",
      });
      expect(res.status, field).toBe(422);
      expect(await res.json()).toEqual(UNSUPPORTED_ERROR(field));
    }
    for (const body of [{ html: "" }, { name: "" }, { alias: "bad alias" }]) {
      const res = await call(fullKey, "PATCH", `/templates/${id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    const taken = await call(fullKey, "PATCH", `/templates/${id}`, { alias: "shared.alias_1" });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({
      statusCode: 409,
      name: "validation_error",
      message: "Template alias already exists",
    });
    expect((await call(otherTeamKey, "PATCH", `/templates/${id}`, { name: "x" })).status).toBe(404);
    expect((await call(otherTeamKey, "PATCH", `/templates/${id}`, {})).status).toBe(404);
    expect((await getTemplate(id)).body.name).toBe("Patch bad");
  });
});

describe("POST /templates/{id}/publish", () => {
  it("is an idempotent no-op that leaves the row untouched", async () => {
    const id = await createTemplate({ name: "Publish", html: "<p>p</p>", alias: "publish-me" });
    const before = await getTemplate(id);
    for (const key of [id, "publish-me"]) {
      const res = await call(fullKey, "POST", `/templates/${key}/publish`);
      expect(res.status, key).toBe(200);
      expect(await res.json()).toEqual({ object: "template", id });
    }
    expect((await getTemplate(id)).body).toEqual(before.body);
    expect((await call(otherTeamKey, "POST", `/templates/${id}/publish`)).status).toBe(404);
    expect((await call(fullKey, "POST", `/templates/${crypto.randomUUID()}/publish`)).status).toBe(
      404,
    );
  });
});

describe("POST /templates/{id}/duplicate", () => {
  it("copies content and document into a new alias-less template", async () => {
    const id = await createTemplate({
      name: "Original",
      subject: "Sub",
      html: "<p>o</p>",
      text: "o",
      alias: "original",
    });
    const document = { type: "doc", content: [] };
    await db.update(schema.templates).set({ document }).where(eq(schema.templates.id, id));

    const res = await call(fullKey, "POST", "/templates/original/duplicate");
    expect(res.status).toBe(200);
    const copy = (await res.json()) as { object: string; id: string };
    expect(copy.object).toBe("template");
    expect(copy.id).not.toBe(id);

    const [row] = await db.select().from(schema.templates).where(eq(schema.templates.id, copy.id));
    expect(row).toMatchObject({
      teamId,
      name: "Original (copy)",
      alias: null,
      subject: "Sub",
      html: "<p>o</p>",
      text: "o",
      document,
    });
    expect((await call(otherTeamKey, "POST", `/templates/${id}/duplicate`)).status).toBe(404);
  });
});

describe("DELETE /templates/{id}", () => {
  it("deletes by id or alias and 404s afterwards; a foreign team cannot delete", async () => {
    const id = await createTemplate({ name: "Doomed", html: "<p>d</p>", alias: "doomed" });
    expect((await call(otherTeamKey, "DELETE", `/templates/${id}`)).status).toBe(404);
    expect((await getTemplate(id)).status).toBe(200);

    const res = await call(fullKey, "DELETE", "/templates/doomed");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ object: "template", id, deleted: true });
    expect((await getTemplate(id)).status).toBe(404);
    expect((await call(fullKey, "DELETE", `/templates/${id}`)).status).toBe(404);
  });
});

describe("permission confinement", () => {
  it("403s a sending_access key on every /templates route", async () => {
    const id = crypto.randomUUID();
    for (const [method, path, body] of [
      ["GET", "/templates", undefined],
      ["POST", "/templates", { name: "x", html: "<p>x</p>" }],
      ["GET", `/templates/${id}`, undefined],
      ["PATCH", `/templates/${id}`, { name: "x" }],
      ["DELETE", `/templates/${id}`, undefined],
      ["POST", `/templates/${id}/publish`, undefined],
      ["POST", `/templates/${id}/duplicate`, undefined],
    ] as const) {
      const res = await call(sendKey, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toMatchObject({ statusCode: 403, name: "restricted_api_key" });
    }
  });
});
