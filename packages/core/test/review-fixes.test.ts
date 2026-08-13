import { randomBytes } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalBodyHash } from "../src/canonical-json.js";
import { decryptEmailBody, encryptEmailBody } from "../src/crypto/envelope.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { beginIdempotent, completeIdempotent } from "../src/idempotency.js";
import { releaseDailyQuota, reserveDailyQuota } from "../src/quota.js";
import { applyStatusCas, transitionQueueState } from "../src/status.js";
import { findSuppressed, hashRecipient } from "../src/suppressions.js";
import { createTeam, createTestDb } from "./helpers/test-db.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "review-fixes");
});
afterAll(() => close());

async function createEmail(status: "queued" | "queued_quota" = "queued"): Promise<string> {
  const [row] = await db
    .insert(schema.emails)
    .values({ teamId, from: "a@b.c", to: ["x@y.z"], subject: "s", latestStatus: status })
    .returning({ id: schema.emails.id });
  if (!row) throw new Error("insert failed");
  return row.id;
}

describe("queue-state transitions (queued_quota reachable)", () => {
  it("parks and drains via exact-guard transitions", async () => {
    const id = await createEmail("queued");
    expect(await transitionQueueState(db, id, { from: "queued", to: "queued_quota" })).toBe(true);
    expect(await transitionQueueState(db, id, { from: "queued", to: "queued_quota" })).toBe(false);
    expect(await transitionQueueState(db, id, { from: "queued_quota", to: "queued" })).toBe(true);
  });

  it("never touches an email already in the event ladder", async () => {
    const id = await createEmail("queued");
    await applyStatusCas(db, id, "sent");
    expect(await transitionQueueState(db, id, { from: "queued", to: "queued_quota" })).toBe(false);
  });

  it("rejects queue states in the CAS", async () => {
    const id = await createEmail("queued");
    await expect(applyStatusCas(db, id, "queued_quota")).rejects.toThrow(/transitionQueueState/);
  });
});

describe("team deletion vs append-only audit log", () => {
  it("deletes a team while audit rows survive untouched", async () => {
    const doomed = await createTeam(db, "doomed");
    await db.insert(schema.auditLog).values({ teamId: doomed, action: "team.created" });
    await db.delete(schema.teams).where(eq(schema.teams.id, doomed));
    const rows = await db
      .select({ teamId: schema.auditLog.teamId })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.teamId, doomed));
    expect(rows).toHaveLength(1);
  });

  it("still rejects direct UPDATE/DELETE on audit_log", async () => {
    await db.insert(schema.auditLog).values({ teamId, action: "x" });
    // Drizzle wraps driver errors; the trigger's message lives in `cause`.
    const updateErr = await db
      .execute(sql`update ${schema.auditLog} set action = 'y'`)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(String((updateErr as Error)?.cause ?? updateErr)).toMatch(/append-only/);
    const deleteErr = await db
      .execute(sql`delete from ${schema.auditLog}`)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(String((deleteErr as Error)?.cause ?? deleteErr)).toMatch(/append-only/);
  });
});

describe("idempotency expiry and ownership", () => {
  it("reclaims an expired row as new", async () => {
    const past = new Date(Date.now() - 30 * 3600 * 1000);
    await beginIdempotent(db, { teamId, key: "exp", bodyHash: "h1" }, past);
    expect(await beginIdempotent(db, { teamId, key: "exp", bodyHash: "h2" })).toEqual({
      kind: "new",
    });
  });

  it("takes over a stale incomplete claim with the same body, but conflicts on a different one", async () => {
    const staleStart = new Date(Date.now() - 11 * 60 * 1000);
    await beginIdempotent(db, { teamId, key: "stale", bodyHash: "h" }, staleStart);
    expect(await beginIdempotent(db, { teamId, key: "stale", bodyHash: "other" })).toEqual({
      kind: "conflict",
    });
    expect(await beginIdempotent(db, { teamId, key: "stale", bodyHash: "h" })).toEqual({
      kind: "new",
    });
  });

  it("keeps a fresh in-flight claim exclusive", async () => {
    await beginIdempotent(db, { teamId, key: "fresh-claim", bodyHash: "h" });
    expect(await beginIdempotent(db, { teamId, key: "fresh-claim", bodyHash: "h" })).toEqual({
      kind: "in_flight",
    });
  });

  it("reports unrecorded completion", async () => {
    expect(await completeIdempotent(db, { teamId, key: "never-claimed", emailIds: ["e"] })).toBe(
      false,
    );
  });
});

describe("canonical json fidelity", () => {
  it("distinguishes Dates instead of collapsing them to {}", () => {
    const a = canonicalBodyHash({ at: new Date("2026-01-01T00:00:00Z") });
    const b = canonicalBodyHash({ at: new Date("2027-06-01T00:00:00Z") });
    expect(a).not.toBe(b);
  });

  it("hashes undefined/empty bodies without throwing", () => {
    expect(canonicalBodyHash(undefined)).toBe(canonicalBodyHash(null));
  });
});

describe("suppression addr-spec normalization", () => {
  it("catches display-name forms of a suppressed bare address", async () => {
    await db.insert(schema.suppressions).values({
      teamId,
      email: "victim@example.com",
      emailHash: hashRecipient("victim@example.com"),
      reason: "complaint",
    });
    const suppressed = await findSuppressed(db, teamId, ['"V. Ictim" <Victim@Example.com>']);
    expect(suppressed.size).toBe(1);
  });
});

describe("crypto guards", () => {
  const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));

  it("rejects (not throws) on a truncated wrapped DEK", async () => {
    await expect(keyring.unwrapDek(Buffer.from("short"), 1)).rejects.toThrow(/too short/);
  });

  it("rejects a truncated ciphertext before touching the keyring", async () => {
    const sealed = await encryptEmailBody({ html: null, text: "x" }, keyring);
    await expect(
      decryptEmailBody({ ...sealed, ciphertext: Buffer.from("tiny") }, keyring),
    ).rejects.toThrow(/too short/);
  });
});

describe("quota release", () => {
  it("compensates a failed reservation and floors at zero", async () => {
    const t = await createTeam(db, "release-team");
    await reserveDailyQuota(db, { teamId: t, count: 50, limit: 100, day: "2026-08-14" });
    await releaseDailyQuota(db, { teamId: t, count: 50, day: "2026-08-14" });
    const again = await reserveDailyQuota(db, {
      teamId: t,
      count: 100,
      limit: 100,
      day: "2026-08-14",
    });
    expect(again).toEqual({ reserved: true, acceptedToday: 100 });
    await releaseDailyQuota(db, { teamId: t, count: 500, day: "2026-08-14" });
    const afterFloor = await reserveDailyQuota(db, {
      teamId: t,
      count: 1,
      limit: 100,
      day: "2026-08-14",
    });
    expect(afterFloor).toEqual({ reserved: true, acceptedToday: 1 });
  });
});
