import { randomUUID } from "node:crypto";
import { recordSignup, suspendTeam } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

const OPERATOR = "op";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db
    .insert(schema.user)
    .values({ id: OPERATOR, name: "Operator", email: "op@example.com", createdAt: new Date(0) });
  teamId = await createTeam(db, "acme");
});
afterAll(() => close());
afterEach(() => vi.unstubAllEnvs());

const operator = () =>
  createCaller({
    db,
    session: {
      user: { id: OPERATOR, email: "op@example.com", name: "Operator" },
      session: { id: "s-op", createdAt: new Date() },
    },
    teamId: null,
    role: null,
  });

async function person(email: string, ip: string | null, team?: string) {
  const id = randomUUID();
  await db.insert(schema.user).values({ id, name: email.split("@")[0] ?? email, email });
  await recordSignup(db, { userId: id, email, ip, userAgent: "Firefox" });
  if (team) await db.insert(schema.teamMembers).values({ teamId: team, userId: id, role: "owner" });
  return id;
}

async function session(userId: string, ip: string, updatedAt: Date) {
  await db.insert(schema.session).values({
    id: randomUUID(),
    token: randomUUID(),
    userId,
    ipAddress: ip,
    expiresAt: new Date(Date.now() + 86_400_000),
    updatedAt,
  });
}

describe("console.accounts.members", () => {
  it("lists where each member signed up and was last seen, and who else used those IPs", async () => {
    const ada = await person("ada@acme.dev", "203.0.113.9", teamId);
    await session(ada, "198.51.100.1", new Date(Date.now() - 86_400_000));
    await session(ada, "198.51.100.2", new Date());

    const phisherTeam = await createTeam(db, "facture-vexto");
    await person("facture@gmail.com", "203.0.113.9", phisherTeam);
    await suspendTeam(db, { teamId: phisherTeam, reason: "phishing" });
    const gone = await person("gone@mailinator.com", "198.51.100.2");
    await db.delete(schema.user).where(eq(schema.user.id, gone));
    await db
      .update(schema.accountSignups)
      .set({ deletedAt: new Date() })
      .where(eq(schema.accountSignups.userId, gone));
    const bob = await person("bob@example.com", null);
    await session(bob, "203.0.113.9", new Date());
    await person("stranger@example.com", "192.0.2.50");

    vi.stubEnv("IP_GEOLOCATION", "false");
    const view = await operator().console.accounts.members({ teamId });
    expect(view.geo).toBe(false);
    expect(view.members).toMatchObject([
      {
        email: "ada@acme.dev",
        role: "owner",
        signup: { ip: "203.0.113.9", userAgent: "Firefox", geo: null },
        lastSeen: { ip: "198.51.100.2" },
      },
    ]);
    expect(view.others).toEqual([
      {
        email: "facture@gmail.com",
        disposable: false,
        ip: "203.0.113.9",
        seen: "signup",
        deleted: false,
        suspension: "phishing",
        // Marked by the suspension itself, not left for the hourly sweep.
        abuseSuspended: true,
      },
      {
        email: "bob@example.com",
        disposable: false,
        ip: "203.0.113.9",
        seen: "session",
        deleted: false,
        suspension: null,
        abuseSuspended: false,
      },
      {
        email: "gone@mailinator.com",
        disposable: true,
        ip: "198.51.100.2",
        seen: "signup",
        deleted: true,
        suspension: null,
        abuseSuspended: false,
      },
    ]);

    vi.stubEnv("IP_GEOLOCATION", "true");
    const located = await operator().console.accounts.members({ teamId });
    expect(located.geo).toBe(true);
    // No database downloaded yet: the network and country are unknown.
    expect(located.members[0]?.signup?.geo).toEqual({ country: null, asn: null, org: null });
  });

  it("keeps the suspended accounts listed under a crowd of fresh ones on the same IPs", async () => {
    const team = await createTeam(db, "flooded");
    const member = await person("member@flooded.dev", "192.0.2.77", team);
    await session(member, "192.0.2.78", new Date());
    const burned = await createTeam(db, "burned");
    await person("burned@gmail.com", "192.0.2.77", burned);
    const returning = await person("zz-returning@gmail.com", null, burned);
    await session(returning, "192.0.2.78", new Date());
    await suspendTeam(db, { teamId: burned, reason: "phishing" });
    for (let i = 0; i < 25; i++) {
      await person(`fresh${i}@example.com`, "192.0.2.77");
      const crowd = await person(`crowd${i}@example.com`, null);
      await session(crowd, "192.0.2.78", new Date());
    }
    vi.stubEnv("IP_GEOLOCATION", "false");
    const view = await operator().console.accounts.members({ teamId: team });
    expect(view.others.slice(0, 2)).toMatchObject([
      { email: "burned@gmail.com", seen: "signup", suspension: "phishing" },
      { email: "zz-returning@gmail.com", seen: "session", suspension: "phishing" },
    ]);
  });

  it("is the operator's alone", async () => {
    const member = await person("member@acme.dev", null, teamId);
    const caller = createCaller({
      db,
      session: {
        user: { id: member, email: "member@acme.dev", name: "member" },
        session: { id: "s-member", createdAt: new Date() },
      },
      teamId,
      role: "owner",
    });
    await expect(caller.console.accounts.members({ teamId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
