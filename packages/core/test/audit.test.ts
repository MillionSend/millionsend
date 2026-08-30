import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAuditActor, recordAudit } from "../src/audit.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db);
});
afterAll(() => close());

describe("recordAudit", () => {
  it("appends a team-scoped row with the actor and target encoded", async () => {
    await recordAudit(db, {
      teamId,
      actor: { userId: "u1" },
      action: "api_key.created",
      target: { type: "api_key", id: "k1" },
      metadata: { name: "CI" },
    });
    await recordAudit(db, { teamId, actor: "stripe", action: "billing.subscription_updated" });
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.teamId, teamId))
      .orderBy(schema.auditLog.createdAt);
    expect(rows).toMatchObject([
      { actorId: "user:u1", action: "api_key.created", target: "api_key:k1", data: { name: "CI" } },
      { actorId: "stripe", action: "billing.subscription_updated", target: null, data: null },
    ]);
  });

  it("round-trips every actor kind through parseAuditActor", () => {
    expect(parseAuditActor("user:u1")).toEqual({ kind: "user", id: "u1" });
    expect(parseAuditActor("api_key:k1")).toEqual({ kind: "api_key", id: "k1" });
    expect(parseAuditActor("oauth")).toEqual({ kind: "oauth" });
    expect(parseAuditActor("stripe")).toEqual({ kind: "stripe" });
    expect(parseAuditActor("system")).toEqual({ kind: "system" });
    expect(parseAuditActor(null)).toEqual({ kind: "system" });
  });
});
