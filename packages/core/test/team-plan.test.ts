import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backfillPoolOwners, contactRoom } from "../src/team-plan.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db);
});
afterAll(() => close());

const addContacts = (from: number, n: number) =>
  db
    .insert(schema.contacts)
    .values(Array.from({ length: n }, (_, i) => ({ teamId, email: `c${from + i}@example.com` })));

describe("contactRoom", () => {
  it("is what is left under the Free cap, down to zero", async () => {
    await addContacts(0, 998);
    expect(await contactRoom(db, teamId, "free", true)).toBe(2);
    await addContacts(998, 2);
    expect(await contactRoom(db, teamId, "free", true)).toBe(0);
  });

  it("caps nothing on an uncapped plan, on the system plan, or off Cloud", async () => {
    expect(await contactRoom(db, teamId, "pro", true)).toBeNull();
    expect(await contactRoom(db, teamId, "system", true)).toBeNull();
    expect(await contactRoom(db, teamId, "free", false)).toBeNull();
  });
});

describe("backfillPoolOwners", () => {
  const poolOwner = async (id: string) => {
    const [row] = await db
      .select({ poolOwnerId: schema.teams.poolOwnerId })
      .from(schema.teams)
      .where(eq(schema.teams.id, id));
    return row?.poolOwnerId;
  };

  it("records each team's creator, from its team.created row, else its earliest owner, on Cloud only", async () => {
    await db.insert(schema.user).values([
      { id: "creator", name: "Creator", email: "creator@example.com" },
      { id: "first-owner", name: "First", email: "first@example.com" },
      { id: "later-owner", name: "Later", email: "later@example.com" },
    ]);
    const audited = await createTeam(db, "backfill-audited");
    await db
      .insert(schema.teamMembers)
      .values({ teamId: audited, userId: "later-owner", role: "owner" });
    await db.insert(schema.auditLog).values({
      teamId: audited,
      actorId: "user:creator",
      action: "team.created",
      target: `team:${audited}`,
    });
    const older = await createTeam(db, "backfill-older");
    await db.insert(schema.teamMembers).values([
      { teamId: older, userId: "first-owner", role: "owner", createdAt: new Date("2026-01-01") },
      { teamId: older, userId: "later-owner", role: "owner", createdAt: new Date("2026-02-01") },
      { teamId: older, userId: "creator", role: "member", createdAt: new Date("2025-12-01") },
    ]);
    const ownerless = await createTeam(db, "backfill-ownerless");
    const system = await createTeam(db, "backfill-system");
    await db.update(schema.teams).set({ plan: "system" }).where(eq(schema.teams.id, system));
    await db
      .insert(schema.teamMembers)
      .values({ teamId: system, userId: "creator", role: "owner" });
    const recorded = await createTeam(db, "backfill-recorded", { poolOwnerId: "first-owner" });

    expect(await backfillPoolOwners(db, false)).toBe(0);
    expect(await poolOwner(audited)).toBeNull();

    expect(await backfillPoolOwners(db, true)).toBe(2);
    expect(await poolOwner(audited)).toBe("creator");
    expect(await poolOwner(older)).toBe("first-owner");
    expect(await poolOwner(ownerless)).toBeNull();
    expect(await poolOwner(system)).toBeNull();
    expect(await poolOwner(recorded)).toBe("first-owner");
    expect(await backfillPoolOwners(db, true)).toBe(0);
  });
});
