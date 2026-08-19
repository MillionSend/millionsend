import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

/**
 * Segment membership + resolution endpoints: contacts.segments.add/remove,
 * contact creation with segments/topics, GET /segments/{id}/contacts (the
 * SDK's contacts.list({segmentId})), manual segments (null filter), and the
 * legacy /audiences/{id}/contacts aliases.
 */

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let tokenA: string;
let tokenB: string;
let teamAId: string;

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

async function seedTeam(slug: string): Promise<{ teamId: string; token: string }> {
  const teamId = await createTeam(db, slug);
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: slug,
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  return { teamId, token: key.token };
}

const createSegment = async (token: string, body: Record<string, unknown>) =>
  json(await call(token, "POST", "/segments", body));

const createContact = async (token: string, body: Record<string, unknown>) =>
  call(token, "POST", "/contacts", body);

const segmentEmails = async (token: string, segmentId: string): Promise<string[]> => {
  const body = await json(await call(token, "GET", `/segments/${segmentId}/contacts`));
  return (body.data ?? []).map((r) => r.email as string).sort();
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ({ teamId: teamAId, token: tokenA } = await seedTeam("csa"));
  ({ token: tokenB } = await seedTeam("csb"));
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
  });
});
afterAll(() => close());

describe("segment membership (POST/DELETE /contacts/{id}/segments/{segmentId})", () => {
  let segmentId: string;
  let contactId: string;

  beforeAll(async () => {
    segmentId = (await createSegment(tokenA, { name: "members-only" })).id as string;
    const created = await json(await createContact(tokenA, { email: "member@example.com" }));
    contactId = created.id as string;
  });

  it("adds by contact uuid and is idempotent on re-add", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await call(tokenA, "POST", `/contacts/${contactId}/segments/${segmentId}`);
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ id: contactId });
    }
    expect(await segmentEmails(tokenA, segmentId)).toEqual(["member@example.com"]);
  });

  it("adds by email (case-insensitive), like the other contact routes", async () => {
    const res = await call(
      tokenA,
      "POST",
      `/contacts/${encodeURIComponent("Member@Example.COM")}/segments/${segmentId}`,
    );
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ id: contactId });
  });

  it("404s adding to another team's segment (tenant isolation)", async () => {
    const foreign = (await createSegment(tokenB, { name: "b-seg" })).id as string;
    const res = await call(tokenA, "POST", `/contacts/${contactId}/segments/${foreign}`);
    expect(res.status).toBe(404);
    const memberships = await db
      .select()
      .from(schema.segmentMembers)
      .where(eq(schema.segmentMembers.segmentId, foreign));
    expect(memberships).toHaveLength(0);
  });

  it("404s for an unknown contact", async () => {
    const res = await call(tokenA, "POST", `/contacts/ghost@example.com/segments/${segmentId}`);
    expect(res.status).toBe(404);
  });

  it("removes a member and returns the wire shape; a non-member is 404", async () => {
    const res = await call(tokenA, "DELETE", `/contacts/${contactId}/segments/${segmentId}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ id: contactId, audienceId: segmentId, deleted: true });
    expect(await segmentEmails(tokenA, segmentId)).toEqual([]);

    const again = await call(tokenA, "DELETE", `/contacts/${contactId}/segments/${segmentId}`);
    expect(again.status).toBe(404);
    expect((await json(again)).name).toBe("not_found");
  });
});

describe("POST /contacts with segments and topics", () => {
  it("creates the contact with memberships and topic subscriptions atomically", async () => {
    const segmentId = (await createSegment(tokenA, { name: "welcomed" })).id as string;
    const topicRes = await call(tokenA, "POST", "/topics", {
      name: "newsletter",
      default_subscription: "opt_in",
    });
    const topicId = (await json(topicRes)).id as string;

    const res = await createContact(tokenA, {
      email: "joined@example.com",
      segments: [{ id: segmentId }],
      topics: [{ id: topicId, subscription: "opt_out" }],
    });
    expect(res.status).toBe(200);
    const contactId = (await json(res)).id as string;

    expect(await segmentEmails(tokenA, segmentId)).toEqual(["joined@example.com"]);
    const subs = await db
      .select()
      .from(schema.contactTopicSubscriptions)
      .where(eq(schema.contactTopicSubscriptions.contactId, contactId));
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ topicId, subscribed: false });
  });

  it("404s an unknown or foreign segment/topic and creates NOTHING (one transaction)", async () => {
    const foreignSegment = (await createSegment(tokenB, { name: "b-owned" })).id as string;
    for (const body of [
      { email: "never@example.com", segments: [{ id: foreignSegment }] },
      { email: "never@example.com", topics: [{ id: crypto.randomUUID(), subscription: "opt_in" }] },
    ]) {
      const res = await createContact(tokenA, body);
      expect(res.status).toBe(404);
      expect((await json(res)).name).toBe("not_found");
    }
    const rows = await db
      .select()
      .from(schema.contacts)
      .where(
        and(eq(schema.contacts.teamId, teamAId), eq(schema.contacts.email, "never@example.com")),
      );
    expect(rows).toHaveLength(0);
  });
});

describe("GET /segments/{id}/contacts (segment resolution)", () => {
  it("returns filter matches UNION manual members, deduplicated", async () => {
    await createContact(tokenA, { email: "vip1@example.com", properties: { tier: "vip" } });
    const segment = await createSegment(tokenA, {
      name: "vips-plus",
      filter: {
        match: "all",
        conditions: [{ field: "property:tier", op: "equals", value: "vip" }],
      },
    });
    const segmentId = segment.id as string;
    // vip1 matches the filter AND is added manually — must appear once.
    await call(tokenA, "POST", `/contacts/vip1@example.com/segments/${segmentId}`);
    const manual = await json(await createContact(tokenA, { email: "manual1@example.com" }));
    await call(tokenA, "POST", `/contacts/${manual.id as string}/segments/${segmentId}`);

    expect(await segmentEmails(tokenA, segmentId)).toEqual([
      "manual1@example.com",
      "vip1@example.com",
    ]);

    // The live contact_count uses the same resolver.
    const got = await json(await call(tokenA, "GET", `/segments/${segmentId}`));
    expect(got.contact_count).toBe(2);
  });

  it("404s a segment another team owns", async () => {
    const foreign = (await createSegment(tokenB, { name: "b-list" })).id as string;
    expect((await call(tokenA, "GET", `/segments/${foreign}/contacts`)).status).toBe(404);
  });

  it("paginates with limit/after", async () => {
    const segment = await createSegment(tokenA, { name: "paged" });
    const segmentId = segment.id as string;
    for (const email of ["p1@example.com", "p2@example.com", "p3@example.com"]) {
      await createContact(tokenA, { email });
      await call(tokenA, "POST", `/contacts/${email}/segments/${segmentId}`);
    }
    const first = await json(await call(tokenA, "GET", `/segments/${segmentId}/contacts?limit=2`));
    expect(first.data).toHaveLength(2);
    expect(first.has_more).toBe(true);
    const cursor = first.data?.[1]?.id as string;
    const rest = await json(
      await call(tokenA, "GET", `/segments/${segmentId}/contacts?limit=2&after=${cursor}`),
    );
    expect(rest.data).toHaveLength(1);
    expect(rest.has_more).toBe(false);
  });
});

describe("manual segments (optional / clearable filter)", () => {
  it("creates a name-only segment with filter null", async () => {
    const body = await createSegment(tokenA, { name: "hand-picked" });
    expect(body.object).toBe("segment");
    expect(body.filter).toBeNull();
    const got = await json(await call(tokenA, "GET", `/segments/${body.id as string}`));
    expect(got.filter).toBeNull();
    expect(got.contact_count).toBe(0);
  });

  it("PATCH sets and clears the filter", async () => {
    const id = (await createSegment(tokenA, { name: "mutable" })).id as string;
    const filter = {
      match: "all",
      conditions: [{ field: "email", op: "ends_with", value: "@example.com" }],
    };
    const set = await json(await call(tokenA, "PATCH", `/segments/${id}`, { filter }));
    expect(set.filter).toEqual(filter);
    const cleared = await json(await call(tokenA, "PATCH", `/segments/${id}`, { filter: null }));
    expect(cleared.filter).toBeNull();
  });
});

describe("legacy /audiences/{id}/contacts aliases", () => {
  let audienceId: string;

  beforeAll(async () => {
    audienceId = (await createSegment(tokenA, { name: "legacy-audience" })).id as string;
  });

  it("POST creates the contact AND joins it to the audience's segment", async () => {
    const res = await call(tokenA, "POST", `/audiences/${audienceId}/contacts`, {
      email: "legacy@example.com",
      first_name: "Leg",
    });
    expect(res.status).toBe(200);
    expect((await json(res)).object).toBe("contact");
    expect(await segmentEmails(tokenA, audienceId)).toEqual(["legacy@example.com"]);
  });

  it("GET/PATCH/DELETE work nested under the audience, by id or email", async () => {
    const got = await json(
      await call(tokenA, "GET", `/audiences/${audienceId}/contacts/legacy@example.com`),
    );
    expect(got).toMatchObject({ object: "contact", email: "legacy@example.com" });

    const patched = await call(tokenA, "PATCH", `/audiences/${audienceId}/contacts/${got.id}`, {
      first_name: "Renamed",
    });
    expect(patched.status).toBe(200);

    const deleted = await call(
      tokenA,
      "DELETE",
      `/audiences/${audienceId}/contacts/legacy@example.com`,
    );
    expect(deleted.status).toBe(200);
    expect(await json(deleted)).toMatchObject({ deleted: true });
  });

  it("404s a foreign or unknown audience on every alias (tenant isolation)", async () => {
    const foreign = (await createSegment(tokenB, { name: "b-audience" })).id as string;
    expect(
      (await call(tokenA, "POST", `/audiences/${foreign}/contacts`, { email: "x@example.com" }))
        .status,
    ).toBe(404);
    expect((await call(tokenA, "GET", `/audiences/${foreign}/contacts/x@example.com`)).status).toBe(
      404,
    );
    expect(
      (await call(tokenA, "PATCH", `/audiences/${foreign}/contacts/x@example.com`, {})).status,
    ).toBe(404);
    expect(
      (await call(tokenA, "DELETE", `/audiences/${foreign}/contacts/x@example.com`)).status,
    ).toBe(404);
  });

  it("requires an API key like every management surface", async () => {
    expect((await app.request(`/audiences/${audienceId}/contacts/x@example.com`)).status).toBe(401);
  });
});
