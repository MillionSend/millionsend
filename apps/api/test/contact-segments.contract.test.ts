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
 * Wire-compat gate for the SDK's segment-membership surface: contacts.create
 * with segments/topics, contacts.segments.add/remove, contacts.list with
 * segmentId (GET /segments/{id}/contacts), the audiences alias
 * (resend.audiences === resend.segments), and the legacy audienceId branches
 * of contacts.create/get/remove (/audiences/{id}/contacts paths).
 */

let db: Db;
let closeDb: () => Promise<void>;
let server: ServerType;
let resend: Resend;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  const teamId = await createTeam(db, "contact-segments");
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

describe("official resend SDK: segments membership + audiences alias", () => {
  let segmentId: string;
  let contactId: string;

  it("segments.create with name only makes a manual segment", async () => {
    const created = await resend.segments.create({ name: "sdk-manual" });
    expect(created.error).toBeNull();
    expect(created.data).toMatchObject({ object: "segment", id: expect.any(String) });
    segmentId = created.data?.id ?? "";
  });

  it("audiences.* is a pure alias of segments.* (same /segments paths)", async () => {
    const got = await resend.audiences.get(segmentId);
    expect(got.error).toBeNull();
    expect(got.data).toMatchObject({ object: "segment", id: segmentId, name: "sdk-manual" });
  });

  it("contacts.create carries segments and topics", async () => {
    const topic = await resend.topics.create({
      name: "sdk-topic",
      defaultSubscription: "opt_in",
    });
    expect(topic.error).toBeNull();
    const created = await resend.contacts.create({
      email: "sdk@example.com",
      segments: [{ id: segmentId }],
      topics: [{ id: topic.data?.id ?? "", subscription: "opt_out" }],
    });
    expect(created.error).toBeNull();
    contactId = created.data?.id ?? "";
  });

  it("contacts.list({ segmentId }) resolves the segment's contacts", async () => {
    const list = await resend.contacts.list({ segmentId });
    expect(list.error).toBeNull();
    expect(list.data?.has_more).toBe(false);
    expect(list.data?.data.map((c) => c.email)).toEqual(["sdk@example.com"]);
  });

  it("contacts.segments.remove and add round-trip, by email", async () => {
    const removed = await resend.contacts.segments.remove({
      email: "sdk@example.com",
      segmentId,
    });
    expect(removed.error).toBeNull();
    expect(removed.data).toMatchObject({ id: contactId, audienceId: segmentId, deleted: true });

    // Removing a non-member is a 404 on the wire.
    const again = await resend.contacts.segments.remove({ contactId, segmentId });
    expect(again.data).toBeNull();
    expect(again.error?.statusCode).toBe(404);
    expect(again.error?.name).toBe("not_found");

    const added = await resend.contacts.segments.add({ email: "sdk@example.com", segmentId });
    expect(added.error).toBeNull();
    expect(added.data).toMatchObject({ id: contactId });
  });

  it("legacy audienceId branches hit /audiences/{id}/contacts and join the segment", async () => {
    const created = await resend.contacts.create({
      audienceId: segmentId,
      email: "sdk-legacy@example.com",
      firstName: "Legacy",
    });
    expect(created.error).toBeNull();

    const got = await resend.contacts.get({
      audienceId: segmentId,
      email: "sdk-legacy@example.com",
    });
    expect(got.error).toBeNull();
    expect(got.data).toMatchObject({ object: "contact", first_name: "Legacy" });

    const list = await resend.contacts.list({ audienceId: segmentId });
    expect(list.data?.data.map((c) => c.email).sort()).toEqual([
      "sdk-legacy@example.com",
      "sdk@example.com",
    ]);

    const removed = await resend.contacts.remove({
      audienceId: segmentId,
      email: "sdk-legacy@example.com",
    });
    expect(removed.error).toBeNull();
    expect(removed.data).toMatchObject({ deleted: true });
  });

  it("segments.list returns the list envelope (and via the audiences alias)", async () => {
    const listed = await resend.segments.list();
    expect(listed.error).toBeNull();
    expect(listed.data?.object).toBe("list");
    expect(listed.data?.has_more).toBe(false);
    expect(listed.data?.data.some((s) => s.id === segmentId)).toBe(true);

    const aliased = await resend.audiences.list();
    expect(aliased.error).toBeNull();
    expect(aliased.data?.data.map((s) => s.id)).toEqual(listed.data?.data.map((s) => s.id));
  });

  it("segments.remove deletes, then get 404s", async () => {
    const doomed = await resend.segments.create({ name: "doomed" });
    expect(doomed.error).toBeNull();
    const id = doomed.data?.id ?? "";
    const removed = await resend.segments.remove(id);
    expect(removed.error).toBeNull();
    expect(removed.data).toMatchObject({ object: "segment", id, deleted: true });
    const gone = await resend.segments.get(id);
    expect(gone.data).toBeNull();
    expect(gone.error?.name).toBe("not_found");
  });

  it("a filter segment resolves contacts dynamically (MillionSend extension)", async () => {
    // The SDK posts the create payload verbatim, so the extra `filter` field
    // reaches the wire even though its type only declares `name`.
    const created = await resend.segments.create({
      name: "corp-only",
      filter: {
        match: "all",
        conditions: [{ field: "email", op: "ends_with", value: "@corp.dev" }],
      },
    } as Parameters<typeof resend.segments.create>[0]);
    expect(created.error).toBeNull();
    const filterSegmentId = created.data?.id ?? "";

    const match = await resend.contacts.create({ email: "f1@corp.dev" });
    expect(match.error).toBeNull();

    const list = await resend.contacts.list({ segmentId: filterSegmentId });
    expect(list.error).toBeNull();
    // Only the matching contact resolves; sdk@example.com stays out.
    expect(list.data?.data.map((c) => c.email)).toEqual(["f1@corp.dev"]);
  });
});
