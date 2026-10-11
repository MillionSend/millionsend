import { randomBytes, randomUUID } from "node:crypto";
import {
  type AbuseJudge,
  deriveUnsubscribeKey,
  EnvKeyring,
  encryptEmailBody,
  MONITOR_SETTING_DEFAULTS,
  type MonitorDeps,
  releaseWaitingEmails,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { asc, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { judgeSample } from "../src/handlers/abuse-judge.js";
import { drainQuotaParked } from "../src/handlers/cron.js";
import { type BroadcastDeps, sendBroadcast } from "../src/handlers/send-broadcast.js";
import { type SendDeps, sendEmail } from "../src/handlers/send-email.js";

/**
 * New destinations are judged before SES at every tier: what counts as new,
 * what clears it, and what a phishing verdict on one does past the new tier.
 */

let db: Db;
let close: () => Promise<void>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const DAY = 86_400_000;
const PLATFORM = new Set(["millionsend.test"]);
const unsubscribeSecretKey = deriveUnsubscribeKey(randomBytes(32));
let sesCalls: string[];
let mails: { kind: string; text: string }[];
let resent: string[];
let fanOuts: string[];

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db
    .insert(schema.user)
    .values({ id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) });
});
afterAll(() => close());
beforeEach(() => {
  sesCalls = [];
  mails = [];
  resent = [];
  fanOuts = [];
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
  platformDomains: PLATFORM,
  unsubscribe: { secretKey: unsubscribeSecretKey, baseUrl: "https://app.millionsend.test" },
};

const verdict = (score: number, phishing = true): AbuseJudge => ({
  provider: "typesafe",
  model: "fake-model",
  judge: async () => ({
    score,
    ...(phishing
      ? {
          verdict: "abuse" as const,
          categories: ["phishing_credentials"],
          reasons: ["impersonation"],
        }
      : { verdict: "clean" as const, categories: [], reasons: [] }),
    impersonatedBrand: null,
    language: "en",
  }),
});

const judge = (sampleId: string, answer: AbuseJudge, linkYoung = false) =>
  judgeSample(
    db,
    {
      judge: answer,
      keyring,
      settings: async () => MONITOR_SETTING_DEFAULTS,
      mailer: { send: async (_to, m) => void mails.push({ kind: m.kind, text: m.text }) },
      enqueueSend: async (emailId) => void resent.push(emailId),
      enqueueBroadcast: async (broadcastId) => void fanOuts.push(broadcastId),
      platformDomains: PLATFORM,
      linkDomainYoung: async () => linkYoung,
    },
    { sampleId },
  );

/** A team of a tier: Established (or Trusted), or New in its first window. */
async function team(slug: string, tier: "new" | "established" | "trusted") {
  const teamId = await createTeam(db, slug);
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: `${slug}.dev`,
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
      registeredAt: new Date(Date.now() - 900 * DAY),
    })
    .returning({ id: schema.domains.id });
  await db.insert(schema.teamMonitor).values({
    teamId,
    sentTotal: tier === "new" ? 1 : tier === "trusted" ? 60_000 : 20_000,
    firstSendAt: new Date(Date.now() - (tier === "new" ? 60_000 : 200 * DAY)),
  });
  return { teamId, domainId: domain?.id ?? "", slug };
}

async function email(t: { teamId: string; domainId: string; slug: string }, href: string) {
  const id = randomUUID();
  const body = await encryptEmailBody(
    { html: `<p>Hello <a href="${href}">open</a></p>`, text: null },
    keyring,
    { teamId: t.teamId, rowId: id },
  );
  await db.insert(schema.emails).values({
    id,
    teamId: t.teamId,
    domainId: t.domainId,
    from: `Team <hi@${t.slug}.dev>`,
    to: ["r@example.org"],
    subject: "Hello",
    bodyCiphertext: body.ciphertext,
    bodyIv: body.iv,
    bodyWrappedDek: body.wrappedDek,
    bodyKeyVersion: body.keyVersion,
  });
  return id;
}

const sampleOf = async (emailId: string) =>
  (
    await db
      .select()
      .from(schema.monitorSamples)
      .where(eq(schema.monitorSamples.emailId, emailId))
      .orderBy(desc(schema.monitorSamples.createdAt))
  )[0];
const row = async (emailId: string) =>
  (await db.select().from(schema.emails).where(eq(schema.emails.id, emailId)))[0];
const cleared = async (teamId: string) =>
  (
    await db
      .select({ domain: schema.teamDestinations.domain })
      .from(schema.teamDestinations)
      .where(eq(schema.teamDestinations.teamId, teamId))
  ).map((r) => r.domain);

it("never screens mail that links only to the team's own domains", async () => {
  const t = await team("own-links", "established");
  const id = await email(t, `https://www.own-links.dev/login`);
  expect(await sendEmail(db, sendDeps, { emailId: id })).toBe("sent");
  expect((await sampleOf(id))?.screening ?? false).toBe(false);
});

it("screens a new destination at every tier, clears it on a clean verdict, and lets later mail through", async () => {
  for (const tier of ["established", "trusted"] as const) {
    const t = await team(`clean-${tier}`, tier);
    const first = await email(t, "https://docs.partner-portal.com/start");
    expect(await sendEmail(db, sendDeps, { emailId: first })).toBe("deferred");
    const sample = await sampleOf(first);
    expect(sample).toMatchObject({ kind: "destination", screening: true, status: "pending" });
    expect(await judge(sample?.id ?? "", verdict(12, false))).toBe("judged");
    expect(await sampleOf(first)).toMatchObject({ destinations: ["partner-portal.com"] });
    expect(await cleared(t.teamId)).toEqual(["partner-portal.com"]);
    expect(resent).toEqual([first]);
    expect(await sendEmail(db, sendDeps, { emailId: first })).toBe("sent");

    const next = await email(t, "https://partner-portal.com/other");
    expect(await sendEmail(db, sendDeps, { emailId: next })).toBe("sent");
    resent = [];
  }
});

it("never clears a shortener: every mail through one is judged first", async () => {
  const t = await team("shortener", "established");
  const first = await email(t, "https://bit.ly/abc");
  expect(await sendEmail(db, sendDeps, { emailId: first })).toBe("deferred");
  await judge((await sampleOf(first))?.id ?? "", verdict(5, false));
  expect(await cleared(t.teamId)).toEqual([]);
  const next = await email(t, "https://bit.ly/xyz");
  expect(await sendEmail(db, sendDeps, { emailId: next })).toBe("deferred");
});

it("parks a team past new's mail to a new destination on 90, alerts once a day, and never holds the team", async () => {
  const t = await team("hijacked", "established");
  const first = await email(t, "https://secure-login-update.com/x");
  await sendEmail(db, sendDeps, { emailId: first });
  expect(await judge((await sampleOf(first))?.id ?? "", verdict(93))).toBe("judged");
  expect(await sendEmail(db, sendDeps, { emailId: first })).toBe("parked");
  expect(await row(first)).toMatchObject({
    latestStatus: "queued_quota",
    parkReason: "destination",
  });
  const [team1] = await db.select().from(schema.teams).where(eq(schema.teams.id, t.teamId));
  expect(team1?.suspendedAt).toBeNull();
  expect(mails.filter((m) => m.kind === "monitor.destination_parked")).toHaveLength(1);
  expect(mails[0]?.text).toContain("secure-login-update");

  const second = await email(t, "https://secure-login-update.com/y");
  await sendEmail(db, sendDeps, { emailId: second });
  await judge((await sampleOf(second))?.id ?? "", verdict(95));
  expect(await sendEmail(db, sendDeps, { emailId: second })).toBe("parked");
  expect(mails.filter((m) => m.kind === "monitor.destination_parked")).toHaveLength(1);
  expect(sesCalls).toEqual([]);

  // Released from the review list: sent unscreened, and the destination clears.
  expect(
    await releaseWaitingEmails(db, { teamId: t.teamId, emailIds: [first], holdLine: 80 }),
  ).toEqual({ parked: 1, queued: [] });
  expect(await cleared(t.teamId)).toEqual(["secure-login-update.com"]);
  const drained: string[] = [];
  await drainQuotaParked(db, {
    isCloud: true,
    enqueueSends: async (batch) => void drained.push(...batch.map((j) => j.emailId)),
  });
  expect(drained).toEqual([first]);
  expect(await sendEmail(db, sendDeps, { emailId: first })).toBe("sent");
});

it("parks it on 80 only when the link domain is under 7 days old", async () => {
  const t = await team("young-link-past-new", "established");
  const aged = await email(t, "https://aged-lure.com/x");
  await sendEmail(db, sendDeps, { emailId: aged });
  await judge((await sampleOf(aged))?.id ?? "", verdict(84), false);
  expect(await sendEmail(db, sendDeps, { emailId: aged })).toBe("sent");

  const fresh = await email(t, "https://fresh-lure.com/x");
  await sendEmail(db, sendDeps, { emailId: fresh });
  await judge((await sampleOf(fresh))?.id ?? "", verdict(84), true);
  expect(await sampleOf(fresh)).toMatchObject({ linkYoung: true });
  expect(await sendEmail(db, sendDeps, { emailId: fresh })).toBe("parked");
  expect(await row(fresh)).toMatchObject({ parkReason: "destination" });
});

it("holds a new team on one phishing verdict from 80 linking to a young domain", async () => {
  const t = await team("young-link-new", "new");
  const id = await email(t, "https://fresh-lure-two.com/x");
  await sendEmail(db, sendDeps, { emailId: id });
  await judge((await sampleOf(id))?.id ?? "", verdict(83), true);
  const [held] = await db.select().from(schema.teams).where(eq(schema.teams.id, t.teamId));
  expect(held?.suspensionReason).toBe("review");
  expect(mails.find((m) => m.kind === "monitor.team_held")?.text).toContain(
    "on mail linking to a new destination registered under 7 days ago",
  );
  expect(await sendEmail(db, sendDeps, { emailId: id })).toBe("parked");
});

it("judges a broadcast copy whose contact fields add a destination its HTML lacks", async () => {
  const t = await team("bcast-inject", "established");
  await db.insert(schema.contacts).values([
    {
      teamId: t.teamId,
      email: "a@example.com",
      properties: { link: "https://bcast-inject.dev/x" },
    },
    {
      teamId: t.teamId,
      email: "b@example.com",
      properties: { link: "https://injected-lure.com/x" },
    },
  ]);
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({
      teamId: t.teamId,
      from: "B <hi@bcast-inject.dev>",
      subject: "news",
      html: '<p><a href="{{{link}}}">Open</a></p>',
      status: "scheduled",
    })
    .returning({ id: schema.broadcasts.id });
  const broadcastDeps: BroadcastDeps = {
    keyring,
    unsubscribeSecretKey,
    unsubscribeBaseUrl: "https://app.millionsend.test",
    isCloud: false,
    enqueueEmailSends: async () => {},
    monitor,
    platformDomains: PLATFORM,
  };
  expect(await sendBroadcast(db, broadcastDeps, { broadcastId: broadcast?.id ?? "" })).toBe("sent");
  const copies = await db
    .select({ id: schema.emails.id, to: schema.emails.to })
    .from(schema.emails)
    .where(eq(schema.emails.broadcastId, broadcast?.id ?? ""))
    .orderBy(asc(schema.emails.createdAt));
  const outcome = new Map<string, string>();
  for (const copy of copies) {
    outcome.set(copy.to[0] ?? "", await sendEmail(db, sendDeps, { emailId: copy.id }));
  }
  expect(Object.fromEntries(outcome)).toEqual({
    "a@example.com": "sent",
    "b@example.com": "deferred",
  });
});

it("holds a team past new's broadcast for a new destination in its HTML, and parks it on 90", async () => {
  const t = await team("bcast-html", "established");
  await db.insert(schema.contacts).values([
    { teamId: t.teamId, email: "a@example.com" },
    { teamId: t.teamId, email: "b@example.com" },
  ]);
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({
      teamId: t.teamId,
      from: "B <hi@bcast-html.dev>",
      subject: "news",
      html: '<p><a href="https://html-lure.com/x">Open</a></p>',
      status: "scheduled",
    })
    .returning({ id: schema.broadcasts.id });
  const broadcastId = broadcast?.id ?? "";
  const broadcastDeps: BroadcastDeps = {
    keyring,
    unsubscribeSecretKey,
    unsubscribeBaseUrl: "https://app.millionsend.test",
    isCloud: false,
    enqueueEmailSends: async () => {},
    monitor,
    platformDomains: PLATFORM,
  };
  expect(await sendBroadcast(db, broadcastDeps, { broadcastId })).toBe("deferred");
  const [skeleton] = await db
    .select()
    .from(schema.monitorSamples)
    .where(eq(schema.monitorSamples.broadcastId, broadcastId));
  expect(skeleton).toMatchObject({ kind: "broadcast_skeleton", screening: true });
  expect(await judge(skeleton?.id ?? "", verdict(94))).toBe("judged");
  expect(fanOuts).toEqual([broadcastId]);
  expect(await sendBroadcast(db, broadcastDeps, { broadcastId })).toBe("sent");
  const copies = await db
    .select()
    .from(schema.emails)
    .where(eq(schema.emails.broadcastId, broadcastId));
  expect(copies.map((c) => [c.latestStatus, c.parkReason])).toEqual([
    ["queued_quota", "destination"],
    ["queued_quota", "destination"],
  ]);
});
