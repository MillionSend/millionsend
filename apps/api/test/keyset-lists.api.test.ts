import { randomBytes, randomUUID } from "node:crypto";
import { EnvKeyring, generateApiKey, hashRecipient } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, keysetPage } from "../src/app.js";
import type { ListQuery } from "../src/schemas.js";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

// Pinned created_at: PGlite's now() is millisecond-only, so rows written in one go could tie.
const day = (n: number) => new Date(Date.UTC(2026, 0, n));

describe("keysetPage", () => {
  const s = schema.segments;
  let teamId: string;
  let rows: { id: string; name: string }[];
  const id = (name: string) => rows.find((r) => r.name === name)?.id;
  type LoadCursor = Parameters<typeof keysetPage>[0]["loadCursor"];
  const ownCursor: LoadCursor = async (cursor) =>
    (
      await db
        .select({ createdAt: s.createdAt, id: s.id })
        .from(s)
        .where(and(eq(s.id, cursor), eq(s.teamId, teamId)))
    )[0];
  const page = async (query: ListQuery, loadCursor = ownCursor) => {
    const out = await keysetPage({
      query,
      createdAt: s.createdAt,
      id: s.id,
      loadCursor,
      loadRows: (cond, orderBy, take) =>
        db
          .select({ name: s.name })
          .from(s)
          .where(and(eq(s.teamId, teamId), cond))
          .orderBy(...orderBy)
          .limit(take),
    });
    return out === "bad_cursor" ? out : { names: out.rows.map((r) => r.name), more: out.hasMore };
  };

  beforeAll(async () => {
    teamId = await createTeam(db, "keyset-page");
    rows = await db
      .insert(s)
      .values([1, 2, 3, 4, 5].map((n) => ({ teamId, name: `d${n}`, createdAt: day(n) })))
      .returning({ id: s.id, name: s.name });
  });

  it("starts at the newest item", async () => {
    expect(await page({ limit: 2 })).toEqual({ names: ["d5", "d4"], more: true });
    expect(await page({})).toEqual({ names: ["d5", "d4", "d3", "d2", "d1"], more: false });
  });

  it("pages toward older items with after, has_more false at the oldest", async () => {
    expect(await page({ limit: 2, after: id("d4") })).toEqual({ names: ["d3", "d2"], more: true });
    expect(await page({ limit: 2, after: id("d2") })).toEqual({ names: ["d1"], more: false });
    expect(await page({ after: id("d1") })).toEqual({ names: [], more: false });
  });

  it("pages back toward newer items with before, still newest first, has_more false at the newest", async () => {
    expect(await page({ limit: 2, before: id("d1") })).toEqual({ names: ["d3", "d2"], more: true });
    expect(await page({ limit: 2, before: id("d3") })).toEqual({
      names: ["d5", "d4"],
      more: false,
    });
    expect(await page({ before: id("d5") })).toEqual({ names: [], more: false });
  });

  it("refuses a cursor that is not an item of the list", async () => {
    expect(await page({ after: randomUUID() })).toBe("bad_cursor");
    expect(await page({ before: randomUUID() })).toBe("bad_cursor");
  });

  it('reads a cursor answered "end" as below every row: nothing after it, the oldest before it', async () => {
    const end = randomUUID();
    const atEnd = (query: ListQuery) =>
      page(query, async (cursor) => (cursor === end ? "end" : undefined));
    expect(await atEnd({ after: end })).toEqual({ names: [], more: false });
    expect(await atEnd({ limit: 2, before: end })).toEqual({ names: ["d2", "d1"], more: true });
    expect(await atEnd({ before: end })).toEqual({
      names: ["d5", "d4", "d3", "d2", "d1"],
      more: false,
    });
  });
});

describe("keyset lists", () => {
  it("answer newest first on every endpoint", async () => {
    const teamId = await createTeam(db, "keyset-lists");
    const key = generateApiKey();
    await db.insert(schema.apiKeys).values({
      teamId,
      name: "t",
      tokenPrefix: key.tokenPrefix,
      keyHash: key.keyHash,
      last4: key.last4,
    });
    const app = createApi({
      db,
      keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
      isCloud: true,
      enqueueEmailSend: async () => {},
      // /domains registers only with the SES seam; listing never calls SES.
      ses: { clientForRegion: () => ({ send: async () => ({}) }) },
    });

    const at = [day(1), day(2)];
    await db
      .insert(schema.contacts)
      .values(at.map((createdAt, i) => ({ teamId, email: `c${i}@example.com`, createdAt })));
    await db
      .insert(schema.segments)
      .values(at.map((createdAt, i) => ({ teamId, name: `s${i}`, createdAt })));
    const [everyone] = await db
      .insert(schema.segments)
      .values({ teamId, name: "everyone", filter: { match: "all", conditions: [] } })
      .returning({ id: schema.segments.id });
    await db.insert(schema.broadcasts).values(
      at.map((createdAt, i) => ({
        teamId,
        name: `b${i}`,
        from: "A <a@example.com>",
        subject: "s",
        createdAt,
      })),
    );
    await db.insert(schema.apiKeys).values(
      at.map((createdAt, i) => {
        const k = generateApiKey();
        return {
          teamId,
          name: `k${i}`,
          tokenPrefix: k.tokenPrefix,
          keyHash: k.keyHash,
          last4: k.last4,
          createdAt,
        };
      }),
    );
    await db.insert(schema.webhookEndpoints).values(
      at.map((createdAt, i) => ({
        teamId,
        url: `https://example.com/hooks/${i}`,
        secretCiphertext: Buffer.alloc(1),
        secretIv: Buffer.alloc(1),
        secretWrappedDek: Buffer.alloc(1),
        secretKeyVersion: 1,
        secretLast4: "abcd",
        createdAt,
      })),
    );
    await db
      .insert(schema.templates)
      .values(at.map((createdAt, i) => ({ teamId, name: `t${i}`, html: "<p>t</p>", createdAt })));
    await db
      .insert(schema.contactProperties)
      .values(at.map((createdAt, i) => ({ teamId, key: `p${i}`, createdAt })));
    await db.insert(schema.domains).values(
      at.map((createdAt, i) => ({
        teamId,
        name: `d${i}.example.com`,
        region: "us-east-1",
        createdAt,
      })),
    );
    await db.insert(schema.suppressions).values(
      at.map((createdAt, i) => ({
        teamId,
        email: `x${i}@example.com`,
        emailHash: hashRecipient(`x${i}@example.com`),
        reason: "manual" as const,
        createdAt,
      })),
    );
    await db.insert(schema.emails).values(
      at.map((createdAt) => ({
        teamId,
        from: "A <a@example.com>",
        to: ["r@example.com"],
        subject: "s",
        latestStatus: "sent" as const,
        createdAt,
      })),
    );

    for (const path of [
      "/contacts",
      `/segments/${everyone?.id}/contacts`,
      "/segments",
      "/broadcasts",
      "/api-keys",
      "/webhooks",
      "/templates",
      "/contact-properties",
      "/domains",
      "/suppressions",
      "/emails",
    ]) {
      const res = await app.request(path, { headers: { authorization: `Bearer ${key.token}` } });
      expect(res.status, path).toBe(200);
      const { data } = (await res.json()) as { data: { created_at: string }[] };
      const times = data.map((r) => r.created_at);
      expect(new Set(times).size, path).toBeGreaterThan(1);
      expect(times, path).toEqual([...times].sort().reverse());
    }
  });
});
