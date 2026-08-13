import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findSuppressed, hashRecipient } from "../src/suppressions.js";
import { createTeam, createTestDb } from "./helpers/test-db.js";

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
