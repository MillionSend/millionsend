import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EnvKeyring, generateApiKey, hashRecipient } from "@millionsend/core";
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
let otherTeamId: string;
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

async function suppress(email: string): Promise<string> {
  const res = await call(fullKey, "POST", "/suppressions", { email });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { object: string; id: string };
  expect(body.object).toBe("suppression");
  return body.id;
}

async function seedRow(
  email: string,
  overrides: Partial<typeof schema.suppressions.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(schema.suppressions)
    .values({
      teamId,
      email,
      emailHash: hashRecipient(email),
      reason: "hard_bounce",
      ...overrides,
    })
    .returning({ id: schema.suppressions.id });
  return row?.id ?? "";
}

const readRow = async (id: string) =>
  (await db.select().from(schema.suppressions).where(eq(schema.suppressions.id, id)))[0];

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "suppressions-team");
  otherTeamId = await createTeam(db, "suppressions-other-team");
  fullKey = await insertKey(teamId);
  sendKey = await insertKey(teamId, { permission: "sending_access" });
  otherTeamKey = await insertKey(otherTeamId);
  await db.insert(schema.domains).values({
    teamId,
    name: "acme.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  app = createApi({ db, keyring, isCloud: false, enqueueEmailSend: async () => {} });
});
afterAll(() => close());

describe("POST /suppressions", () => {
  it("creates a manual suppression, storing the normalized address", async () => {
    const id = await suppress("Manual.User@Example.COM");
    expect(await readRow(id)).toMatchObject({
      teamId,
      email: "manual.user@example.com",
      emailHash: hashRecipient("manual.user@example.com"),
      reason: "manual",
      sourceEmailId: null,
    });
  });

  it("is idempotent across case and keeps an existing entry's reason", async () => {
    const id = await suppress("idem@example.com");
    expect(await suppress("IDEM@example.com")).toBe(id);

    const bounced = await seedRow("bounced-first@example.com", { sourceEmailId: randomUUID() });
    expect(await suppress("bounced-first@example.com")).toBe(bounced);
    expect((await readRow(bounced))?.reason).toBe("hard_bounce");
  });

  it("422s a non-address", async () => {
    for (const body of [{ email: "not-an-email" }, { email: "Bob <bob@example.com>" }, {}]) {
      const res = await call(fullKey, "POST", "/suppressions", body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(await res.json()).toMatchObject({ statusCode: 422, name: "validation_error" });
    }
  });

  it("records an explicit origin on new rows only, and refuses unsubscribe", async () => {
    for (const [origin, reason] of [
      ["bounce", "hard_bounce"],
      ["complaint", "complaint"],
      ["manual", "manual"],
    ] as const) {
      const res = await call(fullKey, "POST", "/suppressions", {
        email: `origin-${origin}@example.com`,
        origin,
      });
      expect(res.status, origin).toBe(200);
      const { id } = (await res.json()) as { id: string };
      expect((await readRow(id))?.reason).toBe(reason);
      expect(await (await call(fullKey, "GET", `/suppressions/${id}`)).json()).toMatchObject({
        origin,
        source_id: null,
      });
    }

    // An existing manual row is not rewritten as a bounce.
    const manual = await suppress("stays-manual@example.com");
    const again = await call(fullKey, "POST", "/suppressions", {
      email: "stays-manual@example.com",
      origin: "bounce",
    });
    expect(((await again.json()) as { id: string }).id).toBe(manual);
    expect((await readRow(manual))?.reason).toBe("manual");

    for (const origin of ["unsubscribe", "hard_bounce", ""]) {
      const res = await call(fullKey, "POST", "/suppressions", { email: "x@example.com", origin });
      expect(res.status, origin).toBe(422);
    }
  });
});

describe("GET /suppressions/{id-or-email}", () => {
  it("resolves by id and by (case-insensitive, url-encoded) email with the wire shape", async () => {
    const sourceEmailId = randomUUID();
    const id = await seedRow("get.me@example.com", { reason: "complaint", sourceEmailId });
    const expected = {
      object: "suppression",
      id,
      email: "get.me@example.com",
      origin: "complaint",
      source_id: sourceEmailId,
      created_at: expect.any(String),
    };
    const byId = await call(fullKey, "GET", `/suppressions/${id}`);
    expect(byId.status).toBe(200);
    expect(await byId.json()).toEqual(expected);

    const byEmail = await call(
      fullKey,
      "GET",
      `/suppressions/${encodeURIComponent("Get.Me@Example.com")}`,
    );
    expect(byEmail.status).toBe(200);
    expect(await byEmail.json()).toEqual(expected);
  });

  it("finds rows stored under the legacy (pre-normalization) hash", async () => {
    // A trailing root dot is dropped by the current normalizer but was kept
    // by the legacy trim+lowercase hash.
    const address = "legacy@example.com.";
    const legacyHash = createHash("sha256").update(address.toLowerCase(), "utf8").digest("hex");
    expect(legacyHash).not.toBe(hashRecipient(address));
    const id = await seedRow(address, { emailHash: legacyHash });

    const res = await call(fullKey, "GET", `/suppressions/${encodeURIComponent(address)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, origin: "bounce" });
  });

  it("maps one_click_unsubscribe to the superset origin unsubscribe", async () => {
    const id = await seedRow("optout@example.com", { reason: "one_click_unsubscribe" });
    const res = await call(fullKey, "GET", `/suppressions/${id}`);
    expect(await res.json()).toMatchObject({ origin: "unsubscribe" });
  });

  it("404s unknown ids and addresses, and a foreign team's rows", async () => {
    const id = await seedRow("mine@example.com");
    expect((await call(fullKey, "GET", `/suppressions/${randomUUID()}`)).status).toBe(404);
    const missing = await call(fullKey, "GET", "/suppressions/nobody@example.com");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ statusCode: 404, name: "not_found" });
    expect((await call(otherTeamKey, "GET", `/suppressions/${id}`)).status).toBe(404);
    expect((await call(otherTeamKey, "GET", "/suppressions/mine@example.com")).status).toBe(404);
  });
});

describe("erased rows", () => {
  it("are hidden from list and email lookups but reachable and deletable by id", async () => {
    const address = "erased@example.com";
    const id = await seedRow(address, { email: null });

    const list = (await (await call(fullKey, "GET", "/suppressions?limit=100")).json()) as {
      data: { id: string }[];
    };
    expect(list.data.some((r) => r.id === id)).toBe(false);
    expect((await call(fullKey, "GET", `/suppressions/${address}`)).status).toBe(404);
    expect((await call(fullKey, "DELETE", `/suppressions/${address}`)).status).toBe(404);

    const byId = await call(fullKey, "GET", `/suppressions/${id}`);
    expect(byId.status).toBe(200);
    expect(await byId.json()).toMatchObject({ id, email: "[erased]", origin: "bounce" });

    // Re-suppressing the erased address reuses the row without restoring the plaintext.
    expect(await suppress(address)).toBe(id);
    expect((await readRow(id))?.email).toBeNull();

    const removed = await call(fullKey, "DELETE", `/suppressions/${id}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ object: "suppression", id, deleted: true });
    expect(await readRow(id)).toBeUndefined();
  });
});

describe("GET /suppressions", () => {
  it("filters by origin, including the superset value, and 422s unknown origins", async () => {
    const ids = {
      bounce: await seedRow("list-bounce@example.com"),
      complaint: await seedRow("list-complaint@example.com", { reason: "complaint" }),
      manual: await suppress("list-manual@example.com"),
      unsubscribe: await seedRow("list-unsub@example.com", { reason: "one_click_unsubscribe" }),
    };
    for (const [origin, id] of Object.entries(ids)) {
      const res = await call(fullKey, "GET", `/suppressions?origin=${origin}&limit=100`);
      expect(res.status, origin).toBe(200);
      const body = (await res.json()) as {
        object: string;
        has_more: boolean;
        data: { id: string; origin: string }[];
      };
      expect(body.object).toBe("list");
      expect(body.data.some((r) => r.id === id)).toBe(true);
      expect(body.data.every((r) => r.origin === origin)).toBe(true);
    }
    const all = (await (await call(fullKey, "GET", "/suppressions?limit=100")).json()) as {
      data: { id: string }[];
    };
    for (const id of Object.values(ids)) expect(all.data.some((r) => r.id === id)).toBe(true);
    expect(Object.keys(all.data[0] ?? {}).sort()).toEqual([
      "created_at",
      "email",
      "id",
      "origin",
      "source_id",
    ]);

    const bad = await call(fullKey, "GET", "/suppressions?origin=hard_bounce");
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ name: "validation_error" });
  });

  it("paginates with keyset cursors and stays tenant-scoped", async () => {
    const first = await call(fullKey, "GET", "/suppressions?limit=1");
    const firstBody = (await first.json()) as { data: { id: string }[]; has_more: boolean };
    expect(firstBody.data).toHaveLength(1);
    expect(firstBody.has_more).toBe(true);

    const next = await call(
      fullKey,
      "GET",
      `/suppressions?limit=100&after=${firstBody.data[0]?.id}`,
    );
    const nextBody = (await next.json()) as { data: { id: string }[] };
    expect(nextBody.data.some((r) => r.id === firstBody.data[0]?.id)).toBe(false);

    // A foreign cursor is invalid, not a window into the other team's rows.
    expect(
      (await call(otherTeamKey, "GET", `/suppressions?after=${firstBody.data[0]?.id}`)).status,
    ).toBe(422);
    const foreign = (await (await call(otherTeamKey, "GET", "/suppressions?limit=100")).json()) as {
      data: unknown[];
    };
    expect(foreign.data).toEqual([]);
  });
});

describe("DELETE /suppressions/{id-or-email}", () => {
  it("removes by email or id and 404s afterwards", async () => {
    const byEmailId = await suppress("delete-me@example.com");
    const res = await call(fullKey, "DELETE", "/suppressions/Delete-Me@example.com");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ object: "suppression", id: byEmailId, deleted: true });
    expect((await call(fullKey, "DELETE", "/suppressions/delete-me@example.com")).status).toBe(404);

    const byId = await suppress("delete-me-too@example.com");
    expect((await call(fullKey, "DELETE", `/suppressions/${byId}`)).status).toBe(200);
    expect(await readRow(byId)).toBeUndefined();
  });

  it("404s a foreign team's row without deleting it", async () => {
    const id = await suppress("kept@example.com");
    expect((await call(otherTeamKey, "DELETE", `/suppressions/${id}`)).status).toBe(404);
    expect((await call(otherTeamKey, "DELETE", "/suppressions/kept@example.com")).status).toBe(404);
    expect(await readRow(id)).toBeDefined();
  });
});

describe("POST /suppressions/batch/add", () => {
  it("dedupes case-insensitively, keeps input order, and reuses existing rows", async () => {
    const existing = await seedRow("batch-existing@example.com");
    const res = await call(fullKey, "POST", "/suppressions/batch/add", {
      emails: [
        "Batch-A@example.com",
        "batch-a@example.com",
        "batch-b@example.com",
        "BATCH-EXISTING@example.com",
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { object: string; id: string }[] };
    expect(body.data).toHaveLength(3);
    expect(body.data.every((r) => r.object === "suppression")).toBe(true);
    expect(body.data[2]?.id).toBe(existing);
    expect((await readRow(body.data[0]?.id ?? ""))?.email).toBe("batch-a@example.com");
    expect((await readRow(body.data[1]?.id ?? ""))?.email).toBe("batch-b@example.com");
    expect((await readRow(existing))?.reason).toBe("hard_bounce");
  });

  it("applies one origin to every row it creates, leaving existing rows alone", async () => {
    const existing = await suppress("batch-origin-existing@example.com");
    const res = await call(fullKey, "POST", "/suppressions/batch/add", {
      emails: [
        "batch-origin-a@example.com",
        "batch-origin-b@example.com",
        "batch-origin-existing@example.com",
      ],
      origin: "complaint",
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string }[] };
    expect((await readRow(data[0]?.id ?? ""))?.reason).toBe("complaint");
    expect((await readRow(data[1]?.id ?? ""))?.reason).toBe("complaint");
    expect(data[2]?.id).toBe(existing);
    expect((await readRow(existing))?.reason).toBe("manual");

    const bad = await call(fullKey, "POST", "/suppressions/batch/add", {
      emails: ["x@example.com"],
      origin: "unsubscribe",
    });
    expect(bad.status).toBe(422);
  });

  it("accepts more than Resend's 100 and caps at 1000", async () => {
    const emails = (n: number) => Array.from({ length: n }, (_, i) => `bulk${i}@example.com`);
    const ok = await call(fullKey, "POST", "/suppressions/batch/add", { emails: emails(101) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: unknown[] }).data).toHaveLength(101);

    for (const body of [{ emails: emails(1001) }, { emails: [] }, { emails: ["nope"] }, {}]) {
      const res = await call(fullKey, "POST", "/suppressions/batch/add", body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(422);
    }
  });
});

describe("POST /suppressions/batch/remove", () => {
  it("requires exactly one of emails or ids", async () => {
    for (const body of [
      {},
      { emails: ["a@example.com"], ids: [randomUUID()] },
      { emails: [] },
      { ids: ["not-a-uuid"] },
    ]) {
      const res = await call(fullKey, "POST", "/suppressions/batch/remove", body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });

  it("removes by ids, listing only rows actually removed", async () => {
    const a = await suppress("rm-a@example.com");
    const b = await suppress("rm-b@example.com");
    const foreign = (
      await db
        .insert(schema.suppressions)
        .values({
          teamId: otherTeamId,
          email: "foreign@example.com",
          emailHash: hashRecipient("foreign@example.com"),
          reason: "manual",
        })
        .returning({ id: schema.suppressions.id })
    )[0]?.id;
    const res = await call(fullKey, "POST", "/suppressions/batch/remove", {
      ids: [a, b, randomUUID(), foreign],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; deleted: boolean }[] };
    expect(body.data.map((r) => r.id).sort()).toEqual([a, b].sort());
    expect(body.data.every((r) => r.deleted === true)).toBe(true);
    expect(await readRow(foreign ?? "")).toBeDefined();
  });

  it("removes by emails across hash forms, skipping erased rows", async () => {
    const c = await suppress("rm-c@example.com");
    const erased = await seedRow("rm-erased@example.com", { email: null });
    const res = await call(fullKey, "POST", "/suppressions/batch/remove", {
      emails: ["RM-C@example.com", "rm-erased@example.com", "unknown@example.com"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [{ object: "suppression", id: c, deleted: true }],
    });
    expect(await readRow(erased)).toBeDefined();
  });
});

describe("send integration", () => {
  const send = (to: string[]) =>
    call(fullKey, "POST", "/emails", { from: "Acme <a@acme.dev>", to, subject: "s", text: "t" });
  const readTo = async (id: string) =>
    (
      await db.select({ to: schema.emails.to }).from(schema.emails).where(eq(schema.emails.id, id))
    )[0]?.to;

  it("blocks sends to a manually suppressed address exactly like a bounce", async () => {
    await suppress("blocked@example.com");

    const refused = await send(["Blocked@example.com"]);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      name: "validation_error",
      message: expect.stringMatching(/suppressed/),
    });

    const mixed = await send(["blocked@example.com", "ok@example.com"]);
    expect(mixed.status).toBe(200);
    const { id } = (await mixed.json()) as { id: string };
    expect(await readTo(id)).toEqual(["ok@example.com"]);

    expect((await call(fullKey, "DELETE", "/suppressions/blocked@example.com")).status).toBe(200);
    expect((await send(["blocked@example.com"])).status).toBe(200);
  });
});

describe("permission confinement", () => {
  it("403s a sending_access key on every /suppressions route", async () => {
    for (const [method, path, body] of [
      ["GET", "/suppressions", undefined],
      ["POST", "/suppressions", { email: "x@example.com" }],
      ["GET", `/suppressions/${randomUUID()}`, undefined],
      ["DELETE", "/suppressions/x@example.com", undefined],
      ["POST", "/suppressions/batch/add", { emails: ["x@example.com"] }],
      ["POST", "/suppressions/batch/remove", { emails: ["x@example.com"] }],
    ] as const) {
      const res = await call(sendKey, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toMatchObject({ statusCode: 403, name: "restricted_api_key" });
    }
  });
});
