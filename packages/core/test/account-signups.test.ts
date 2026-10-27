import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearAbuseMarks,
  purgeAccountSignups,
  recordSignup,
  signupsFromNetwork,
} from "../src/account-signups.js";
import { suspendTeam } from "../src/team-standing.js";
import { DAY_MS } from "../src/utc-day.js";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(() => close());

async function account(teamId?: string): Promise<string> {
  const id = randomUUID();
  const email = `${id}@example.com`;
  await db.insert(schema.user).values({ id, name: "Person", email });
  await recordSignup(db, { userId: id, email, ip: "203.0.113.9", userAgent: "Firefox" });
  if (teamId) await db.insert(schema.teamMembers).values({ teamId, userId: id, role: "owner" });
  return id;
}

async function record(userId: string) {
  const [row] = await db
    .select()
    .from(schema.accountSignups)
    .where(eq(schema.accountSignups.userId, userId));
  return row ?? null;
}

const deleteAccount = (userId: string) => db.delete(schema.user).where(eq(schema.user.id, userId));

const daysAfter = (start: Date, days: number) => new Date(start.getTime() + days * DAY_MS);

describe("recordSignup", () => {
  it("keeps the IP and browser, and leaves out what is not an address", async () => {
    await recordSignup(db, {
      userId: "a",
      email: "a@example.com",
      ip: "2001:DB8::1",
      userAgent: "x".repeat(2000),
    });
    await recordSignup(db, { userId: "b", email: "b@example.com", ip: "unknown", userAgent: "" });
    expect(await record("a")).toMatchObject({ ip: "2001:db8::1", email: "a@example.com" });
    expect((await record("a"))?.userAgent).toHaveLength(512);
    expect(await record("b")).toMatchObject({ ip: null, userAgent: null });
  });
});

describe("signupsFromNetwork", () => {
  const NOW = new Date("2026-09-03T12:00:00Z");
  const hoursBefore = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);
  const signedUp = (ip: string | null, at: Date, deletedAt: Date | null = null) =>
    db
      .insert(schema.accountSignups)
      .values({ userId: randomUUID(), email: "x@example.com", ip, createdAt: at, deletedAt });

  it("counts the day's sign-ups from one IPv4 address, or one IPv6 /64, deleted accounts included", async () => {
    await signedUp("203.0.113.9", hoursBefore(1));
    await signedUp("203.0.113.9", hoursBefore(23), hoursBefore(2));
    await signedUp("203.0.113.10", hoursBefore(1));
    await signedUp("2001:db8::1", hoursBefore(1));
    await signedUp("2001:db8::abcd:1", hoursBefore(5));
    await signedUp("2001:db8:0:1::1", hoursBefore(1));
    // Stored as recordSignup keeps them: a zone id, which inet would refuse, and no IP at all.
    await signedUp("fe80::1%eth0", hoursBefore(1));
    await signedUp(null, hoursBefore(1));

    expect(await signupsFromNetwork(db, "203.0.113.9", NOW)).toBe(2);
    expect(await signupsFromNetwork(db, "::ffff:203.0.113.9", NOW)).toBe(2);
    expect(await signupsFromNetwork(db, "2001:db8::ffff", NOW)).toBe(2);
    expect(await signupsFromNetwork(db, "2001:db8:0:1::9", NOW)).toBe(1);
    expect(await signupsFromNetwork(db, "198.51.100.1", NOW)).toBe(0);
    expect(await signupsFromNetwork(db, "unknown", NOW)).toBe(0);
  });

  it("leaves out sign-ups a day old or older", async () => {
    await signedUp("203.0.113.9", hoursBefore(24));
    await signedUp("2001:db8::1", hoursBefore(30));
    expect(await signupsFromNetwork(db, "203.0.113.9", NOW)).toBe(0);
    expect(await signupsFromNetwork(db, "2001:db8::2", NOW)).toBe(0);
  });
});

describe("purgeAccountSignups", () => {
  it("keeps the record for the account's life and 90 days after its deletion", async () => {
    const id = await account();
    const start = new Date();
    await purgeAccountSignups(db, daysAfter(start, 400));
    expect(await record(id)).toMatchObject({ deletedAt: null });

    await deleteAccount(id);
    const deletedSeen = daysAfter(start, 401);
    await purgeAccountSignups(db, deletedSeen);
    expect((await record(id))?.deletedAt).toEqual(deletedSeen);

    expect(await purgeAccountSignups(db, daysAfter(deletedSeen, 89))).toBe(0);
    expect(await record(id)).not.toBeNull();
    expect(await purgeAccountSignups(db, daysAfter(deletedSeen, 91))).toBe(1);
    expect(await record(id)).toBeNull();
  });

  it("keeps it 12 months after deletion for an account in a team suspended for abuse", async () => {
    const teamId = await createTeam(db, "phish");
    const id = await account(teamId);
    await suspendTeam(db, { teamId, reason: "phishing" });
    const start = new Date();
    await purgeAccountSignups(db, start);
    expect(await record(id)).toMatchObject({ abuseSuspended: true });

    await deleteAccount(id);
    await purgeAccountSignups(db, daysAfter(start, 1));
    expect(await purgeAccountSignups(db, daysAfter(start, 200))).toBe(0);
    expect(await record(id)).toMatchObject({ abuseSuspended: true });
    expect(await purgeAccountSignups(db, daysAfter(start, 367))).toBe(1);
  });

  it("does not count a review hold or non-payment as abuse", async () => {
    const teamId = await createTeam(db, "held");
    const id = await account(teamId);
    for (const reason of ["review", "non_payment"] as const) {
      await suspendTeam(db, { teamId, reason });
      await purgeAccountSignups(db);
      expect(await record(id), reason).toMatchObject({ abuseSuspended: false });
    }
  });
});

describe("the abuse mark", () => {
  const reinstate = (teamId: string) =>
    db
      .update(schema.teams)
      .set({ suspendedAt: null, suspensionReason: null })
      .where(eq(schema.teams.id, teamId));

  it("is set by the suspension itself, so leaving the team first keeps it", async () => {
    const teamId = await createTeam(db, "phish");
    const id = await account(teamId);
    await suspendTeam(db, { teamId, reason: "manual" });
    expect(await record(id)).toMatchObject({ abuseSuspended: true });
    await db.delete(schema.teamMembers).where(eq(schema.teamMembers.userId, id));
    await deleteAccount(id);
    await purgeAccountSignups(db);
    expect(await record(id)).toMatchObject({ abuseSuspended: true });
  });

  it("is only ever set by the sweep, and cleared by a reinstatement unless another team holds it", async () => {
    const teamId = await createTeam(db, "phish");
    const other = await createTeam(db, "other");
    const id = await account(teamId);
    const alsoElsewhere = await account(teamId);
    await db
      .insert(schema.teamMembers)
      .values({ teamId: other, userId: alsoElsewhere, role: "member" });
    await suspendTeam(db, { teamId, reason: "phishing" });
    await suspendTeam(db, { teamId: other, reason: "reputation" });

    await reinstate(teamId);
    await purgeAccountSignups(db);
    expect(await record(id)).toMatchObject({ abuseSuspended: true });

    await clearAbuseMarks(db, teamId);
    expect(await record(id)).toMatchObject({ abuseSuspended: false });
    expect(await record(alsoElsewhere)).toMatchObject({ abuseSuspended: true });

    // An account that joins a suspended team later is marked by the sweep.
    const late = await account(other);
    expect(await record(late)).toMatchObject({ abuseSuspended: false });
    await purgeAccountSignups(db);
    expect(await record(late)).toMatchObject({ abuseSuspended: true });
  });
});
