import { randomBytes } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import { createApi } from "@millionsend/api";
import {
  type AbuseJudge,
  EnvKeyring,
  generateApiKey,
  MONITOR_SETTING_DEFAULTS,
  type MonitorDeps,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { desc, eq } from "drizzle-orm";
import { Resend } from "resend";
import { afterAll, beforeAll, expect, it } from "vitest";
import { judgeSample } from "../src/handlers/abuse-judge.js";
import { drainQuotaParked } from "../src/handlers/cron.js";
import { type SendDeps, type SesSender, sendEmail } from "../src/handlers/send-email.js";

/**
 * Screening before SES, end to end: the official resend SDK sends through a
 * live MillionSend API, and the worker's own send, judge and drain handlers
 * move the mail as their queues would, with TypeSafe and SES faked. What the
 * judge holds back never reaches SES; what it clears does, once.
 */

const DAY = 86_400_000;
const LURE_FROM = "Microsoft 365 <security@m365-alerts.dev>";

let db: Db;
let closeDb: () => Promise<void>;
let server: ServerType;
let baseUrl: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
/** The email.send and abuse.judge queues, worked by hand in order. */
const sendJobs: string[] = [];
const judgeJobs: string[] = [];
const sesSends: string[] = [];
const mails: string[] = [];

const fakeSes: SesSender = {
  async sendRaw({ emailId }) {
    sesSends.push(emailId);
    return { messageId: `ses-${emailId}` };
  },
};
const monitor: MonitorDeps = {
  samplingKey: Buffer.alloc(32, 9),
  settings: async () => MONITOR_SETTING_DEFAULTS,
  enqueueJudge: async (sampleId) => void judgeJobs.push(sampleId),
};
const sendDeps: SendDeps = { keyring, ses: fakeSes, monitor };

/** TypeSafe's fake: every verdict at this score, phishing_credentials from 65. */
function typesafe(score: number): AbuseJudge {
  return {
    provider: "typesafe",
    model: "fake-model",
    judge: async () =>
      score >= 65
        ? {
            score,
            verdict: "abuse",
            categories: ["phishing_credentials"],
            reasons: ["impersonation"],
            impersonatedBrand: "Microsoft",
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
  };
}

/** Works the judge queue with this verdict; the judge queues the sends that waited on it. */
async function judgeAll(score: number, now?: Date): Promise<void> {
  while (judgeJobs.length > 0) {
    await judgeSample(
      db,
      {
        judge: typesafe(score),
        keyring,
        settings: async () => MONITOR_SETTING_DEFAULTS,
        mailer: { send: async (_to, m) => void mails.push(m.kind) },
        enqueueSend: async (emailId) => void sendJobs.push(emailId),
        ...(now ? { now: () => now } : {}),
      },
      { sampleId: judgeJobs.shift() as string },
    );
  }
}

/** Works the send queue: each job's outcome, by email. */
async function sendAll(): Promise<Record<string, string>> {
  const outcomes: Record<string, string> = {};
  while (sendJobs.length > 0) {
    const emailId = sendJobs.shift() as string;
    outcomes[emailId] = await sendEmail(db, sendDeps, { emailId });
  }
  return outcomes;
}

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  await db
    .insert(schema.user)
    .values({ id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) });
  const app = createApi({
    db,
    keyring,
    isCloud: true,
    enqueueEmailSend: async (emailId) => void sendJobs.push(emailId),
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.close();
  await closeDb();
});

/** A team with a verified domain registered `registeredDaysAgo` ago, and its SDK client. */
async function sender(slug: string, registeredDaysAgo: number, established = false) {
  const teamId = await createTeam(db, slug);
  await db.insert(schema.domains).values({
    teamId,
    name: `${slug}.dev`,
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
    registeredAt: new Date(Date.now() - registeredDaysAgo * DAY),
  });
  if (established) {
    await db.insert(schema.teamMonitor).values({
      teamId,
      sentTotal: 20_000,
      firstSendAt: new Date(Date.now() - 200 * DAY),
    });
  }
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "e2e",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  return { teamId, resend: new Resend(key.token, { baseUrl }) };
}

async function accepted(
  resend: Resend,
  email: { from: string; subject: string; html: string },
): Promise<string> {
  const { data, error } = await resend.emails.send({ ...email, to: ["reader@e2e.test"] });
  expect(error).toBeNull();
  if (!data) throw new Error("no data");
  return data.id;
}

const row = async (emailId: string) =>
  (await db.select().from(schema.emails).where(eq(schema.emails.id, emailId)))[0];
const team = async (teamId: string) =>
  (await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)))[0];
const sampleOf = async (emailId: string) =>
  (
    await db
      .select()
      .from(schema.monitorSamples)
      .where(eq(schema.monitorSamples.emailId, emailId))
      .orderBy(desc(schema.monitorSamples.createdAt))
  )[0];

let lure: Awaited<ReturnType<typeof sender>>;
let lureFirst: string;

it("holds a new team on a fresh domain at its first lure, which never reaches SES", async () => {
  lure = await sender("m365-alerts", 2);
  lureFirst = await accepted(lure.resend, {
    from: LURE_FROM,
    subject: "Your password expires today",
    html: '<p>Your Microsoft 365 password expires today.</p><p><a href="https://m365-verify.example/login">Keep my password</a></p>',
  });
  expect(await sendAll()).toEqual({ [lureFirst]: "deferred" });
  // Judged three minutes back: the short wait a phishing-type verdict brings
  // is over by the time the operator releases the team.
  await judgeAll(85, new Date(Date.now() - 3 * 60_000));
  expect(await team(lure.teamId)).toMatchObject({ suspensionReason: "review" });
  expect(mails).toContain("monitor.team_held");
  expect(await sendAll()).toEqual({ [lureFirst]: "parked" });
  expect(await row(lureFirst)).toMatchObject({
    latestStatus: "queued_quota",
    parkReason: "review",
  });
  expect(sesSends).toEqual([]);
});

it("sends a new team's legitimate first email once the judge clears it", async () => {
  const shop = await sender("livraria", 400);
  const id = await accepted(shop.resend, {
    from: "Livraria <pedidos@livraria.dev>",
    subject: "Seu pedido saiu para entrega",
    html: "<p>Olá! O pedido 1234 saiu para entrega e chega em até 3 dias úteis.</p>",
  });
  expect(await sendAll()).toEqual({ [id]: "deferred" });
  expect(sesSends).toEqual([]);
  await judgeAll(10);
  expect(await sendAll()).toEqual({ [id]: "sent" });
  expect(sesSends).toEqual([id]);
});

it("parks what a held team sends next, and sends both its parked emails once after reinstatement", async () => {
  const second = await accepted(lure.resend, {
    from: LURE_FROM,
    subject: "Following up",
    html: "<p>Following up on our earlier message about your account.</p>",
  });
  expect(await row(second)).toMatchObject({ latestStatus: "queued_quota", parkReason: "review" });
  expect(sendJobs).toEqual([]);

  // What the console's Release hold (teams.reinstate) writes to the team.
  await db
    .update(schema.teams)
    .set({ suspendedAt: null, suspensionReason: null, suspensionNote: null })
    .where(eq(schema.teams.id, lure.teamId));
  const drain = () =>
    drainQuotaParked(db, {
      isCloud: true,
      enqueueSends: async (batch) => void sendJobs.push(...batch.map((job) => job.emailId)),
    });
  await drain();
  // The first already has its verdict; the second, still from a team in its
  // first window, is judged before SES like any other.
  expect(await sendAll()).toEqual({ [lureFirst]: "sent", [second]: "deferred" });
  await judgeAll(10);
  expect(await sendAll()).toEqual({ [second]: "sent" });
  await drain();
  expect(await sendAll()).toEqual({});
  expect(sesSends.filter((id) => id === lureFirst || id === second).sort()).toEqual(
    [lureFirst, second].sort(),
  );
});

it("screens an established team's mail to a never-seen domain: parked on a 92, sent on a 20, then cleared", async () => {
  const agency = await sender("agencia", 900, true);
  const campaign = {
    from: "Agência <contato@agencia.dev>",
    subject: "Nova campanha no ar",
    html: '<p>A nova campanha está no ar: <a href="https://campanha-nova.example/oferta">ver a oferta</a></p>',
  };
  const before = sesSends.length;

  const first = await accepted(agency.resend, campaign);
  expect(await sendAll()).toEqual({ [first]: "deferred" });
  expect(await sampleOf(first)).toMatchObject({ kind: "destination", screening: true });
  await judgeAll(92);
  expect(await sendAll()).toEqual({ [first]: "parked" });
  expect(await row(first)).toMatchObject({ parkReason: "destination" });
  expect(mails).toContain("monitor.destination_parked");
  expect((await team(agency.teamId))?.suspendedAt).toBeNull();
  expect(sesSends.length).toBe(before);

  const second = await accepted(agency.resend, campaign);
  expect(await sendAll()).toEqual({ [second]: "deferred" });
  await judgeAll(20);
  expect(await sendAll()).toEqual({ [second]: "sent" });

  // Cleared: the next email to it goes straight out.
  const third = await accepted(agency.resend, campaign);
  expect(await sendAll()).toEqual({ [third]: "sent" });
  expect(sesSends.slice(before)).toEqual([second, third]);
});
