import { randomBytes } from "node:crypto";
import { acceptEmail, EnvKeyring, encryptEmailBody, suspendTeam } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { drainQuotaParked } from "../src/handlers/cron.js";
import { type SesSender, sendEmail } from "../src/handlers/send-email.js";

/**
 * Mail a held team sends, and mail it had queued, waits out the review:
 * releasing the hold sends it, a phishing suspension keeps it parked.
 */

let db: Db;
let close: () => Promise<void>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const sent: string[] = [];
const ses: SesSender = {
  sendRaw: async ({ emailId }) => {
    sent.push(emailId);
    return { messageId: `mid-${emailId}` };
  },
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

async function heldTeam(slug: string) {
  const teamId = await createTeam(db, slug);
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: `${slug}.dev`,
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
    })
    .returning({ id: schema.domains.id });
  // Queued before the hold landed.
  const encrypted = await encryptEmailBody({ html: "<p>hi</p>", text: "hi" }, keyring);
  const [queued] = await db
    .insert(schema.emails)
    .values({
      teamId,
      domainId: domain?.id,
      from: `A <a@${slug}.dev>`,
      to: ["r@example.com"],
      subject: "before",
      bodyCiphertext: encrypted.ciphertext,
      bodyIv: encrypted.iv,
      bodyWrappedDek: encrypted.wrappedDek,
      bodyKeyVersion: encrypted.keyVersion,
    })
    .returning({ id: schema.emails.id });
  await suspendTeam(db, { teamId, reason: "review", ifNotSuspended: true });
  const accepted = await acceptEmail(
    { db, keyring, isCloud: true, enqueueEmailSend: async () => {} },
    {
      teamId,
      billing: {
        plan: "free",
        planQuota: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        overageEnabled: false,
      },
      apiKeyId: null,
    },
    {
      from: `A <a@${slug}.dev>`,
      to: ["r@example.com"],
      subject: "during",
      text: "hi",
      domainId: domain?.id ?? null,
    },
    { parkUnderReview: true },
  );
  if (!accepted.ok) throw new Error(accepted.reason);
  expect(accepted).toMatchObject({ parked: true, underReview: true });
  // The job of the queued row runs under the hold.
  expect(await sendEmail(db, { keyring, ses }, { emailId: queued?.id ?? "" })).toBe("parked");
  const ids = [queued?.id ?? "", accepted.id];
  for (const id of ids) {
    const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
    expect(row).toMatchObject({ latestStatus: "queued_quota", parkReason: "review" });
  }
  return { teamId, ids };
}

const drain = async () => {
  const enqueued: string[] = [];
  await drainQuotaParked(db, {
    isCloud: true,
    enqueueSends: async (batch) => void enqueued.push(...batch.map((j) => j.emailId)),
  });
  return enqueued;
};

it("sends what waited once the hold is released", async () => {
  const { teamId, ids } = await heldTeam("released");
  expect(await drain()).toEqual([]);
  await db
    .update(schema.teams)
    .set({ suspendedAt: null, suspensionReason: null })
    .where(eq(schema.teams.id, teamId));
  const released = await drain();
  expect(released.sort()).toEqual([...ids].sort());
  for (const id of released)
    expect(await sendEmail(db, { keyring, ses }, { emailId: id })).toBe("sent");
  expect(sent).toEqual(expect.arrayContaining(ids));
});

it("cancels it once the hold becomes a phishing suspension, so no reinstatement drains it", async () => {
  const { teamId, ids } = await heldTeam("converted");
  await suspendTeam(db, { teamId, reason: "phishing" });
  for (const id of ids) {
    const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
    expect(row).toMatchObject({ latestStatus: "canceled", sentAt: null });
  }
  const [audit] = await db
    .select({ action: schema.auditLog.action, data: schema.auditLog.data })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.teamId, teamId));
  expect(audit).toMatchObject({
    action: "screening.canceled",
    data: { emails: ids.length, reason: "phishing" },
  });
  await db
    .update(schema.teams)
    .set({ suspendedAt: null, suspensionReason: null })
    .where(eq(schema.teams.id, teamId));
  expect(await drain()).toEqual([]);
  expect(sent.filter((id) => ids.includes(id))).toEqual([]);
});
