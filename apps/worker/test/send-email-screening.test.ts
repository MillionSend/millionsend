import { randomBytes, randomUUID } from "node:crypto";
import {
  type AbuseJudge,
  cancelWaitingEmails,
  EnvKeyring,
  encryptEmailBody,
  type JudgeVerdict,
  MONITOR_SETTING_DEFAULTS,
  type MonitorDeps,
  releaseWaitingEmails,
  SCREEN_RETRIES,
  suspendTeam,
  utcDay,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { judgeSample } from "../src/handlers/abuse-judge.js";
import { drainQuotaParked } from "../src/handlers/cron.js";
import { runMonitorHealth } from "../src/handlers/monitor-health.js";
import { type SendDeps, sendEmail } from "../src/handlers/send-email.js";

/**
 * Screening before SES, through sendQueued with the judge faked: what waits,
 * what the verdict does to it, and what a failing judge leaves behind.
 */

let db: Db;
let close: () => Promise<void>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const DAY = 86_400_000;

let sesCalls: string[];
let judgeQueue: { sampleId: string; screening: boolean; startAfter?: Date | undefined }[];
let resent: string[];
let rescheduled: { emailId: string; at: Date }[];
let blocks: string[];
let mails: { kind: string; text: string }[];

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
  blocks = [];
  mails = [];
});

const monitor: MonitorDeps = {
  samplingKey: Buffer.alloc(32, 7),
  settings: async () => MONITOR_SETTING_DEFAULTS,
  enqueueJudge: async (sampleId, opts) =>
    void judgeQueue.push({
      sampleId,
      screening: opts?.screening ?? false,
      startAfter: opts?.startAfter,
    }),
};

const sendDeps = (): SendDeps => ({
  keyring,
  ses: {
    sendRaw: async ({ emailId }) => {
      sesCalls.push(emailId);
      return { messageId: `mid-${emailId}` };
    },
  },
  monitor,
  reschedule: async (emailId, at) => void rescheduled.push({ emailId, at }),
});

const verdictOf = (
  score: number,
  phishing = true,
): Pick<JudgeVerdict, "score" | "verdict" | "categories" | "reasons"> =>
  phishing
    ? { score, verdict: "abuse", categories: ["phishing_credentials"], reasons: ["impersonation"] }
    : { score, verdict: "clean", categories: [], reasons: [] };

function fakeJudge(
  answers: (Pick<JudgeVerdict, "score" | "verdict" | "categories" | "reasons"> | Error)[],
): AbuseJudge {
  return {
    provider: "typesafe",
    model: "fake-model",
    judge: async (block) => {
      blocks.push(block);
      const next = answers.length > 1 ? answers.shift() : answers[0];
      if (!next || next instanceof Error) throw next ?? new Error("no answer");
      return { ...next, impersonatedBrand: null, language: "en" };
    },
  };
}

const judge = (sampleId: string, answer: AbuseJudge, now?: Date) =>
  judgeSample(
    db,
    {
      judge: answer,
      keyring,
      settings: async () => MONITOR_SETTING_DEFAULTS,
      mailer: { send: async (_to, m) => void mails.push({ kind: m.kind, text: m.text }) },
      enqueueSend: async (emailId) => void resent.push(emailId),
      ...(now ? { now: () => now } : {}),
    },
    { sampleId },
  );

/** A new team with one verified sending domain registered `registeredDaysAgo` ago (null: unknown). */
async function team(slug: string, registeredDaysAgo: number | null) {
  const teamId = await createTeam(db, slug);
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: `${slug}.dev`,
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
      registeredAt:
        registeredDaysAgo === null ? null : new Date(Date.now() - registeredDaysAgo * DAY),
    })
    .returning({ id: schema.domains.id });
  return { teamId, domainId: domain?.id ?? "", slug };
}

async function email(t: { teamId: string; domainId: string; slug: string }): Promise<string> {
  const id = randomUUID();
  const body = await encryptEmailBody(
    // Links to its own domain only: no destination new to the team.
    { html: `<p>Your account <a href="https://${t.slug}.dev/login">verify</a></p>`, text: null },
    keyring,
    { teamId: t.teamId, rowId: id },
  );
  await db.insert(schema.emails).values({
    id,
    teamId: t.teamId,
    domainId: t.domainId,
    from: `Support <hi@${t.slug}.dev>`,
    to: ["r@example.org"],
    subject: "Your account",
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
const standing = async (teamId: string) =>
  (await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)))[0];

it("holds a first-window email for its verdict, sends it once judged, and never draws it again", async () => {
  const t = await team("clean-first", 400);
  const id = await email(t);
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("deferred");
  expect(sesCalls).toEqual([]);
  const sample = await sampleOf(id);
  expect(sample).toMatchObject({ kind: "first_sends", status: "pending", screening: true });
  expect(judgeQueue).toEqual([{ sampleId: sample?.id, screening: true, startAfter: undefined }]);
  // A second run of the job before the verdict waits again, adding nothing.
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("deferred");

  expect(await judge(sample?.id ?? "", fakeJudge([verdictOf(5, false)]))).toBe("judged");
  // The judge saw a day-0 team, not one of unknown age.
  expect(blocks[0]).toContain("Team age (days): 0");
  expect(resent).toEqual([id]);
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("sent");
  expect(sesCalls).toEqual([id]);
  const samples = await db
    .select()
    .from(schema.monitorSamples)
    .where(eq(schema.monitorSamples.emailId, id));
  expect(samples).toHaveLength(1);
  const [counted] = await db
    .select()
    .from(schema.teamMonitor)
    .where(eq(schema.teamMonitor.teamId, t.teamId));
  expect(counted?.sentTotal).toBe(1);
});

it("holds the team on one phishing verdict from 80 when its sending domain is young or of unknown age", async () => {
  for (const [slug, age] of [
    ["young-domain", 2],
    ["unknown-age", null],
  ] as const) {
    const t = await team(slug, age);
    const id = await email(t);
    expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("deferred");
    const sample = await sampleOf(id);
    expect(await judge(sample?.id ?? "", fakeJudge([verdictOf(85)]))).toBe("judged");
    expect(await standing(t.teamId)).toMatchObject({ suspensionReason: "review" });
    expect(mails.map((m) => m.kind)).toContain("monitor.team_held");
    expect(mails.find((m) => m.kind === "monitor.team_held")?.text).toContain(
      "while the team's sending domain was under 7 days old, or of unknown age",
    );
    // Queued again, the send meets the hold: parked, never at SES.
    expect(resent).toContain(id);
    expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("parked");
    expect(await row(id)).toMatchObject({ latestStatus: "queued_quota", parkReason: "review" });
    mails = [];
  }
  expect(sesCalls).toEqual([]);
});

it("lets a phishing verdict under 90 from an aged domain wait 2 minutes, then sends it, or parks it once the team is held", async () => {
  const t = await team("aged-lure", 400);
  const first = await email(t);
  expect(await sendEmail(db, sendDeps(), { emailId: first })).toBe("deferred");
  const judgedAt = new Date();
  expect(await judge((await sampleOf(first))?.id ?? "", fakeJudge([verdictOf(85)]), judgedAt)).toBe(
    "judged",
  );
  expect((await standing(t.teamId))?.suspendedAt).toBeNull();
  expect(await sendEmail(db, sendDeps(), { emailId: first })).toBe("deferred");
  expect(rescheduled).toEqual([{ emailId: first, at: new Date(judgedAt.getTime() + 2 * 60_000) }]);
  // Two minutes on, nothing held the team: it goes out.
  await db
    .update(schema.monitorSamples)
    .set({ judgedAt: new Date(Date.now() - 3 * 60_000) })
    .where(eq(schema.monitorSamples.emailId, first));
  expect(await sendEmail(db, sendDeps(), { emailId: first })).toBe("sent");

  const second = await email(t);
  await sendEmail(db, sendDeps(), { emailId: second });
  await judge((await sampleOf(second))?.id ?? "", fakeJudge([verdictOf(84)]));
  expect(await sendEmail(db, sendDeps(), { emailId: second })).toBe("deferred");
  // The burst's later verdicts held the team meanwhile.
  await suspendTeam(db, { teamId: t.teamId, reason: "review", ifNotSuspended: true });
  await db
    .update(schema.monitorSamples)
    .set({ judgedAt: new Date(Date.now() - 3 * 60_000) })
    .where(eq(schema.monitorSamples.emailId, second));
  expect(await sendEmail(db, sendDeps(), { emailId: second })).toBe("parked");
  expect(sesCalls).toEqual([first]);
});

it("retries a failing judge every 2 minutes for a young domain, then parks the email and tells the operator", async () => {
  const t = await team("outage-young", 1);
  const id = await email(t);
  const down = fakeJudge([Object.assign(new Error("timed out"), { name: "TimeoutError" })]);
  await sendEmail(db, sendDeps(), { emailId: id });
  for (let retry = 1; retry <= SCREEN_RETRIES; retry++) {
    const sample = await sampleOf(id);
    expect(await judge(sample?.id ?? "", down)).toBe("unjudged");
    expect(resent.at(-1)).toBe(id);
    judgeQueue = [];
    const before = Date.now();
    expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("deferred");
    expect(await sampleOf(id)).toMatchObject({ status: "pending", screenRetries: retry });
    expect(judgeQueue).toHaveLength(1);
    expect(judgeQueue[0]?.screening).toBe(true);
    expect(judgeQueue[0]?.startAfter?.getTime()).toBeGreaterThanOrEqual(before + 2 * 60_000);
  }
  // Each screened call met its timeout twice: the call and its one retry.
  expect(blocks).toHaveLength(2 * SCREEN_RETRIES);
  expect(await judge((await sampleOf(id))?.id ?? "", down)).toBe("unjudged");
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("parked");
  expect(await row(id)).toMatchObject({ latestStatus: "queued_quota", parkReason: "screening" });
  expect(sesCalls).toEqual([]);

  // The drain leaves it to the operator.
  const drained: string[] = [];
  await drainQuotaParked(db, {
    isCloud: true,
    enqueueSends: async (batch) => void drained.push(...batch.map((j) => j.emailId)),
  });
  expect(drained).not.toContain(id);

  // The judge-health notice says so, below its sample floor.
  const health: { kind: string; text: string }[] = [];
  const result = await runMonitorHealth(db, {
    judge: { provider: "typesafe", model: "fake-model" },
    mailer: { send: async (_to, m) => void health.push({ kind: m.kind, text: m.text }) },
    state: { degradedMailedAt: null },
  });
  expect(result.degraded).toBe(true);
  expect(health).toMatchObject([{ kind: "monitor.degraded" }]);
  expect(health[0]?.text).toContain("where 1 do now");

  // Released from the review list, it goes out without being screened again.
  expect(await releaseWaitingEmails(db, { teamId: t.teamId, holdLine: 80 })).toMatchObject({
    parked: 1,
  });
  const released: string[] = [];
  await drainQuotaParked(db, {
    isCloud: true,
    enqueueSends: async (batch) => void released.push(...batch.map((j) => j.emailId)),
  });
  expect(released).toContain(id);
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("sent");
  expect(sesCalls).toEqual([id]);
});

it("sends an aged domain's email when the judge fails, and judges it afterwards", async () => {
  const t = await team("outage-aged", 400);
  const id = await email(t);
  await sendEmail(db, sendDeps(), { emailId: id });
  const sample = await sampleOf(id);
  expect(await judge(sample?.id ?? "", fakeJudge([new Error("upstream down")]))).toBe("unjudged");
  judgeQueue = [];
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("sent");
  // The same sample is judged afterwards, as unscreened mail is; no second one.
  expect(await sampleOf(id)).toMatchObject({ id: sample?.id, status: "pending", screening: false });
  expect(judgeQueue).toEqual([{ sampleId: sample?.id, screening: false, startAfter: undefined }]);
});

it("never screens a quiet old team as new, and takes its history from the usage counters", async () => {
  const t = await team("quiet-old", 900);
  await db.insert(schema.usageCounters).values({
    teamId: t.teamId,
    day: utcDay(new Date(Date.now() - 200 * DAY)),
    sent: 5000,
  });
  const id = await email(t);
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("sent");
  const [history] = await db
    .select()
    .from(schema.teamMonitor)
    .where(eq(schema.teamMonitor.teamId, t.teamId));
  expect(history?.sentTotal).toBe(5001);
  // A sample, if the tier's rate drew one, came after the send, unscreened.
  expect((await sampleOf(id))?.screening ?? false).toBe(false);
});

it("cancels waiting mail from the review list: it never goes out", async () => {
  const t = await team("cancel-waiting", 400);
  const id = await email(t);
  await sendEmail(db, sendDeps(), { emailId: id });
  await judge((await sampleOf(id))?.id ?? "", fakeJudge([verdictOf(85)]));
  expect(await cancelWaitingEmails(db, { teamId: t.teamId, emailIds: [id], holdLine: 80 })).toBe(1);
  expect(await row(id)).toMatchObject({ latestStatus: "canceled" });
  expect(await sendEmail(db, sendDeps(), { emailId: id })).toBe("skipped");
  expect(sesCalls).toEqual([]);
});
