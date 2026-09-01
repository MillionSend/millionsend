import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey, hashRecipient } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

/**
 * POST /contacts/batch: strict vs permissive validation, the three
 * on_conflict modes (incl. the never-re-subscribe rule and intra-batch
 * duplicates), tenant isolation of associations, counts/order, size cap and
 * property coercion.
 */

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let tokenA: string;
let tokenB: string;
let teamAId: string;

type BatchBody = {
  data: { object: "contact"; index: number; id: string; status: string }[];
  counts: { created: number; updated: number; skipped: number; failed: number };
  errors?: { index: number; message: string }[];
};

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

async function call(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const batch = (
  items: unknown[],
  opts: { onConflict?: string; permissive?: boolean; token?: string } = {},
) =>
  call(
    opts.token ?? tokenA,
    "POST",
    `/contacts/batch${opts.onConflict ? `?on_conflict=${opts.onConflict}` : ""}`,
    items,
    opts.permissive ? { "x-batch-validation": "permissive" } : {},
  );

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

const createSegment = async (token: string, name: string) =>
  (await json(await call(token, "POST", "/segments", { name }))).id as string;

const createTopic = async (token: string, name: string, defaultSubscription = "opt_in") =>
  (
    await json(
      await call(token, "POST", "/topics", { name, default_subscription: defaultSubscription }),
    )
  ).id as string;

const contactByEmail = async (email: string) =>
  (
    await db
      .select()
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.teamId, teamAId),
          sql`lower(${schema.contacts.email}) = ${email.toLowerCase()}`,
        ),
      )
  )[0];

const teamContactCount = async () =>
  (await db.select().from(schema.contacts).where(eq(schema.contacts.teamId, teamAId))).length;

const memberSegments = async (contactId: string) =>
  (
    await db
      .select({ segmentId: schema.segmentMembers.segmentId })
      .from(schema.segmentMembers)
      .where(eq(schema.segmentMembers.contactId, contactId))
  )
    .map((r) => r.segmentId)
    .sort();

const topicSubs = async (contactId: string) =>
  Object.fromEntries(
    (
      await db
        .select({
          topicId: schema.contactTopicSubscriptions.topicId,
          subscribed: schema.contactTopicSubscriptions.subscribed,
        })
        .from(schema.contactTopicSubscriptions)
        .where(eq(schema.contactTopicSubscriptions.contactId, contactId))
    ).map((r) => [r.topicId, r.subscribed]),
  );

const activityTypes = async (contactId: string) =>
  (
    await db
      .select({ type: schema.contactActivities.type })
      .from(schema.contactActivities)
      .where(eq(schema.contactActivities.contactId, contactId))
  )
    .map((r) => r.type)
    .sort();

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ({ teamId: teamAId, token: tokenA } = await seedTeam("batch-a"));
  ({ token: tokenB } = await seedTeam("batch-b"));
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
  });
});
afterAll(() => close());

describe("validation modes", () => {
  it("strict (default) rejects the whole batch on one bad item with the index prefix and zero writes", async () => {
    const before = await teamContactCount();
    const res = await batch([{ email: "ok-strict@example.com" }, { email: "not-an-email" }]);
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.name).toBe("validation_error");
    expect(body.message).toMatch(/^contacts\.1: email: /);
    expect(await teamContactCount()).toBe(before);
    expect(await contactByEmail("ok-strict@example.com")).toBeUndefined();
  });

  it("permissive writes the valid subset and reports the rest in errors", async () => {
    const res = await batch(
      [{ email: "perm-1@example.com" }, { email: "nope" }, { email: "perm-2@example.com" }],
      { permissive: true },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as BatchBody;
    expect(body.data.map((d) => [d.index, d.status])).toEqual([
      [0, "created"],
      [2, "created"],
    ]);
    expect(body.errors).toHaveLength(1);
    expect(body.errors?.[0]?.index).toBe(1);
    expect(body.errors?.[0]?.message).toMatch(/^email: /);
    expect(body.counts).toEqual({ created: 2, updated: 0, skipped: 0, failed: 1 });
    expect((await contactByEmail("perm-1@example.com"))?.id).toBe(body.data[0]?.id);
  });

  it("strict responses carry no errors array; an unknown header value or on_conflict is 422", async () => {
    const ok = (await (await batch([{ email: "no-errors@example.com" }])).json()) as BatchBody;
    expect(ok.errors).toBeUndefined();
    expect(ok.counts).toEqual({ created: 1, updated: 0, skipped: 0, failed: 0 });

    // Header values are case-insensitive, like on /emails/batch.
    const mixedCase = await call(
      tokenA,
      "POST",
      "/contacts/batch",
      [{ email: "cased-ok@example.com" }, { email: "nope" }],
      { "x-batch-validation": "Permissive" },
    );
    expect(mixedCase.status).toBe(200);
    expect(((await mixedCase.json()) as BatchBody).counts.failed).toBe(1);

    const badHeader = await call(tokenA, "POST", "/contacts/batch", [{ email: "x@example.com" }], {
      "x-batch-validation": "lenient",
    });
    expect(badHeader.status).toBe(422);
    const badMode = await batch([{ email: "x@example.com" }], { onConflict: "merge" });
    expect(badMode.status).toBe(422);
  });

  it("rejects more than 1000 items with 422 and an empty array too", async () => {
    const tooMany = Array.from({ length: 1001 }, (_, i) => ({ email: `many-${i}@example.com` }));
    const res = await batch(tooMany);
    expect(res.status).toBe(422);
    expect((await json(res)).name).toBe("validation_error");
    expect(await contactByEmail("many-0@example.com")).toBeUndefined();
    expect((await batch([])).status).toBe(422);
  });
});

describe("on_conflict", () => {
  it("error (default): an existing email is 409 in strict, a failed item in permissive", async () => {
    const seed = (await (await batch([{ email: "Dup@Example.com" }])).json()) as BatchBody;
    const existingId = seed.data[0]?.id;

    const strict = await batch([{ email: "fresh-1@example.com" }, { email: "dup@example.com" }]);
    expect(strict.status).toBe(409);
    const body = await json(strict);
    expect(body.name).toBe("validation_error");
    expect(body.message).toBe("contacts.1: Contact already exists");
    expect(await contactByEmail("fresh-1@example.com")).toBeUndefined();

    const permissive = (await (
      await batch([{ email: "fresh-1@example.com" }, { email: "DUP@example.com" }], {
        permissive: true,
      })
    ).json()) as BatchBody;
    expect(permissive.data).toEqual([
      { object: "contact", index: 0, id: expect.any(String), status: "created" },
    ]);
    expect(permissive.errors).toEqual([{ index: 1, message: "Contact already exists" }]);
    expect((await contactByEmail("dup@example.com"))?.id).toBe(existingId);
  });

  it("skip: the existing contact is untouched and reported with its id", async () => {
    const seed = (await (
      await batch([{ email: "skipme@example.com", first_name: "Original" }])
    ).json()) as BatchBody;
    const existingId = seed.data[0]?.id as string;

    const res = (await (
      await batch(
        [{ email: "SKIPME@example.com", first_name: "Changed" }, { email: "skip-new@example.com" }],
        { onConflict: "skip" },
      )
    ).json()) as BatchBody;
    expect(res.data).toEqual([
      { object: "contact", index: 0, id: existingId, status: "skipped" },
      { object: "contact", index: 1, id: expect.any(String), status: "created" },
    ]);
    expect(res.counts).toEqual({ created: 1, updated: 0, skipped: 1, failed: 0 });
    expect((await contactByEmail("skipme@example.com"))?.firstName).toBe("Original");
  });

  it("upsert: merges scalars/properties, adds segments idempotently, upserts topics", async () => {
    const segA = await createSegment(tokenA, "ups-a");
    const segB = await createSegment(tokenA, "ups-b");
    const topic = await createTopic(tokenA, "ups-topic");
    const seed = (await (
      await batch([
        {
          email: "ups@example.com",
          first_name: "First",
          last_name: "Last",
          properties: { plan: "free", city: "Lisbon" },
          segments: [{ id: segA }],
          topics: [{ id: topic, subscription: "opt_out" }],
        },
      ])
    ).json()) as BatchBody;
    const id = seed.data[0]?.id as string;

    const res = (await (
      await batch(
        [
          {
            email: "UPS@example.com",
            first_name: "Renamed",
            properties: { plan: "pro", seats: 3 },
            segments: [{ id: segA }, { id: segB }],
            topics: [{ id: topic, subscription: "opt_in" }],
          },
        ],
        { onConflict: "upsert" },
      )
    ).json()) as BatchBody;
    expect(res.data).toEqual([{ object: "contact", index: 0, id, status: "updated" }]);
    expect(res.counts).toEqual({ created: 0, updated: 1, skipped: 0, failed: 0 });

    const row = await contactByEmail("ups@example.com");
    expect(row?.firstName).toBe("Renamed");
    expect(row?.lastName).toBe("Last");
    expect(row?.properties).toEqual({ plan: "pro", city: "Lisbon", seats: "3" });
    expect(await memberSegments(id)).toEqual([segA, segB].sort());
    expect(await topicSubs(id)).toEqual({ [topic]: true });
    expect(await activityTypes(id)).toEqual(
      ["contact_created", "topic_opt_out", "segment_added", "segment_added", "topic_opt_in"].sort(),
    );
  });

  it("upsert never re-subscribes: unsubscribed:true sticks, unsubscribed:false is ignored", async () => {
    const email = "optout@example.com";
    await db.insert(schema.suppressions).values({
      teamId: teamAId,
      email,
      emailHash: hashRecipient(email),
      reason: "one_click_unsubscribe",
    });
    const seed = (await (await batch([{ email }])).json()) as BatchBody;
    const id = seed.data[0]?.id as string;

    expect((await batch([{ email, unsubscribed: true }], { onConflict: "upsert" })).status).toBe(
      200,
    );
    let row = await contactByEmail(email);
    expect(row?.unsubscribed).toBe(true);
    expect(row?.unsubscribedAt).toBeInstanceOf(Date);
    const unsubscribedAt = row?.unsubscribedAt;

    const res = (await (
      await batch([{ email, unsubscribed: false, first_name: "Still" }], { onConflict: "upsert" })
    ).json()) as BatchBody;
    expect(res.data[0]?.status).toBe("updated");
    row = await contactByEmail(email);
    expect(row?.unsubscribed).toBe(true);
    expect(row?.unsubscribedAt).toEqual(unsubscribedAt);
    expect(row?.firstName).toBe("Still");
    expect((await activityTypes(id)).filter((t) => t === "unsubscribed")).toHaveLength(1);
    expect(await activityTypes(id)).not.toContain("resubscribed");

    const suppressions = await db
      .select()
      .from(schema.suppressions)
      .where(
        and(
          eq(schema.suppressions.teamId, teamAId),
          eq(schema.suppressions.emailHash, hashRecipient(email)),
        ),
      );
    expect(suppressions).toHaveLength(1);
  });
});

describe("intra-batch duplicates (case-insensitive)", () => {
  it("error: the later occurrence fails", async () => {
    const strict = await batch([{ email: "twice@example.com" }, { email: "TWICE@example.com" }]);
    expect(strict.status).toBe(422);
    expect((await json(strict)).message).toBe("contacts.1: Duplicate email in batch");
    expect(await contactByEmail("twice@example.com")).toBeUndefined();

    const permissive = (await (
      await batch([{ email: "twice@example.com" }, { email: "TWICE@example.com" }], {
        permissive: true,
      })
    ).json()) as BatchBody;
    expect(permissive.data.map((d) => d.index)).toEqual([0]);
    expect(permissive.errors).toEqual([{ index: 1, message: "Duplicate email in batch" }]);
    expect(permissive.counts).toEqual({ created: 1, updated: 0, skipped: 0, failed: 1 });
  });

  it("skip: the first occurrence wins, later ones are skipped with its id", async () => {
    const res = (await (
      await batch(
        [
          { email: "first@example.com", first_name: "One" },
          { email: "FIRST@example.com", first_name: "Two" },
        ],
        { onConflict: "skip" },
      )
    ).json()) as BatchBody;
    const id = res.data[0]?.id;
    expect(res.data).toEqual([
      { object: "contact", index: 0, id, status: "created" },
      { object: "contact", index: 1, id, status: "skipped" },
    ]);
    expect(res.counts).toEqual({ created: 1, updated: 0, skipped: 1, failed: 0 });
    expect((await contactByEmail("first@example.com"))?.firstName).toBe("One");
  });

  it("upsert: collapses into one row — later scalars win, associations union", async () => {
    const segA = await createSegment(tokenA, "col-a");
    const segB = await createSegment(tokenA, "col-b");
    const topic = await createTopic(tokenA, "col-topic");
    const res = (await (
      await batch(
        [
          {
            email: "collapse@example.com",
            first_name: "A",
            last_name: "L",
            properties: { a: "1" },
            segments: [{ id: segA }],
            topics: [{ id: topic, subscription: "opt_out" }],
          },
          {
            email: "Collapse@example.com",
            first_name: "B",
            properties: { b: "2" },
            segments: [{ id: segB }],
            topics: [{ id: topic, subscription: "opt_in" }],
          },
        ],
        { onConflict: "upsert" },
      )
    ).json()) as BatchBody;
    const id = res.data[0]?.id as string;
    expect(res.data).toEqual([
      { object: "contact", index: 0, id, status: "created" },
      { object: "contact", index: 1, id, status: "created" },
    ]);
    expect(res.counts).toEqual({ created: 2, updated: 0, skipped: 0, failed: 0 });
    expect(await teamContactCount()).toBeGreaterThan(0);
    const row = await contactByEmail("collapse@example.com");
    expect(row?.firstName).toBe("B");
    expect(row?.lastName).toBe("L");
    expect(row?.properties).toEqual({ a: "1", b: "2" });
    expect(await memberSegments(id)).toEqual([segA, segB].sort());
    expect(await topicSubs(id)).toEqual({ [topic]: true });
  });
});

describe("associations", () => {
  it("404s a foreign team's segment (strict) and fails only that item in permissive, writing no membership", async () => {
    const foreign = await createSegment(tokenB, "b-only");
    const own = await createSegment(tokenA, "a-own");
    const strict = await batch([
      { email: "iso-1@example.com", segments: [{ id: own }] },
      { email: "iso-2@example.com", segments: [{ id: foreign }] },
    ]);
    expect(strict.status).toBe(404);
    expect(await json(strict)).toEqual({
      statusCode: 404,
      name: "not_found",
      message: "contacts.1: Segment not found",
    });
    expect(await contactByEmail("iso-1@example.com")).toBeUndefined();

    const permissive = (await (
      await batch(
        [
          { email: "iso-1@example.com", segments: [{ id: own }] },
          { email: "iso-2@example.com", segments: [{ id: foreign }] },
        ],
        { permissive: true },
      )
    ).json()) as BatchBody;
    expect(permissive.data.map((d) => d.index)).toEqual([0]);
    expect(permissive.errors).toEqual([{ index: 1, message: "Segment not found" }]);
    expect(await contactByEmail("iso-2@example.com")).toBeUndefined();
    const foreignMembers = await db
      .select()
      .from(schema.segmentMembers)
      .where(eq(schema.segmentMembers.segmentId, foreign));
    expect(foreignMembers).toHaveLength(0);
  });

  it("404s an unknown topic", async () => {
    const res = await batch([
      { email: "t@example.com", topics: [{ id: crypto.randomUUID(), subscription: "opt_in" }] },
    ]);
    expect(res.status).toBe(404);
    expect((await json(res)).message).toBe("contacts.0: Topic not found");
  });
});

describe("properties", () => {
  it("coerces against the team's typed definitions: a non-numeric value for a number property is 422", async () => {
    expect(
      (await call(tokenA, "POST", "/contact-properties", { key: "age", type: "number" })).status,
    ).toBe(200);
    const bad = await batch([
      { email: "num-ok@example.com", properties: { age: 41 } },
      { email: "num-bad@example.com", properties: { age: "forty" } },
    ]);
    expect(bad.status).toBe(422);
    expect((await json(bad)).message).toBe('contacts.1: property "age" must be a number');
    expect(await contactByEmail("num-ok@example.com")).toBeUndefined();

    const ok = (await (
      await batch([{ email: "num-ok@example.com", properties: { Age: "42" } }])
    ).json()) as BatchBody;
    expect(ok.counts.created).toBe(1);
    expect((await contactByEmail("num-ok@example.com"))?.properties).toEqual({ Age: "42" });
  });
});

describe("counts and order", () => {
  it("returns data in request order across mixed statuses", async () => {
    await batch([{ email: "mix-existing@example.com" }]);
    const res = (await (
      await batch(
        [
          { email: "mix-new-1@example.com" },
          { email: "mix-existing@example.com", first_name: "U" },
          { email: "broken" },
          { email: "mix-new-2@example.com" },
        ],
        { onConflict: "upsert", permissive: true },
      )
    ).json()) as BatchBody;
    expect(res.data.map((d) => [d.index, d.status])).toEqual([
      [0, "created"],
      [1, "updated"],
      [3, "created"],
    ]);
    expect(res.errors?.map((e) => e.index)).toEqual([2]);
    expect(res.counts).toEqual({ created: 2, updated: 1, skipped: 0, failed: 1 });
  });

  it("POST /contacts still creates and 409s through the shared op", async () => {
    const created = await call(tokenA, "POST", "/contacts", { email: "single@example.com" });
    expect(created.status).toBe(200);
    expect(await activityTypes((await json(created)).id as string)).toEqual(["contact_created"]);
    const again = await call(tokenA, "POST", "/contacts", { email: "SINGLE@example.com" });
    expect(again.status).toBe(409);
    expect((await json(again)).message).toBe("Contact already exists");
  });
});
