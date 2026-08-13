import type { Db } from "@millionsend/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  beginIdempotent,
  completeIdempotent,
  purgeExpiredIdempotencyKeys,
} from "../src/idempotency.js";
import { createTeam, createTestDb } from "./helpers/test-db.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db);
});
afterAll(() => close());

describe("idempotency", () => {
  it("walks new → in_flight → replay", async () => {
    const params = { teamId, key: "k1", bodyHash: "h1" };
    expect(await beginIdempotent(db, params)).toEqual({ kind: "new" });
    expect(await beginIdempotent(db, params)).toEqual({ kind: "in_flight" });
    await completeIdempotent(db, { teamId, key: "k1", emailIds: ["e1", "e2"] });
    expect(await beginIdempotent(db, params)).toEqual({ kind: "replay", emailIds: ["e1", "e2"] });
  });

  it("conflicts on same key with a different body", async () => {
    await beginIdempotent(db, { teamId, key: "k2", bodyHash: "h-original" });
    expect(await beginIdempotent(db, { teamId, key: "k2", bodyHash: "h-different" })).toEqual({
      kind: "conflict",
    });
  });

  it("scopes keys per team", async () => {
    const otherTeam = await createTeam(db, "other");
    expect(await beginIdempotent(db, { teamId: otherTeam, key: "k1", bodyHash: "h1" })).toEqual({
      kind: "new",
    });
  });

  it("purges only expired rows", async () => {
    await beginIdempotent(db, { teamId, key: "fresh", bodyHash: "h" });
    const purged = await purgeExpiredIdempotencyKeys(db, new Date(Date.now() + 48 * 3600 * 1000));
    expect(purged).toBeGreaterThan(0);
    // Key space is free again after purge.
    expect(await beginIdempotent(db, { teamId, key: "fresh", bodyHash: "h" })).toEqual({
      kind: "new",
    });
  });
});
