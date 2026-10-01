import { randomBytes } from "node:crypto";
import { EnvKeyring, encryptEmailBody } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_KEK = randomBytes(32).toString("base64");
process.env.MASTER_ENCRYPTION_KEY = TEST_KEK;

import type { TeamRole } from "@/server/membership";
import { createCaller } from "@/server/routers";

vi.mock("@/server/queue", () => ({
  getQueue: async () => ({ runCronNow: async () => {} }),
  enqueueEmailSend: async () => {},
  enqueueWebhookDeliveries: async () => {},
  enqueueRecipientErase: async () => {},
}));

let db: Db;
let close: () => Promise<void>;
let teamId: string;

const OPERATOR = "op";
const MEMBER = "bob";
const JUSTIFICATION = "A recipient forwarded a lure that the stored insights cannot explain.";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.user).values([
    { id: OPERATOR, name: "Operator", email: "op@example.com", createdAt: new Date(0) },
    { id: MEMBER, name: "Bob", email: "bob@example.com", createdAt: new Date(1) },
  ]);
  teamId = await createTeam(db, "acme");
  await db.insert(schema.teamMembers).values({ teamId, userId: MEMBER, role: "owner" });
});
afterAll(() => close());

beforeEach(() => vi.stubEnv("CONTENT_REVEAL", "on"));
afterEach(async () => {
  vi.unstubAllEnvs();
  // audit_log is append-only: assertions scope themselves by action instead.
  await db.delete(schema.contentAccessGrants);
  await db.delete(schema.emails);
  await db
    .update(schema.teams)
    .set({ suspendedAt: null, suspensionReason: null })
    .where(eq(schema.teams.id, teamId));
});

function callerFor(
  userId: string | null,
  team: string | null = null,
  role: TeamRole | null = null,
) {
  return createCaller({
    db,
    session: userId
      ? {
          user: { id: userId, email: `${userId}@example.com`, name: userId },
          session: { id: `s-${userId}`, createdAt: new Date() },
        }
      : null,
    teamId: team,
    role,
  });
}
const operator = () => callerFor(OPERATOR);
const member = () => callerFor(MEMBER, teamId, "owner");

/** What the team's own audit shows of one grant — nothing, until day 7. */
async function teamContentRows(grantId?: string) {
  const { items } = await member().audit.list({ limit: 50 });
  return items.filter(
    (row) =>
      row.action.startsWith("content.") &&
      (grantId === undefined || row.target === `content_access_grant:${grantId}`),
  );
}

async function instanceRows(action: string) {
  return db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, action))
    .orderBy(desc(schema.auditLog.createdAt));
}

const HTML =
  "<p>Regularize seu acesso.</p>" +
  '<div style="display:none">hidden filler</div>' +
  "<p>Seu código é 448122. Confirme em https://verify.long-host.example.com/session/abcdefghijklmnop.</p>";

/** One flagged email: a failing critical check and a sealed body. */
async function flaggedEmail(opts: { purged?: boolean; html?: string } = {}) {
  const keyring = EnvKeyring.fromBase64(TEST_KEK);
  const [row] = await db
    .insert(schema.emails)
    .values({
      teamId,
      from: "billing@acme.example",
      to: ["a@example.com", "b@example.com"],
      subject: "Sua conta precisa de atenção",
      latestStatus: "delivered",
      sentAt: new Date(),
    })
    .returning({ id: schema.emails.id });
  if (!row) throw new Error("email missing");
  const sealed = await encryptEmailBody({ html: opts.html ?? HTML, text: null }, keyring, {
    teamId,
    rowId: row.id,
  });
  await db
    .update(schema.emails)
    .set(
      opts.purged
        ? { bodyPurgedAt: new Date() }
        : {
            bodyCiphertext: sealed.ciphertext,
            bodyIv: sealed.iv,
            bodyWrappedDek: sealed.wrappedDek,
            bodyKeyVersion: sealed.keyVersion,
          },
    )
    .where(eq(schema.emails.id, row.id));
  await db.insert(schema.emailInsights).values({
    teamId,
    emailId: row.id,
    marketing: false,
    checks: [
      { id: "auth_alignment", severity: "critical", status: "fail", penaltyHundredths: 350 },
    ],
    scoreTenths: 40,
    scoreVersion: 1,
  });
  return row.id;
}

const grantFor = (emailId: string) =>
  operator().console.safety.requestAccess({
    teamId,
    reason: "phishing_or_malware",
    justification: JUSTIFICATION,
    scope: "email",
    emailId,
  });

describe("console.safety.requestAccess", () => {
  it("refuses everyone but the operator, and refuses the operator while the flag is off", async () => {
    const emailId = await flaggedEmail();
    await expect(
      member().console.safety.requestAccess({
        teamId,
        reason: "phishing_or_malware",
        justification: JUSTIFICATION,
        scope: "email",
        emailId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    vi.stubEnv("CONTENT_REVEAL", "off");
    await expect(grantFor(emailId)).rejects.toMatchObject({ code: "FORBIDDEN", message: "off" });
    expect(await db.select().from(schema.contentAccessGrants)).toHaveLength(0);
  });

  it("wants an email id when the scope is one email", async () => {
    await flaggedEmail();
    await expect(
      operator().console.safety.requestAccess({
        teamId,
        reason: "phishing_or_malware",
        justification: JUSTIFICATION,
        scope: "email",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("reads one named message for a customer's request or a legal one, never the window", async () => {
    await flaggedEmail();
    const before = (await db.select().from(schema.contentAccessGrants)).length;
    for (const reason of ["owner_support_request", "legal_request"] as const) {
      await expect(
        operator().console.safety.requestAccess({
          teamId,
          reason,
          justification: JUSTIFICATION,
          scope: "flagged_window",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(await db.select().from(schema.contentAccessGrants)).toHaveLength(before);
  });

  it("wants a justification of some substance", async () => {
    const emailId = await flaggedEmail();
    await expect(
      operator().console.safety.requestAccess({
        teamId,
        reason: "phishing_or_malware",
        justification: "looks bad",
        scope: "email",
        emailId,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("records the grant and an instance audit row the team cannot see", async () => {
    const emailId = await flaggedEmail();
    const granted = await grantFor(emailId);
    expect(granted.emailIds).toEqual([emailId]);
    expect(granted.refused).toEqual([]);
    expect(granted.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);

    const [grant] = await db.select().from(schema.contentAccessGrants);
    expect(grant).toMatchObject({
      teamId,
      operatorUserId: OPERATOR,
      reason: "phishing_or_malware",
      justification: JUSTIFICATION,
      scope: "email",
      viewCount: 0,
      approvedBy: null,
      noticeSentAt: null,
      teamVisibleAt: null,
    });

    const [row] = await instanceRows("content.revealed");
    expect(row).toMatchObject({
      teamId: null,
      actorId: `user:${OPERATOR}`,
      target: `team:${teamId}`,
      data: { grantId: granted.grantId, emails: 1, fields: "subject, rendered text" },
    });
    // The operator's own words are the grant's, not the audit's.
    expect(JSON.stringify(row?.data)).not.toContain("recipient forwarded");
    expect(await teamContentRows(granted.grantId)).toEqual([]);
  });

  it("refuses an email outside the team's flagged window", async () => {
    const other = await createTeam(db, "other");
    const [stray] = await db
      .insert(schema.emails)
      .values({
        teamId: other,
        from: "x@example.com",
        to: ["y@example.com"],
        subject: "unflagged",
        sentAt: new Date(),
      })
      .returning({ id: schema.emails.id });
    await expect(grantFor(stray?.id ?? teamId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a purged body and covers the window when the scope is the window", async () => {
    const purged = await flaggedEmail({ purged: true });
    await expect(grantFor(purged)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "purged",
    });

    const live = await flaggedEmail();
    const granted = await operator().console.safety.requestAccess({
      teamId,
      reason: "complaint_spike",
      justification: JUSTIFICATION,
      scope: "flagged_window",
    });
    expect(granted.emailIds).toEqual([live]);
    expect(granted.refused).toEqual([{ emailId: purged, status: "purged" }]);
  });
});

describe("console.safety.revealed", () => {
  it("returns the redacted rendered text and nothing else of the message", async () => {
    const emailId = await flaggedEmail();
    const { grantId } = await grantFor(emailId);
    const view = await operator().console.safety.revealed({ grantId, emailId });

    expect(view.subject.map((s) => s.text).join("")).toBe("Sua conta precisa de atenção");
    const text = view.spans.map((s) => s.text).join("");
    expect(text).toContain("Regularize seu acesso.");
    expect(text).not.toContain("hidden filler");
    expect(text).not.toContain("448122");
    expect(text).toContain("https://example.com/session/abcdefghijklmno…");
    expect(view.redactions).toBe(2);
    expect(view.subject.some((s) => s.redacted)).toBe(false);
    expect(view.viewCount).toBe(1);

    const payload = JSON.stringify(view);
    expect(payload).not.toContain("a@example.com");
    expect(payload).not.toContain("<p>");
    expect(view).not.toHaveProperty("html");

    await operator().console.safety.revealed({ grantId, emailId });
    const [grant] = await db.select().from(schema.contentAccessGrants);
    expect(grant?.viewCount).toBe(2);
    expect(grant?.lastViewedAt).toBeInstanceOf(Date);
  });

  it("refuses after the window closes, off the grant, and for anyone else", async () => {
    const emailId = await flaggedEmail();
    const other = await flaggedEmail();
    const { grantId } = await grantFor(emailId);

    await expect(
      operator().console.safety.revealed({ grantId, emailId: other }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "not_in_grant" });
    await expect(member().console.safety.revealed({ grantId, emailId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    vi.stubEnv("CONTENT_REVEAL", "off");
    await expect(operator().console.safety.revealed({ grantId, emailId })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "off",
    });
    vi.stubEnv("CONTENT_REVEAL", "on");

    await db
      .update(schema.contentAccessGrants)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.contentAccessGrants.id, grantId));
    await expect(operator().console.safety.revealed({ grantId, emailId })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "expired",
    });
  });

  it("refuses a body retention has purged since the grant", async () => {
    const emailId = await flaggedEmail();
    const { grantId } = await grantFor(emailId);
    await db
      .update(schema.emails)
      .set({ bodyPurgedAt: new Date(), bodyCiphertext: null })
      .where(eq(schema.emails.id, emailId));
    await expect(operator().console.safety.revealed({ grantId, emailId })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "purged",
    });
  });

  it("carries the live grant and the week's count onto the console screens", async () => {
    const emailId = await flaggedEmail();
    const { grantId } = await grantFor(emailId);
    const review = await operator().console.safety.review({ teamId });
    expect(review.contentReveal).toBe(true);
    expect(review.grants).toMatchObject([{ id: grantId, emailIds: [emailId], viewCount: 0 }]);
    const list = await operator().console.safety.list({ status: "all" });
    expect(list.counts.revealsThisWeek).toBe(1);
  });
});
