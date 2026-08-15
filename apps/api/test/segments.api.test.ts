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
let audienceA: string;
let audienceB: string;

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

async function seedTeam(slug: string): Promise<{ token: string; audienceId: string }> {
  const teamId = await createTeam(db, slug);
  const key = generateApiKey("live");
  await db.insert(schema.apiKeys).values({
    teamId,
    name: slug,
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  const [aud] = await db
    .insert(schema.audiences)
    .values({ teamId, name: "news" })
    .returning({ id: schema.audiences.id });
  if (!aud) throw new Error("audience insert failed");
  await db.insert(schema.contacts).values([
    { audienceId: aud.id, teamId, email: "pro@example.com", properties: { plan: "pro" } },
    { audienceId: aud.id, teamId, email: "free@example.com", properties: { plan: "free" } },
  ]);
  return { token: key.token, audienceId: aud.id };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ({ token: tokenA, audienceId: audienceA } = await seedTeam("seg-a"));
  ({ token: tokenB, audienceId: audienceB } = await seedTeam("seg-b"));
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

describe("segments API (/segments2)", () => {
  let segmentId: string;

  it("requires an API key", async () => {
    expect((await app.request("/segments2")).status).toBe(401);
  });

  it("does not collide with the resend /segments audiences alias", async () => {
    // POST /segments is the audiences alias (object: "segment", takes only name);
    // POST /segments2 is the real feature (takes audience_id + filter). Distinct.
    const alias = await call(tokenA, "POST", "/segments", { name: "alias-audience" });
    expect(alias.status).toBe(200);
    expect((await json(alias)).object).toBe("segment");
  });

  it("creates a segment", async () => {
    const res = await call(tokenA, "POST", "/segments2", {
      name: "pro users",
      audience_id: audienceA,
      filter: proFilter,
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.object).toBe("segment");
    expect(body.audience_id).toBe(audienceA);
    expect(body.filter).toEqual(proFilter);
    segmentId = body.id as string;
  });

  it("gets a segment with its live contact_count", async () => {
    const res = await call(tokenA, "GET", `/segments2/${segmentId}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    // Only pro@example.com matches property:plan = pro.
    expect(body.contact_count).toBe(1);
  });

  it("lists segments for the team", async () => {
    const res = await call(tokenA, "GET", "/segments2");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.object).toBe("list");
    expect(body.data?.map((s) => s.id)).toContain(segmentId);
  });

  it("updates a segment's name and filter", async () => {
    const res = await call(tokenA, "PATCH", `/segments2/${segmentId}`, {
      name: "renamed",
      filter: { match: "any", conditions: [] },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).name).toBe("renamed");
    // Empty conditions => everyone in the audience (2 contacts).
    const got = await json(await call(tokenA, "GET", `/segments2/${segmentId}`));
    expect(got.contact_count).toBe(2);
  });

  it("422s a malformed filter (unknown field) and never stores it", async () => {
    const res = await call(tokenA, "POST", "/segments2", {
      name: "bad",
      audience_id: audienceA,
      filter: { match: "all", conditions: [{ field: "ssn", op: "equals", value: "x" }] },
    });
    expect(res.status).toBe(422);
    expect((await json(res)).name).toBe("validation_error");
  });

  it("422s an operator not valid for the field", async () => {
    const res = await call(tokenA, "POST", "/segments2", {
      name: "bad-op",
      audience_id: audienceA,
      filter: { match: "all", conditions: [{ field: "email", op: "is_true", value: null }] },
    });
    expect(res.status).toBe(422);
  });

  it("stores a hostile filter value as data (parameterized), matching nothing", async () => {
    const res = await call(tokenA, "POST", "/segments2", {
      name: "injection",
      audience_id: audienceA,
      filter: {
        match: "all",
        conditions: [{ field: "property:plan", op: "equals", value: "x' OR '1'='1" }],
      },
    });
    expect(res.status).toBe(200);
    const id = (await json(res)).id as string;
    const got = await json(await call(tokenA, "GET", `/segments2/${id}`));
    expect(got.contact_count).toBe(0);
  });

  it("404s creating a segment on another team's audience", async () => {
    const res = await call(tokenA, "POST", "/segments2", {
      name: "cross",
      audience_id: audienceB,
      filter: proFilter,
    });
    expect(res.status).toBe(404);
  });

  it("isolates segments by team (tenant isolation)", async () => {
    expect((await call(tokenB, "GET", `/segments2/${segmentId}`)).status).toBe(404);
    expect((await call(tokenB, "PATCH", `/segments2/${segmentId}`, { name: "x" })).status).toBe(
      404,
    );
    expect((await call(tokenB, "DELETE", `/segments2/${segmentId}`)).status).toBe(404);
    const list = await json(await call(tokenB, "GET", "/segments2"));
    expect(list.data?.map((s) => s.id)).not.toContain(segmentId);
  });

  it("deletes a segment", async () => {
    expect((await call(tokenA, "DELETE", `/segments2/${segmentId}`)).status).toBe(200);
    expect((await call(tokenA, "GET", `/segments2/${segmentId}`)).status).toBe(404);
  });
});

describe("broadcasts + real segments", () => {
  it("links a real segment on create and returns it as segment_id", async () => {
    const seg = await json(
      await call(tokenA, "POST", "/segments2", {
        name: "b-seg",
        audience_id: audienceA,
        filter: proFilter,
      }),
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
    // Real segment surfaces as segment_id; audience derived from the segment.
    expect(got.segment_id).toBe(seg.id);
    expect(got.audience_id).toBe(audienceA);
  });

  it("keeps the resend alias when segment_id names an audience, not a segment", async () => {
    const created = await json(
      await call(tokenA, "POST", "/broadcasts", {
        segment_id: audienceA,
        from: "Acme <hi@acme.dev>",
        subject: "hello",
        html: "<p>hi</p>",
      }),
    );
    const got = await json(await call(tokenA, "GET", `/broadcasts/${created.id}`));
    // No real segment linked → segment_id echoes the audience (resend alias).
    expect(got.segment_id).toBe(audienceA);
    expect(got.audience_id).toBe(audienceA);
  });
});
