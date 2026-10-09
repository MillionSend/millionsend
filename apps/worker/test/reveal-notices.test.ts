import { CONTENT_REVEAL_WINDOW_MS } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runRevealNotices } from "../src/handlers/reveal-notices.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

const OPERATOR = "op";
const OWNER = "bob";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.user).values([
    { id: OPERATOR, name: "Operator", email: "op@example.com" },
    { id: OWNER, name: "Bob", email: "bob@example.com" },
  ]);
  teamId = await createTeam(db, "acme");
  await db.insert(schema.teamMembers).values({ teamId, userId: OWNER, role: "owner" });
});
afterAll(() => close());
afterEach(async () => {
  await db.delete(schema.contentAccessGrants);
  await db
    .update(schema.teams)
    .set({ suspendedAt: null, suspensionReason: null })
    .where(eq(schema.teams.id, teamId));
});

/** A grant made `daysAgo` days back, as the console would have written it. */
async function grant(daysAgo: number): Promise<string> {
  const createdAt = new Date(Date.now() - daysAgo * 86_400_000);
  const [row] = await db
    .insert(schema.contentAccessGrants)
    .values({
      teamId,
      operatorUserId: OPERATOR,
      reason: "phishing_or_malware",
      justification: "A recipient forwarded a lure the stored insights cannot explain.",
      scope: "email",
      emailIds: ["6f1e5b8c-8f3e-4f47-9a1f-2b0f0d3c5a71"],
      createdAt,
      expiresAt: new Date(createdAt.getTime() + CONTENT_REVEAL_WINDOW_MS),
    })
    .returning({ id: schema.contentAccessGrants.id });
  if (!row) throw new Error("grant missing");
  return row.id;
}

const teamRowsFor = (grantId: string) =>
  db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.target, `content_access_grant:${grantId}`))
    .orderBy(desc(schema.auditLog.createdAt));

function recorder() {
  const sent: { to: string; subject: string }[] = [];
  return {
    sent,
    mailer: {
      send: async (to: string, message: { subject: string }) => {
        sent.push({ to, subject: message.subject });
      },
    },
  };
}

const suspend = (reason: "phishing" | "non_payment") =>
  db
    .update(schema.teams)
    .set({ suspendedAt: new Date(), suspensionReason: reason })
    .where(eq(schema.teams.id, teamId));

describe("safety.reveal_notices", () => {
  it("leaves a grant alone until the seventh day", async () => {
    const id = await grant(6);
    expect(await runRevealNotices(db)).toEqual({ disclosed: 0, withheld: 0 });
    expect(await teamRowsFor(id)).toEqual([]);
  });

  it("gives the team its row dated at the access, mails its owners, and says it once", async () => {
    const id = await grant(8);
    const { sent, mailer } = recorder();
    expect(await runRevealNotices(db, { mailer })).toEqual({ disclosed: 1, withheld: 0 });

    const [row] = await teamRowsFor(id);
    expect(row).toMatchObject({
      teamId,
      actorId: "system",
      action: "content.accessed",
      data: { reason: "phishing_or_malware", emails: 1, fields: "subject, rendered text" },
    });
    // Dated at the access, not at the disclosure.
    expect(Date.now() - (row?.createdAt.getTime() ?? 0)).toBeGreaterThan(7 * 86_400_000);
    expect(sent).toEqual([
      { to: "bob@example.com", subject: "An operator read content in your team" },
    ]);

    const [stamped] = await db.select().from(schema.contentAccessGrants);
    expect(stamped?.noticeSentAt).toBeInstanceOf(Date);
    expect(stamped?.teamVisibleAt).toBeInstanceOf(Date);

    expect(await runRevealNotices(db, { mailer })).toEqual({ disclosed: 0, withheld: 0 });
    expect(sent).toHaveLength(1);
  });

  it("withholds row and notice from a team suspended for phishing since the grant", async () => {
    const id = await grant(8);
    await suspend("phishing");
    const { sent, mailer } = recorder();
    expect(await runRevealNotices(db, { mailer })).toEqual({ disclosed: 0, withheld: 1 });
    expect(sent).toEqual([]);
    expect(await teamRowsFor(id)).toEqual([]);

    const [stamped] = await db.select().from(schema.contentAccessGrants);
    expect(stamped?.noticeSentAt).toBeInstanceOf(Date);
    expect(stamped?.teamVisibleAt).toBeNull();
    // Stamped, so the withheld notice is not retried every night.
    expect(await runRevealNotices(db, { mailer })).toEqual({ disclosed: 0, withheld: 0 });
  });

  it("withholds from a team already suspended for phishing before the grant", async () => {
    // A re-suspension keeps the original suspended_at, so an escalation to
    // phishing is indistinguishable from one that was always phishing.
    await suspend("phishing");
    const id = await grant(8);
    expect(await runRevealNotices(db)).toEqual({ disclosed: 0, withheld: 1 });
    expect(await teamRowsFor(id)).toEqual([]);
  });

  it("still discloses to a team suspended for anything else", async () => {
    const id = await grant(8);
    await suspend("non_payment");
    expect(await runRevealNotices(db)).toEqual({ disclosed: 1, withheld: 0 });
    expect(await teamRowsFor(id)).toHaveLength(1);
  });
});
