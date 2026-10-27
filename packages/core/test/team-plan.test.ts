import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchDeliverabilityHealth, GUARDRAIL_WINDOW_DAYS } from "../src/deliverability.js";
import { backfillPoolOwners, contactRoom } from "../src/team-plan.js";
import { DAY_MS, utcDay } from "../src/utc-day.js";

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

  it("brings a Free team's guardrail window into its pool once, and nothing of a paid or system team", async () => {
    const now = new Date("2026-09-10T12:00:00Z");
    const daysAgo = (n: number) => utcDay(now.getTime() - n * DAY_MS);
    await db.insert(schema.user).values({ id: "seeded", name: "Seeded", email: "s@example.com" });
    const free = await createTeam(db, "seed-free");
    const paid = await createTeam(db, "seed-paid");
    const system = await createTeam(db, "seed-system");
    await db.update(schema.teams).set({ plan: "starter" }).where(eq(schema.teams.id, paid));
    await db.update(schema.teams).set({ plan: "system" }).where(eq(schema.teams.id, system));
    for (const team of [free, paid, system]) {
      await db.insert(schema.teamMembers).values({ teamId: team, userId: "seeded", role: "owner" });
      // Paused on its own record today; the day before the window is left behind.
      await db.insert(schema.usageCounters).values([
        { teamId: team, day: daysAgo(0), accepted: 150, sent: 120, hardBounced: 12, complained: 3 },
        { teamId: team, day: daysAgo(GUARDRAIL_WINDOW_DAYS - 1), sent: 10, sentNoFeedback: 4 },
        { teamId: team, day: daysAgo(GUARDRAIL_WINDOW_DAYS), sent: 99, complained: 9 },
      ]);
    }
    expect((await fetchDeliverabilityHealth(db, free, { now })).status).toBe("paused");

    expect(await backfillPoolOwners(db, true, now)).toBe(2);
    expect(await poolOwner(free)).toBe("seeded");
    expect((await fetchDeliverabilityHealth(db, free, { now })).status).toBe("paused");
    const pool = () =>
      db
        .select()
        .from(schema.freePoolUsage)
        .where(eq(schema.freePoolUsage.ownerId, "seeded"))
        .orderBy(asc(schema.freePoolUsage.day));
    const seeded = [
      {
        ownerId: "seeded",
        day: daysAgo(GUARDRAIL_WINDOW_DAYS - 1),
        accepted: 0,
        sent: 10,
        sentNoFeedback: 4,
        hardBounced: 0,
        complained: 0,
      },
      {
        ownerId: "seeded",
        day: daysAgo(0),
        accepted: 150,
        sent: 120,
        sentNoFeedback: 0,
        hardBounced: 12,
        complained: 3,
      },
    ];
    expect(await pool()).toEqual(seeded);

    expect(await backfillPoolOwners(db, true, now)).toBe(0);
    expect(await pool()).toEqual(seeded);
  });
});
