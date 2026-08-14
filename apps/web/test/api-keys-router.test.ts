import { verifyApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCaller } from "@/server/routers";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

function callerFor(teamId: string) {
  return createCaller({
    db,
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId,
    role: "owner",
  });
}

async function keyRow(id: string) {
  const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id));
  if (!row) throw new Error("key row missing");
  return row;
}

describe("apiKeys.create", () => {
  it("returns an ms_-prefixed token that verifies against the stored hash", async () => {
    const teamId = await createTeam(db, "team-a");
    const { id, token } = await callerFor(teamId).apiKeys.create({ name: "Production" });

    expect(token).toMatch(/^ms_live_/);
    const row = await keyRow(id);
    expect(row.teamId).toBe(teamId);
    expect(token.startsWith(row.tokenPrefix)).toBe(true);
    expect(row.last4).toBe(token.slice(-4));
    // The secret itself is never stored — only its hash verifies the token.
    expect(row.keyHash).not.toContain(token);
    expect(verifyApiKey(token, row.keyHash)).toBe(true);
    expect(verifyApiKey(`${token}x`, row.keyHash)).toBe(false);
  });

  it("encodes the requested mode in the token", async () => {
    const teamId = await createTeam(db, "team-a");
    const { token } = await callerFor(teamId).apiKeys.create({ name: "CI", mode: "test" });
    expect(token).toMatch(/^ms_test_/);
  });
});

describe("apiKeys.list", () => {
  it("excludes revoked keys and other teams' keys", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const a = callerFor(teamA);
    const kept = await a.apiKeys.create({ name: "kept" });
    const revoked = await a.apiKeys.create({ name: "revoked" });
    await a.apiKeys.revoke({ id: revoked.id });
    await callerFor(teamB).apiKeys.create({ name: "other-team" });

    const listed = await a.apiKeys.list();
    expect(listed.map((k) => k.id)).toEqual([kept.id]);
    expect(listed[0]?.mode).toBe("live");
  });
});

describe("apiKeys.revoke", () => {
  it("blocks cross-team revocation", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const { id } = await callerFor(teamA).apiKeys.create({ name: "Production" });

    await expect(callerFor(teamB).apiKeys.revoke({ id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await keyRow(id)).revokedAt).toBeNull();
  });

  it("soft-revokes: the row survives with revokedAt set", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.apiKeys.create({ name: "Production" });

    await caller.apiKeys.revoke({ id });
    expect((await keyRow(id)).revokedAt).toBeInstanceOf(Date);
    // Idempotence is not silent: revoking again reports the key as gone.
    await expect(caller.apiKeys.revoke({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
