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

async function createDomain(
  teamId: string,
  name: string,
  status: "verified" | "pending" = "verified",
) {
  const [row] = await db
    .insert(schema.domains)
    .values({ teamId, name, region: "us-east-1", status })
    .returning({ id: schema.domains.id });
  if (!row) throw new Error("domain insert failed");
  return row.id;
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

  it("defaults to full access and any domain", async () => {
    const teamId = await createTeam(db, "team-a");
    const { id } = await callerFor(teamId).apiKeys.create({ name: "default" });
    const row = await keyRow(id);
    expect(row.permission).toBe("full_access");
    expect(row.domainId).toBeNull();
  });

  it("persists sending-only permission scoped to a verified domain", async () => {
    const teamId = await createTeam(db, "team-a");
    const domainId = await createDomain(teamId, "mail.a.example", "verified");
    const { id } = await callerFor(teamId).apiKeys.create({
      name: "sender",
      permission: "sending_access",
      domainId,
    });
    const row = await keyRow(id);
    expect(row.permission).toBe("sending_access");
    expect(row.domainId).toBe(domainId);
  });

  it("rejects an unverified domain", async () => {
    const teamId = await createTeam(db, "team-a");
    const domainId = await createDomain(teamId, "mail.a.example", "pending");
    await expect(callerFor(teamId).apiKeys.create({ name: "x", domainId })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("rejects a domain owned by another team", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const foreign = await createDomain(teamB, "mail.b.example", "verified");
    await expect(
      callerFor(teamA).apiKeys.create({ name: "x", domainId: foreign }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
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

  it("surfaces each key's permission and scoped domain name", async () => {
    const teamId = await createTeam(db, "team-a");
    const domainId = await createDomain(teamId, "mail.a.example", "verified");
    const caller = callerFor(teamId);
    await caller.apiKeys.create({ name: "scoped", permission: "sending_access", domainId });
    await caller.apiKeys.create({ name: "full" });

    const listed = await caller.apiKeys.list();
    const scoped = listed.find((k) => k.name === "scoped");
    const full = listed.find((k) => k.name === "full");
    expect(scoped?.permission).toBe("sending_access");
    expect(scoped?.domainName).toBe("mail.a.example");
    expect(full?.permission).toBe("full_access");
    expect(full?.domainName).toBeNull();
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
