import { randomBytes, randomUUID } from "node:crypto";
import {
  type AbuseJudge,
  DESTINATION_SCREENS_PER_DAY,
  EnvKeyring,
  encryptEmailBody,
  MONITOR_SETTING_DEFAULTS,
  type MonitorSettings,
  NOVEL_DESTINATIONS_MAX,
  nextUtcDayStart,
  releaseWaitingEmails,
  SCREEN_OUTSTANDING_MAX,
  sealAttachments,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { judgeSample } from "../src/handlers/abuse-judge.js";
import { drainQuotaParked } from "../src/handlers/cron.js";
import { type SendDeps, sendEmail } from "../src/handlers/send-email.js";

/**
 * Where screening could fail open, through the send and judge handlers:
 * what a cap, a clearance, a flood of destinations, an unknown link age or
 * a release can no longer let through.
 */

let db: Db;
let close: () => Promise<void>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const DAY = 86_400_000;

let sesCalls: string[];
let judgeQueue: { sampleId: string; screening: boolean }[];
let resent: string[];
let rescheduled: { emailId: string; at: Date }[];
let mails: string[];

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db
    .insert(schema.user)
    .values({ id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) });
});
afterAll(() => close());
beforeEach(() => {
  sesCalls = [];
  judgeQueue = [];
  resent = [];
  rescheduled = [];
  mails = [];
});

const sendDeps = (settings: Partial<MonitorSettings> = {}): SendDeps => ({
  keyring,
  ses: {
    sendRaw: async ({ emailId }) => {
      sesCalls.push(emailId);
      return { messageId: `mid-${emailId}` };
    },
  },
  monitor: {
    samplingKey: Buffer.alloc(32, 7),
    settings: async () => ({ ...MONITOR_SETTING_DEFAULTS, ...settings }),
    enqueueJudge: async (sampleId, opts) =>
      void judgeQueue.push({ sampleId, screening: opts?.screening ?? false }),
  },
  reschedule: async (emailId, at) => void rescheduled.push({ emailId, at }),
});

const verdict = (score: number): AbuseJudge => ({
  provider: "typesafe",
  model: "fake-model",
  judge: async () =>
    score >= 65
      ? {
          score,
          verdict: "abuse",
          categories: ["phishing_credentials"],
          reasons: ["impersonation"],
          impersonatedBrand: null,
          language: "en",
        }
      : {
          score,
          verdict: "clean",
          categories: [],
          reasons: [],
          impersonatedBrand: null,
          language: "en",
        },
});

/** The judge's read of a product's own reset mail: a credential link off the verified domains, no brand claimed. */
const credentialOnly = (score: number): AbuseJudge => ({
  provider: "typesafe",
  model: "fake-model",
  judge: async () => ({
    score,
    verdict: "abuse" as const,
    categories: ["phishing_credentials"],
    reasons: ["off_domain_lure", "harvests_secrets"],
    impersonatedBrand: null,
    language: "en",
  }),
});

const judge = (
  sampleId: string,
  answer: AbuseJudge,
  linkYoung: boolean | null = false,
  now?: Date,
) =>
  judgeSample(
    db,
    {
      judge: answer,
      keyring,
      settings: async () => MONITOR_SETTING_DEFAULTS,
      mailer: { send: async (_to, m) => void mails.push(m.kind) },
      enqueueSend: async (emailId) => void resent.push(emailId),
      linkDomainYoung: async () => linkYoung,
      ...(now ? { now: () => now } : {}),
    },
    { sampleId },
  );

/** A team of a tier: new in its first window, new past it, or established. */
async function team(slug: string, tier: "first" | "ramp" | "established") {
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
  if (tier !== "first") {
    await db.insert(schema.teamMonitor).values({
      teamId,
      sentTotal: tier === "ramp" ? 2_000 : 20_000,
      firstSendAt: new Date(Date.now() - (tier === "ramp" ? 4 : 200) * DAY),
    });
  }
  return { teamId, domainId: domain?.id ?? "", slug };
}

async function email(
  t: { teamId: string; domainId: string; slug: string },
  html: string,
  extra: Partial<typeof schema.emails.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();
  const body = await encryptEmailBody({ html, text: null }, keyring, {
    teamId: t.teamId,
    rowId: id,
  });
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
    ...extra,
  });
  return id;
}

const link = (domain: string) => `<p>Open <a href="https://${domain}/x">this</a></p>`;
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
const clearance = async (teamId: string, domain: string) =>
  (
    await db
      .select()
      .from(schema.teamDestinations)
      .where(
        and(eq(schema.teamDestinations.teamId, teamId), eq(schema.teamDestinations.domain, domain)),
      )
  )[0];

it("keeps a first-window email waiting for its verdict past the team's daily cap", async () => {
  const t = await team("cap-first", "first");
  const id = await email(t, "<p>Your order shipped.</p>");
  const capped = { teamDailyCap: 0, instanceDailyCap: 0 };
  expect(await sendEmail(db, sendDeps(capped), { emailId: id })).toBe("deferred");
  expect(await sampleOf(id)).toMatchObject({ screening: true, status: "pending" });
  expect(sesCalls).toEqual([]);
});

it("takes a platform name's clearance back unless an operator gave it, and then only for a lure that claims a brand", async () => {
  const t = await team("platform-probation", "established");
  // A name only a verdict cleared: a credential-only verdict in its probation revokes it, as any.
  const laundered = await email(t, link("laundered.vercel.app"));
  expect(await sendEmail(db, sendDeps(), { emailId: laundered })).toBe("deferred");
  await judge((await sampleOf(laundered))?.id ?? "", verdict(30));
  const lure = await email(t, link("laundered.vercel.app"));
  expect(await sendEmail(db, sendDeps(), { emailId: lure })).toBe("sent");
  await judge((await sampleOf(lure))?.id ?? "", credentialOnly(93));
  expect((await clearance(t.teamId, "laundered.vercel.app"))?.revokedAt).not.toBeNull();
  expect(mails).toContain("monitor.destination_revoked");
  mails.length = 0;
  // A name an operator released mail to: a credential-only verdict takes nothing back; a branded lure does.
  const reset = await email(t, link("my-app.vercel.app"));
  expect(await sendEmail(db, sendDeps(), { emailId: reset })).toBe("deferred");
  await judge((await sampleOf(reset))?.id ?? "", credentialOnly(93));
  expect(await sendEmail(db, sendDeps(), { emailId: reset })).toBe("parked");
  expect(
    await releaseWaitingEmails(db, { teamId: t.teamId, emailIds: [reset], holdLine: 80 }),
  ).toEqual({ parked: 1, queued: [] });
  expect(await clearance(t.teamId, "my-app.vercel.app")).toMatchObject({ revokedAt: null });
  expect((await clearance(t.teamId, "my-app.vercel.app"))?.operatorClearedAt).not.toBeNull();
  const again = await email(t, link("my-app.vercel.app"));
  expect(await sendEmail(db, sendDeps(), { emailId: again })).toBe("sent");
  await judge((await sampleOf(again))?.id ?? "", credentialOnly(85));
  expect(await clearance(t.teamId, "my-app.vercel.app")).toMatchObject({ revokedAt: null });
  expect(mails).not.toContain("monitor.destination_revoked");
  const branded = await email(t, link("my-app.vercel.app"));
  expect(await sendEmail(db, sendDeps(), { emailId: branded })).toBe("sent");
  await judge((await sampleOf(branded))?.id ?? "", verdict(85));
  // The operator heard of a revoke today already; the clearance still goes.
  expect((await clearance(t.teamId, "my-app.vercel.app"))?.revokedAt).not.toBeNull();
});

it("takes a destination's clearance back when mail to it is read as phishing after it went out", async () => {
  const t = await team("clear-switch", "established");
  // A 75 is no clearance: the next email to it is screened again.
  const middling = await email(t, link("middling.example"));
  await sendEmail(db, sendDeps(), { emailId: middling });
  await judge((await sampleOf(middling))?.id ?? "", {
    ...verdict(75),
    judge: async () => ({
      score: 75,
      verdict: "abuse",
      categories: ["spam"],
      reasons: [],
      impersonatedBrand: null,
      language: "en",
    }),
  });
  expect(await clearance(t.teamId, "middling.example")).toBeUndefined();

  const first = await email(t, link("agency-client.example"));
  expect(await sendEmail(db, sendDeps(), { emailId: first })).toBe("deferred");
  await judge((await sampleOf(first))?.id ?? "", verdict(30));
  expect(await clearance(t.teamId, "agency-client.example")).toMatchObject({ revokedAt: null });
  expect(await sendEmail(db, sendDeps(), { emailId: first })).toBe("sent");

  // In its probation the switch goes out, and is always judged after.
  const lure = await email(t, link("agency-client.example"));
  expect(await sendEmail(db, sendDeps(), { emailId: lure })).toBe("sent");
  const after = await sampleOf(lure);
  expect(after).toMatchObject({ kind: "destination", screening: false, status: "pending" });
  await judge(after?.id ?? "", verdict(85));
  expect((await clearance(t.teamId, "agency-client.example"))?.revokedAt).not.toBeNull();
  expect(mails).toContain("monitor.destination_revoked");

  // Mail to it is screened before SES again, and parks; the team is never held.
  const next = await email(t, link("agency-client.example"));
  expect(await sendEmail(db, sendDeps(), { emailId: next })).toBe("deferred");
  await judge((await sampleOf(next))?.id ?? "", verdict(92));
  expect(await sendEmail(db, sendDeps(), { emailId: next })).toBe("parked");
  expect(await row(next)).toMatchObject({ parkReason: "destination" });
  const [standing] = await db
    .select({ suspendedAt: schema.teams.suspendedAt })
    .from(schema.teams)
    .where(eq(schema.teams.id, t.teamId));
  expect(standing?.suspendedAt).toBeNull();
});

it(`parks mail with more than ${NOVEL_DESTINATIONS_MAX} new destinations for the operator, unjudged`, async () => {
  const t = await team("many-links", "established");
  const html = Array.from({ length: NOVEL_DESTINATIONS_MAX + 1 }, (_, i) =>
    link(`spread-${i}.example`),
  ).join("");
  const id = await email(t, html);
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("parked");
  expect(await row(id)).toMatchObject({ latestStatus: "queued_quota", parkReason: "destination" });
  expect(await sampleOf(id)).toBeUndefined();
});

it("holds mail with a new destination past the team's daily budget until the next UTC day", async () => {
  const t = await team("budget", "established");
  await db.insert(schema.monitorSamples).values(
    Array.from({ length: DESTINATION_SCREENS_PER_DAY }, () => ({
      teamId: t.teamId,
      kind: "destination" as const,
      screening: true,
      status: "judged" as const,
    })),
  );
  const id = await email(t, link("over-budget.example"));
  const now = Date.now();
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("deferred");
  expect(rescheduled).toEqual([{ emailId: id, at: nextUtcDayStart(now) }]);
  expect(await sampleOf(id)).toBeUndefined();
  expect(sesCalls).toEqual([]);
});

it(`makes a team's next screening wait its turn behind ${SCREEN_OUTSTANDING_MAX} waiting on the judge`, async () => {
  const t = await team("outstanding", "first");
  await db.insert(schema.monitorSamples).values(
    Array.from({ length: SCREEN_OUTSTANDING_MAX }, () => ({
      teamId: t.teamId,
      kind: "first_sends" as const,
      screening: true,
    })),
  );
  const id = await email(t, "<p>Hello</p>");
  const before = Date.now();
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("deferred");
  expect(rescheduled[0]?.at.getTime()).toBeGreaterThanOrEqual(before + 2 * 60_000);
  expect(await sampleOf(id)).toBeUndefined();
});

it("parks a team past new's lure when its new link domain's age is not known, and makes a new team's wait", async () => {
  const known = await team("age-unknown-old", "established");
  const parked = await email(known, link("age-hidden.example"));
  await sendEmail(db, sendDeps(), { emailId: parked });
  await judge((await sampleOf(parked))?.id ?? "", verdict(82), null);
  expect(await sendEmail(db, sendDeps(), { emailId: parked })).toBe("parked");
  expect(await row(parked)).toMatchObject({ parkReason: "destination" });

  const fresh = await team("age-unknown-new", "ramp");
  const waits = await email(fresh, link("age-hidden-2.example"));
  await sendEmail(db, sendDeps(), { emailId: waits });
  const judgedAt = new Date();
  await judge((await sampleOf(waits))?.id ?? "", verdict(82), null, judgedAt);
  expect(await sendEmail(db, sendDeps(), { emailId: waits })).toBe("deferred");
  expect(rescheduled).toEqual([{ emailId: waits, at: new Date(judgedAt.getTime() + 2 * 60_000) }]);
});

it("makes a new team's broadcast copy wait out a phishing-type verdict", async () => {
  const t = await team("copy-wait", "first");
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({ teamId: t.teamId, from: "B <hi@copy-wait.dev>", subject: "s", html: "<p>Hi</p>" })
    .returning({ id: schema.broadcasts.id });
  const id = await email(t, "<p>Hi</p>", { broadcastId: broadcast?.id ?? null });
  const judgedAt = new Date();
  await db.insert(schema.monitorSamples).values({
    teamId: t.teamId,
    emailId: id,
    broadcastId: broadcast?.id ?? null,
    kind: "broadcast_copy",
    screening: true,
    status: "judged",
    score: 85,
    verdict: "abuse",
    categories: ["phishing_credentials"],
    reasons: [],
    judgedAt,
  });
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("deferred");
  expect(rescheduled).toEqual([{ emailId: id, at: new Date(judgedAt.getTime() + 2 * 60_000) }]);
});

it("judges released mail after it is sent when its sample never answered", async () => {
  const t = await team("release-unjudged", "first");
  const page = {
    filename: "fatura.html",
    content: Buffer.from("<p>Fatura</p>").toString("base64"),
    contentType: "text/html",
  };
  const id = await email(t, "<p>Segue a fatura.</p>");
  await db
    .update(schema.emails)
    .set({ attachments: await sealAttachments([page], keyring, { teamId: t.teamId, rowId: id }) })
    .where(eq(schema.emails.id, id));
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("parked");
  const sample = await sampleOf(id);
  expect(sample).toMatchObject({ screening: true, status: "pending" });
  await releaseWaitingEmails(db, { teamId: t.teamId, emailIds: [id], holdLine: 80 });
  const drained: string[] = [];
  await drainQuotaParked(db, {
    isCloud: true,
    enqueueSends: async (batch) => void drained.push(...batch.map((job) => job.emailId)),
  });
  expect(drained).toContain(id);
  judgeQueue = [];
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("sent");
  expect(await sampleOf(id)).toMatchObject({ id: sample?.id, screening: false, status: "pending" });
  expect(judgeQueue).toEqual([{ sampleId: sample?.id, screening: false }]);
});
