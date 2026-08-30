import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/hash.js";
import { findSuppressed, hashRecipient, normalizeAddress } from "../src/suppressions.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db);
});
afterAll(() => close());

describe("suppressions", () => {
  it("normalizes before hashing", () => {
    expect(hashRecipient("  User@Example.COM ")).toBe(hashRecipient("user@example.com"));
    expect(hashRecipient("Bob <bob@example.com>")).toBe(hashRecipient("bob@example.com"));
    // NFKC folds fullwidth lookalikes; a trailing root dot is the same domain.
    expect(hashRecipient("ｂｏｂ@example.com")).toBe(hashRecipient("bob@example.com"));
    expect(hashRecipient("bob@example.com.")).toBe(hashRecipient("bob@example.com"));
    // Plus-tags stay distinct: the receiving MTA treats them as different mailboxes.
    expect(hashRecipient("bob+1@example.com")).not.toBe(hashRecipient("bob@example.com"));
    expect(normalizeAddress("Ｂob@Example.COM.")).toBe("bob@example.com");
  });

  it("still matches rows hashed before normalization existed", async () => {
    // Legacy hash: addr-spec lowercased only, no NFKC — differs from today's.
    const legacy = sha256Hex("ｏｌｄ@example.com");
    expect(legacy).not.toBe(hashRecipient("ｏｌｄ@example.com"));
    await db.insert(schema.suppressions).values({
      teamId,
      email: "ｏｌｄ@example.com",
      emailHash: legacy,
      reason: "hard_bounce",
    });
    const suppressed = await findSuppressed(db, teamId, ["ｏｌｄ@example.com"]);
    expect(suppressed).toEqual(new Set(["ｏｌｄ@example.com"]));
  });

  it("finds only the suppressed subset, case-insensitively", async () => {
    await db.insert(schema.suppressions).values({
      teamId,
      email: "bounced@example.com",
      emailHash: hashRecipient("bounced@example.com"),
      reason: "hard_bounce",
    });
    const suppressed = await findSuppressed(db, teamId, [
      "BOUNCED@example.com",
      "fine@example.com",
    ]);
    expect(suppressed).toEqual(new Set(["BOUNCED@example.com"]));
  });

  it("still matches after erasure removed the address (hash-only row)", async () => {
    await db.insert(schema.suppressions).values({
      teamId,
      email: null,
      emailHash: hashRecipient("erased@example.com"),
      reason: "complaint",
    });
    const suppressed = await findSuppressed(db, teamId, ["erased@example.com"]);
    expect(suppressed.size).toBe(1);
  });

  it("is team-scoped", async () => {
    const otherTeam = await createTeam(db, "other-team");
    const suppressed = await findSuppressed(db, otherTeam, ["bounced@example.com"]);
    expect(suppressed.size).toBe(0);
  });
});
