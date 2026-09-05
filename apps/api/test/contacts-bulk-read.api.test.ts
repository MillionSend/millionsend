import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

/**
 * Bulk reads (MillionSend extension): `include=properties,topics` on the
 * contact lists, and POST /contacts/batch/get by id or email. Without
 * `include` the list item keeps the Resend shape, key for key.
 */

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let token: string;
let otherToken: string;
let topicId: string;
let segmentId: string;
const ids: Record<string, string> = {};

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

async function call(key: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
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
  return key.token;
}

type Item = {
  id: string;
  email: string;
  properties?: Record<string, { type: string; value: unknown }>;
  topics?: { id: string; subscription: string; explicit: boolean }[];
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  token = await seedTeam("bulk-read-a");
  otherToken = await seedTeam("bulk-read-b");
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
  });
  expect(
    (await call(token, "POST", "/contact-properties", { key: "seats", type: "number" })).status,
  ).toBeLessThan(300);
  const topic = await call(token, "POST", "/topics", {
    name: "Newsletter",
    default_subscription: "opt_in",
  });
  topicId = (await json(topic)).id as string;
  const segment = await call(token, "POST", "/segments", { name: "readers" });
  segmentId = (await json(segment)).id as string;
  for (const [email, properties, subscription] of [
    ["ada@example.com", { plan: "pro", seats: 3 }, "opt_out"],
    ["bob@example.com", { plan: "free" }, "opt_in"],
    ["cy@example.com", {}, undefined],
  ] as const) {
    const created = await call(token, "POST", "/contacts", {
      email,
      properties,
      segments: [{ id: segmentId }],
      ...(subscription ? { topics: [{ id: topicId, subscription }] } : {}),
    });
    expect(created.status).toBeLessThan(300);
    ids[email] = (await json(created)).id as string;
  }
});
afterAll(() => close());

describe("GET /contacts?include=", () => {
  it("keeps the Resend item shape when include is absent", async () => {
    const res = await call(token, "GET", "/contacts?limit=10");
    expect(res.status).toBe(200);
    const items = (await json(res)).data as Item[];
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(
        ["created_at", "email", "first_name", "id", "last_name", "unsubscribed"].sort(),
      );
    }
  });

  it("attaches properties and topics to every item, typed as the single GET does", async () => {
    const res = await call(token, "GET", "/contacts?limit=10&include=properties,topics");
    expect(res.status).toBe(200);
    const items = (await json(res)).data as Item[];
    const ada = items.find((i) => i.email === "ada@example.com");
    expect(ada?.properties).toEqual({
      plan: { type: "string", value: "pro" },
      seats: { type: "number", value: 3 },
    });
    expect(ada?.topics).toEqual([
      expect.objectContaining({ id: topicId, subscription: "opt_out", explicit: true }),
    ]);
    const cy = items.find((i) => i.email === "cy@example.com");
    expect(cy?.properties).toEqual({});
    expect(cy?.topics).toEqual([
      expect.objectContaining({ id: topicId, subscription: "opt_in", explicit: false }),
    ]);
  });

  it("attaches one facet alone, and pages with the cursor as before", async () => {
    const first = await call(token, "GET", "/contacts?limit=2&include=topics");
    const page1 = (await json(first)).data as Item[];
    expect(page1[0]?.topics).toBeDefined();
    expect(page1[0]?.properties).toBeUndefined();
    const second = await call(
      token,
      "GET",
      `/contacts?limit=2&include=topics&after=${page1.at(-1)?.id}`,
    );
    const page2 = (await json(second)).data as Item[];
    expect(page2).toHaveLength(1);
    expect(page2[0]?.topics).toHaveLength(1);
  });

  it("accepts the percent-encoded comma every SDK's query encoder produces", async () => {
    const res = await call(token, "GET", "/contacts?limit=1&include=properties%2Ctopics");
    expect(res.status).toBe(200);
    const [item] = (await json(res)).data as Item[];
    expect(item?.properties).toBeDefined();
    expect(item?.topics).toBeDefined();
  });

  it("rejects unknown facets with 422", async () => {
    const res = await call(token, "GET", "/contacts?include=segments");
    expect(res.status).toBe(422);
  });

  it("works on the segment list too", async () => {
    const res = await call(token, "GET", `/segments/${segmentId}/contacts?include=properties`);
    expect(res.status).toBe(200);
    const items = (await json(res)).data as Item[];
    expect(items).toHaveLength(3);
    expect(items.find((i) => i.email === "bob@example.com")?.properties).toEqual({
      plan: { type: "string", value: "free" },
    });
  });
});

describe("POST /contacts/batch/get", () => {
  it("returns the contacts in request order, by id or case-insensitive email, and lists the missing", async () => {
    const res = await call(token, "POST", "/contacts/batch/get", {
      contacts: [
        { email: "BOB@example.com" },
        { id: ids["ada@example.com"] },
        { email: "nobody@example.com" },
        { id: "00000000-0000-4000-8000-000000000000" },
        { email: "cy@example.com" },
      ],
      include: ["properties", "topics"],
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.object).toBe("list");
    const data = body.data as (Item & { object: string })[];
    expect(data.map((c) => c.email)).toEqual([
      "bob@example.com",
      "ada@example.com",
      "cy@example.com",
    ]);
    expect(data[0]?.object).toBe("contact");
    expect(data[1]?.properties).toEqual({
      plan: { type: "string", value: "pro" },
      seats: { type: "number", value: 3 },
    });
    expect(data[1]?.topics?.[0]).toMatchObject({ subscription: "opt_out", explicit: true });
    expect(body.missing).toEqual([
      { index: 2, email: "nobody@example.com" },
      { index: 3, id: "00000000-0000-4000-8000-000000000000" },
    ]);
  });

  it("without include returns the plain contact objects", async () => {
    const res = await call(token, "POST", "/contacts/batch/get", {
      contacts: [{ email: "ada@example.com" }],
    });
    const data = (await json(res)).data as Item[];
    expect(Object.keys(data[0] ?? {}).sort()).toEqual(
      ["created_at", "email", "first_name", "id", "last_name", "object", "unsubscribed"].sort(),
    );
  });

  it("never crosses teams", async () => {
    const res = await call(otherToken, "POST", "/contacts/batch/get", {
      contacts: [{ email: "ada@example.com" }, { id: ids["bob@example.com"] }],
    });
    const body = await json(res);
    expect(body.data).toEqual([]);
    expect((body.missing as unknown[]).length).toBe(2);
  });

  it("422s an entry with both or neither key, an empty list, and more than 1000 entries", async () => {
    for (const contacts of [
      [{ id: ids["ada@example.com"], email: "ada@example.com" }],
      [{}],
      [],
      Array.from({ length: 1001 }, (_, i) => ({ email: `m${i}@example.com` })),
    ]) {
      const res = await call(token, "POST", "/contacts/batch/get", { contacts });
      expect(res.status).toBe(422);
    }
    expect(
      (
        await call(token, "POST", "/contacts/batch/get", {
          contacts: [{ email: "ada@example.com" }],
          include: ["segments"],
        })
      ).status,
    ).toBe(422);
  });
});
