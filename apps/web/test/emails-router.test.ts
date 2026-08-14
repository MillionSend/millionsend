import { randomBytes } from "node:crypto";
import { EnvKeyring, encryptEmailBody, hashRecipient } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCaller } from "@/server/routers";
import type { Context } from "@/server/trpc";

// The router builds its keyring lazily from the validated env
// (SKIP_ENV_VALIDATION leaves env reads live), so setting the key here —
// before any procedure runs — is what production boot does via config.
const TEST_KEK = randomBytes(32).toString("base64");
process.env.MASTER_ENCRYPTION_KEY = TEST_KEK;

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

function caller(teamId: string) {
  const ctx: Context = {
    db,
    session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
    teamId,
    role: "owner",
  };
  return createCaller(ctx);
}

function baseEmail(teamId: string) {
  return {
    teamId,
    from: "sender@acme.test",
    to: ["ada@example.com"],
    subject: "hello",
  };
}

async function insertEmail(values: typeof schema.emails.$inferInsert): Promise<string> {
  const [row] = await db.insert(schema.emails).values(values).returning({ id: schema.emails.id });
  if (!row) throw new Error("email insert failed");
  return row.id;
}

describe("emails.list", () => {
  it("scopes rows to the caller's team", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const a1 = await insertEmail({
      ...baseEmail(teamA),
      createdAt: new Date("2026-08-01T10:00:00Z"),
    });
    const a2 = await insertEmail({
      ...baseEmail(teamA),
      createdAt: new Date("2026-08-02T10:00:00Z"),
    });
    const b1 = await insertEmail({
      ...baseEmail(teamB),
      createdAt: new Date("2026-08-03T10:00:00Z"),
    });

    const resA = await caller(teamA).emails.list({});
    expect(resA.items.map((r) => r.id)).toEqual([a2, a1]);

    const resB = await caller(teamB).emails.list({});
    expect(resB.items.map((r) => r.id)).toEqual([b1]);
  });

  it("filters by status", async () => {
    const teamA = await createTeam(db, "team-a");
    const delivered = await insertEmail({ ...baseEmail(teamA), latestStatus: "delivered" });
    await insertEmail({ ...baseEmail(teamA), latestStatus: "bounced" });

    const res = await caller(teamA).emails.list({ status: "delivered" });
    expect(res.items.map((r) => r.id)).toEqual([delivered]);
  });

  it("searches by subject and recipient", async () => {
    const teamA = await createTeam(db, "team-a");
    const bySubject = await insertEmail({ ...baseEmail(teamA), subject: "Invoice 42" });
    const byRecipient = await insertEmail({
      ...baseEmail(teamA),
      to: ["grace@example.com"],
      subject: "unrelated",
    });
    await insertEmail({ ...baseEmail(teamA), subject: "other" });

    const subjectHits = await caller(teamA).emails.list({ search: "invoice" });
    expect(subjectHits.items.map((r) => r.id)).toEqual([bySubject]);

    const recipientHits = await caller(teamA).emails.list({ search: "grace@" });
    expect(recipientHits.items.map((r) => r.id)).toEqual([byRecipient]);
  });

  it("pages with a keyset cursor without overlap", async () => {
    const teamA = await createTeam(db, "team-a");
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        await insertEmail({
          ...baseEmail(teamA),
          subject: `email ${i}`,
          createdAt: new Date(Date.UTC(2026, 7, 1 + i)),
        }),
      );
    }

    const page1 = await caller(teamA).emails.list({ limit: 2 });
    expect(page1.items.map((r) => r.id)).toEqual([ids[2], ids[1]]);
    expect(page1.nextCursor).not.toBeNull();

    if (!page1.nextCursor) throw new Error("expected a next cursor");
    const page2 = await caller(teamA).emails.list({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((r) => r.id)).toEqual([ids[0]]);
    expect(page2.nextCursor).toBeNull();
  });

  it("does not skip same-millisecond rows differing only in microseconds", async () => {
    const teamA = await createTeam(db, "team-a");
    // timestamptz keeps microseconds; a JS Date cannot represent these two
    // values distinctly, so they pin the full-precision cursor round-trip.
    const newer = await insertEmail({
      ...baseEmail(teamA),
      subject: "newer",
      createdAt: sql`timestamptz '2026-08-01 10:00:00.123456+00'` as unknown as Date,
    });
    const older = await insertEmail({
      ...baseEmail(teamA),
      subject: "older",
      createdAt: sql`timestamptz '2026-08-01 10:00:00.123400+00'` as unknown as Date,
    });

    const page1 = await caller(teamA).emails.list({ limit: 1 });
    expect(page1.items.map((r) => r.id)).toEqual([newer]);
    if (!page1.nextCursor) throw new Error("expected a next cursor");

    const page2 = await caller(teamA).emails.list({ limit: 1, cursor: page1.nextCursor });
    expect(page2.items.map((r) => r.id)).toEqual([older]);
  });
});

describe("emails.get", () => {
  it("decrypts the body and returns events in order", async () => {
    const teamA = await createTeam(db, "team-a");
    const keyring = EnvKeyring.fromBase64(TEST_KEK);
    const encrypted = await encryptEmailBody({ html: "<p>hi</p>", text: "hi" }, keyring);
    const id = await insertEmail({
      ...baseEmail(teamA),
      latestStatus: "delivered",
      bodyCiphertext: encrypted.ciphertext,
      bodyIv: encrypted.iv,
      bodyWrappedDek: encrypted.wrappedDek,
      bodyKeyVersion: encrypted.keyVersion,
    });
    await db.insert(schema.emailEvents).values([
      { emailId: id, type: "delivered", occurredAt: new Date("2026-08-01T10:05:00Z") },
      { emailId: id, type: "sent", occurredAt: new Date("2026-08-01T10:00:00Z") },
    ]);

    const email = await caller(teamA).emails.get({ id });
    expect(email.html).toBe("<p>hi</p>");
    expect(email.text).toBe("hi");
    expect(email.bodyPurgedAt).toBeNull();
    expect(email.events.map((e) => e.type)).toEqual(["sent", "delivered"]);
    expect(email).not.toHaveProperty("bodyCiphertext");
    expect(email).not.toHaveProperty("bodyWrappedDek");
  });

  it("tolerates a corrupt body and a purged body", async () => {
    const teamA = await createTeam(db, "team-a");
    const corrupt = await insertEmail({
      ...baseEmail(teamA),
      bodyCiphertext: randomBytes(48),
      bodyIv: randomBytes(12),
      bodyWrappedDek: randomBytes(60),
      bodyKeyVersion: 1,
    });
    const purgedAt = new Date("2026-08-01T00:00:00Z");
    const purged = await insertEmail({ ...baseEmail(teamA), bodyPurgedAt: purgedAt });

    const corruptEmail = await caller(teamA).emails.get({ id: corrupt });
    expect(corruptEmail.html).toBeNull();
    expect(corruptEmail.text).toBeNull();

    const purgedEmail = await caller(teamA).emails.get({ id: purged });
    expect(purgedEmail.html).toBeNull();
    expect(purgedEmail.bodyPurgedAt?.getTime()).toBe(purgedAt.getTime());
  });

  it("hides other teams' emails", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const id = await insertEmail(baseEmail(teamA));

    await expect(caller(teamB).emails.get({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("emails.suppressions", () => {
  it("adds, lists, and removes within the team only", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");

    const added = await caller(teamA).emails.suppressions.add({
      email: "Block@Example.com",
      reason: "manual",
    });

    const listA = await caller(teamA).emails.suppressions.list({});
    expect(listA.items).toHaveLength(1);
    expect(listA.items[0]?.id).toBe(added.id);
    expect(listA.items[0]?.reason).toBe("manual");

    const [row] = await db
      .select()
      .from(schema.suppressions)
      .where(
        and(
          eq(schema.suppressions.teamId, teamA),
          eq(schema.suppressions.emailHash, hashRecipient("block@example.com")),
        ),
      );
    expect(row?.id).toBe(added.id);

    const listB = await caller(teamB).emails.suppressions.list({});
    expect(listB.items).toHaveLength(0);
    await expect(caller(teamB).emails.suppressions.remove({ id: added.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await caller(teamA).emails.suppressions.remove({ id: added.id });
    const afterRemove = await caller(teamA).emails.suppressions.list({});
    expect(afterRemove.items).toHaveLength(0);
  });

  it("pages without skipping same-millisecond suppressions", async () => {
    const teamA = await createTeam(db, "team-a");
    async function insertSuppression(email: string, createdAt: string): Promise<string> {
      const [row] = await db
        .insert(schema.suppressions)
        .values({
          teamId: teamA,
          email,
          emailHash: hashRecipient(email),
          reason: "manual",
          createdAt: sql`${createdAt}::timestamptz` as unknown as Date,
        })
        .returning({ id: schema.suppressions.id });
      if (!row) throw new Error("suppression insert failed");
      return row.id;
    }
    const newer = await insertSuppression("a@example.com", "2026-08-01 10:00:00.123456+00");
    const older = await insertSuppression("b@example.com", "2026-08-01 10:00:00.123400+00");

    const page1 = await caller(teamA).emails.suppressions.list({ limit: 1 });
    expect(page1.items.map((r) => r.id)).toEqual([newer]);
    if (!page1.nextCursor) throw new Error("expected a next cursor");

    const page2 = await caller(teamA).emails.suppressions.list({
      limit: 1,
      cursor: page1.nextCursor,
    });
    expect(page2.items.map((r) => r.id)).toEqual([older]);
  });

  it("is idempotent on duplicate adds", async () => {
    const teamA = await createTeam(db, "team-a");
    const first = await caller(teamA).emails.suppressions.add({
      email: "dup@example.com",
      reason: "manual",
    });
    const second = await caller(teamA).emails.suppressions.add({
      email: "Dup@example.com",
      reason: "manual",
    });
    expect(second.id).toBe(first.id);

    const list = await caller(teamA).emails.suppressions.list({});
    expect(list.items).toHaveLength(1);
  });
});
