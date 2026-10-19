import { randomBytes, randomUUID } from "node:crypto";
import {
  deriveUnsubscribeKey,
  EnvKeyring,
  encryptEmailBody,
  MONITOR_SETTING_DEFAULTS,
  type MonitorDeps,
  recordPhishingFingerprints,
  suspendTeam,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { type BroadcastDeps, sendBroadcast } from "../src/handlers/send-broadcast.js";
import { type SendDeps, sendEmail } from "../src/handlers/send-email.js";

/**
 * A new team that matches a team suspended for phishing is held at its
 * first send, transactional or broadcast, before anything reaches SES.
 */

let db: Db;
let close: () => Promise<void>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const DAY = 86_400_000;
const LURE_FROM = "Facture Vexto";
let sesCalls: string[];
let fanOutRetries: string[];

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  // The team an operator suspended for phishing, with the mail it left.
  const phisher = await createTeam(db, "facture-vexto");
  await stored(phisher, "vexto-cadeaux.example", "Votre facture Vexto du 02/10 est disponible");
  await suspendTeam(db, { teamId: phisher, reason: "phishing" });
  await recordPhishingFingerprints(
    db,
    { teamId: phisher, reason: "phishing" },
    { keyring: () => keyring, cards: async () => [] },
  );
});
afterAll(() => close());
beforeEach(() => {
  sesCalls = [];
  fanOutRetries = [];
});

const monitor: MonitorDeps = {
  samplingKey: Buffer.alloc(32, 7),
  settings: async () => MONITOR_SETTING_DEFAULTS,
  enqueueJudge: async () => {},
};
const sendDeps: SendDeps = {
  keyring,
  ses: {
    sendRaw: async ({ emailId }) => {
      sesCalls.push(emailId);
      return { messageId: `mid-${emailId}` };
    },
  },
  monitor,
};
const broadcastDeps: BroadcastDeps = {
  keyring,
  unsubscribeSecretKey: deriveUnsubscribeKey(randomBytes(32)),
  unsubscribeBaseUrl: "https://app.example.com",
  isCloud: false,
  enqueueEmailSends: async () => {},
  reschedule: async (broadcastId) => void fanOutRetries.push(broadcastId),
  monitor,
};

async function stored(teamId: string, domain: string, subject: string, sent = true) {
  const id = randomUUID();
  const body = await encryptEmailBody(
    { html: "<p>Bonjour, votre facture est disponible.</p>", text: null },
    keyring,
    { teamId, rowId: id },
  );
  const [row] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: domain,
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: schema.domains.id });
  await db.insert(schema.emails).values({
    id,
    teamId,
    domainId: row?.id ?? null,
    from: `${LURE_FROM} <factures@${domain}>`,
    to: ["client@example.org"],
    subject,
    latestStatus: sent ? "sent" : "queued",
    bodyCiphertext: body.ciphertext,
    bodyIv: body.iv,
    bodyWrappedDek: body.wrappedDek,
    bodyKeyVersion: body.keyVersion,
  });
  return id;
}

const team = async (teamId: string) =>
  (await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)))[0];
const links = (teamId: string) =>
  db.select().from(schema.teamLinks).where(eq(schema.teamLinks.teamId, teamId));

it("holds a new team whose first email matches a team suspended for phishing, parking it for review", async () => {
  const teamId = await createTeam(db, "newcomer");
  const id = await stored(
    teamId,
    "newcomer.dev",
    "Votre facture Vexto du 04/10 est disponible",
    false,
  );
  expect(await sendEmail(db, sendDeps, { emailId: id })).toBe("parked");
  expect((await db.select().from(schema.emails).where(eq(schema.emails.id, id)))[0]).toMatchObject({
    latestStatus: "queued_quota",
    parkReason: "review",
  });
  expect(await team(teamId)).toMatchObject({ suspensionReason: "review" });
  expect(await links(teamId)).toMatchObject([{ trigger: "send", held: true }]);
  expect(sesCalls).toEqual([]);
});

it("never compares a team past its first window on send", async () => {
  const teamId = await createTeam(db, "old-billing");
  await db.insert(schema.teamMonitor).values({
    teamId,
    sentTotal: 20_000,
    firstSendAt: new Date(Date.now() - 200 * DAY),
  });
  const id = await stored(
    teamId,
    "old-billing.dev",
    "Votre facture Vexto du 04/10 est disponible",
    false,
  );
  expect(await sendEmail(db, sendDeps, { emailId: id })).toBe("sent");
  expect(await links(teamId)).toEqual([]);
  expect((await team(teamId))?.suspendedAt).toBeNull();
});

it("holds a new team before its first broadcast fans out", async () => {
  const teamId = await createTeam(db, "newcomer-news");
  await db.insert(schema.domains).values({
    teamId,
    name: "newcomer-news.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  await db.insert(schema.contacts).values({ teamId, email: "a@example.com" });
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({
      teamId,
      from: `${LURE_FROM} <factures@newcomer-news.dev>`,
      subject: "Votre facture Vexto du 04/10 est disponible",
      html: "<p>Bonjour</p>",
      status: "scheduled",
    })
    .returning({ id: schema.broadcasts.id });
  const broadcastId = broadcast?.id ?? "";
  expect(await sendBroadcast(db, broadcastDeps, { broadcastId })).toBe("deferred");
  expect(fanOutRetries).toEqual([broadcastId]);
  expect(
    (await db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, broadcastId)))[0]
      ?.status,
  ).toBe("scheduled");
  expect(await team(teamId)).toMatchObject({ suspensionReason: "review" });
  expect(await links(teamId)).toMatchObject([{ trigger: "send", held: true }]);
  expect(
    await db.select().from(schema.emails).where(eq(schema.emails.broadcastId, broadcastId)),
  ).toEqual([]);
});
