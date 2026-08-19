import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let tokenA: string;
let tokenB: string;

const json = async (res: Response) =>
  (await res.json()) as Record<string, unknown> & { data?: Record<string, unknown>[] };

async function call(token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function seedTeam(slug: string): Promise<string> {
  const teamId = await createTeam(db, slug);
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: slug,
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  await db.insert(schema.contacts).values([
    { teamId, email: "pro@example.com", properties: { plan: "pro" } },
    { teamId, email: "free@example.com", properties: { plan: "free" } },
  ]);
  return key.token;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  tokenA = await seedTeam("seg-a");
  tokenB = await seedTeam("seg-b");
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
    enqueueBroadcastSend: async () => {},
    appBaseUrl: "https://app.example.test",
  });
});
afterAll(() => close());

const proFilter = {
  match: "all" as const,
  conditions: [{ field: "property:plan", op: "equals", value: "pro" }],
};

describe("segments API (/segments)", () => {
  let segmentId: string;

  it("requires an API key", async () => {
    expect((await app.request("/segments")).status).toBe(401);
  });

  it("creates a segment", async () => {
    const res = await call(tokenA, "POST", "/segments", {
      name: "pro users",
      filter: proFilter,
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.object).toBe("segment");
    expect(body.filter).toEqual(proFilter);
    segmentId = body.id as string;
  });

  it("gets a segment with its live contact_count", async () => {
    const res = await call(tokenA, "GET", `/segments/${segmentId}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    // Only pro@example.com matches property:plan = pro.
    expect(body.contact_count).toBe(1);
  });

  it("lists segments for the team", async () => {
    const res = await call(tokenA, "GET", "/segments");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.object).toBe("list");
    expect(body.data?.map((s) => s.id)).toContain(segmentId);
  });

  it("updates a segment's name and filter", async () => {
    const res = await call(tokenA, "PATCH", `/segments/${segmentId}`, {
      name: "renamed",
      filter: { match: "any", conditions: [] },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).name).toBe("renamed");
    // Empty conditions => every contact of the team (2 contacts).
    const got = await json(await call(tokenA, "GET", `/segments/${segmentId}`));
    expect(got.contact_count).toBe(2);
  });

  it("422s a malformed filter (unknown field) and never stores it", async () => {
    const res = await call(tokenA, "POST", "/segments", {
      name: "bad",
      filter: { match: "all", conditions: [{ field: "ssn", op: "equals", value: "x" }] },
    });
    expect(res.status).toBe(422);
    expect((await json(res)).name).toBe("validation_error");
  });

  it("422s an operator not valid for the field", async () => {
    const res = await call(tokenA, "POST", "/segments", {
      name: "bad-op",
      filter: { match: "all", conditions: [{ field: "email", op: "is_true", value: null }] },
    });
    expect(res.status).toBe(422);
  });

  it("stores a hostile filter value as data (parameterized), matching nothing", async () => {
    const res = await call(tokenA, "POST", "/segments", {
      name: "injection",
      filter: {
        match: "all",
        conditions: [{ field: "property:plan", op: "equals", value: "x' OR '1'='1" }],
      },
    });
    expect(res.status).toBe(200);
    const id = (await json(res)).id as string;
    const got = await json(await call(tokenA, "GET", `/segments/${id}`));
    expect(got.contact_count).toBe(0);
  });

  it("isolates segments by team (tenant isolation)", async () => {
    expect((await call(tokenB, "GET", `/segments/${segmentId}`)).status).toBe(404);
    expect((await call(tokenB, "PATCH", `/segments/${segmentId}`, { name: "x" })).status).toBe(404);
    expect((await call(tokenB, "DELETE", `/segments/${segmentId}`)).status).toBe(404);
    const list = await json(await call(tokenB, "GET", "/segments"));
    expect(list.data?.map((s) => s.id)).not.toContain(segmentId);
  });

  it("counts only the owning team's contacts", async () => {
    // Team B's catch-all segment must not see team A's contacts.
    const res = await call(tokenB, "POST", "/segments", {
      name: "everyone",
      filter: { match: "any", conditions: [] },
    });
    const id = (await json(res)).id as string;
    const got = await json(await call(tokenB, "GET", `/segments/${id}`));
    expect(got.contact_count).toBe(2);
  });

  it("deletes a segment", async () => {
    expect((await call(tokenA, "DELETE", `/segments/${segmentId}`)).status).toBe(200);
    expect((await call(tokenA, "GET", `/segments/${segmentId}`)).status).toBe(404);
  });
});

describe("broadcasts + segments", () => {
  it("links a segment on create and returns it as segment_id", async () => {
    const seg = await json(
      await call(tokenA, "POST", "/segments", { name: "b-seg", filter: proFilter }),
    );
    const created = await json(
      await call(tokenA, "POST", "/broadcasts", {
        segment_id: seg.id,
        from: "Acme <hi@acme.dev>",
        subject: "hello",
        html: "<p>hi</p>",
      }),
    );
    const got = await json(await call(tokenA, "GET", `/broadcasts/${created.id}`));
    expect(got.segment_id).toBe(seg.id);
    const deletion = await call(tokenA, "DELETE", `/segments/${String(seg.id)}`);
    expect(deletion.status).toBe(409);
    expect(await json(deletion)).toMatchObject({ name: "conflict" });
  });

  it("422s a segment_id another team owns", async () => {
    const seg = await json(
      await call(tokenB, "POST", "/segments", { name: "b-only", filter: proFilter }),
    );
    const res = await call(tokenA, "POST", "/broadcasts", {
      segment_id: seg.id,
      from: "Acme <hi@acme.dev>",
      subject: "hello",
      html: "<p>hi</p>",
    });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ name: "validation_error" });
  });
});
