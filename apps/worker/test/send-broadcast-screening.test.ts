import { randomBytes } from "node:crypto";
import {
  type AbuseJudge,
  deriveUnsubscribeKey,
  EnvKeyring,
  type JudgeVerdict,
  MONITOR_SETTING_DEFAULTS,
  type MonitorDeps,
  SCREEN_RETRIES,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { judgeSample } from "../src/handlers/abuse-judge.js";
import { type BroadcastDeps, sendBroadcast } from "../src/handlers/send-broadcast.js";
import { type SendDeps, sendEmail } from "../src/handlers/send-email.js";

/**
 * A new team's broadcast before SES: no copy is written until its own HTML
 * has a verdict, the first rendered copy waits for its own, and a lure in
 * either pauses the team's broadcasts.
 */

let db: Db;
let close: () => Promise<void>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const DAY = 86_400_000;
let judgeQueue: { sampleId: string; screening: boolean }[];
let fanOuts: string[];
let resent: string[];
let mails: string[];
let sesCalls: string[];

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db
    .insert(schema.user)
    .values({ id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) });
});
afterAll(() => close());
beforeEach(() => {
  judgeQueue = [];
  fanOuts = [];
  resent = [];
  mails = [];
  sesCalls = [];
});

const monitor: MonitorDeps = {
  samplingKey: Buffer.alloc(32, 7),
  settings: async () => MONITOR_SETTING_DEFAULTS,
  enqueueJudge: async (sampleId, opts) =>
    void judgeQueue.push({ sampleId, screening: opts?.screening ?? false }),
};
const unsubscribeSecretKey = deriveUnsubscribeKey(randomBytes(32));
const broadcastDeps: BroadcastDeps = {
  keyring,
  unsubscribeSecretKey,
  unsubscribeBaseUrl: "https://app.example.com",
  isCloud: false,
  enqueueEmailSends: async () => {},
  monitor,
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
  unsubscribe: { secretKey: unsubscribeSecretKey, baseUrl: "https://app.example.com" },
};

const answer = (
  v: Pick<JudgeVerdict, "score" | "verdict" | "categories" | "reasons"> | Error,
): AbuseJudge => ({
  provider: "typesafe",
  model: "fake-model",
  judge: async () => {
    if (v instanceof Error) throw v;
    return { ...v, impersonatedBrand: null, language: "en" };
  },
});
const CLEAN = answer({ score: 4, verdict: "clean", categories: [], reasons: [] });
const LURE = answer({
  score: 86,
  verdict: "abuse",
  categories: ["brand_impersonation"],
  reasons: ["impersonation"],
});

const judge = (sampleId: string, judgeAnswer: AbuseJudge) =>
  judgeSample(
    db,
    {
      judge: judgeAnswer,
      keyring,
      settings: async () => MONITOR_SETTING_DEFAULTS,
      mailer: { send: async (_to, m) => void mails.push(m.kind) },
      enqueueSend: async (emailId) => void resent.push(emailId),
      enqueueBroadcast: async (broadcastId) => void fanOuts.push(broadcastId),
    },
    { sampleId },
  );

async function newTeamBroadcast(slug: string, registeredDaysAgo = 400) {
  const teamId = await createTeam(db, slug);
  await db.insert(schema.domains).values({
    teamId,
    name: `${slug}.dev`,
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
    registeredAt: new Date(Date.now() - registeredDaysAgo * DAY),
  });
  await db.insert(schema.contacts).values(
    ["a", "b", "c"].map((name) => ({
      teamId,
      email: `${name}@example.com`,
      properties: { link: `https://${name}.example` },
    })),
  );
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({
      teamId,
      from: `B <hi@${slug}.dev>`,
      subject: "news",
      html: "<p>Hi</p>",
      status: "scheduled",
    })
    .returning({ id: schema.broadcasts.id });
  return { teamId, broadcastId: broadcast?.id ?? "" };
}

const samples = (broadcastId: string) =>
  db
    .select()
    .from(schema.monitorSamples)
    .where(eq(schema.monitorSamples.broadcastId, broadcastId))
    .orderBy(asc(schema.monitorSamples.createdAt));
const rows = (broadcastId: string) =>
  db.select().from(schema.emails).where(eq(schema.emails.broadcastId, broadcastId));

it("writes no copy before the HTML's verdict, then holds the first copy for its own", async () => {
  const { broadcastId } = await newTeamBroadcast("bcast-clean");
  expect(await sendBroadcast(db, broadcastDeps, { broadcastId })).toBe("deferred");
  expect(await rows(broadcastId)).toEqual([]);
  const [skeleton] = await samples(broadcastId);
  expect(skeleton).toMatchObject({
    kind: "broadcast_skeleton",
    status: "pending",
    screening: true,
  });
  expect(judgeQueue).toEqual([{ sampleId: skeleton?.id, screening: true }]);

  expect(await judge(skeleton?.id ?? "", CLEAN)).toBe("judged");
  expect(fanOuts).toEqual([broadcastId]);
  expect(await sendBroadcast(db, broadcastDeps, { broadcastId })).toBe("sent");
  const written = await rows(broadcastId);
  expect(written).toHaveLength(3);
  const screened = (await samples(broadcastId)).filter(
    (s) => s.kind === "broadcast_copy" && s.screening,
  );
  expect(screened).toHaveLength(1);
  const first = screened[0]?.emailId ?? "";
  for (const row of written) {
    expect(await sendEmail(db, sendDeps, { emailId: row.id })).toBe(
      row.id === first ? "deferred" : "sent",
    );
  }
  expect(await judge(screened[0]?.id ?? "", CLEAN)).toBe("judged");
  expect(resent).toEqual([first]);
  expect(await sendEmail(db, sendDeps, { emailId: first })).toBe("sent");
  expect(sesCalls).toHaveLength(3);
});

it("pauses the team's broadcasts on one phishing-type verdict from 80 on the HTML", async () => {
  const { teamId, broadcastId } = await newTeamBroadcast("bcast-lure");
  await sendBroadcast(db, broadcastDeps, { broadcastId });
  const [skeleton] = await samples(broadcastId);
  expect(await judge(skeleton?.id ?? "", LURE)).toBe("judged");
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  expect(team?.broadcastsPausedByOperatorAt).not.toBeNull();
  // An aged domain and one verdict under 90: paused, not held.
  expect(team?.suspendedAt).toBeNull();
  expect(mails).toContain("monitor.broadcasts_paused");
  expect(await sendBroadcast(db, broadcastDeps, { broadcastId })).toBe("deferred");
  expect(await rows(broadcastId)).toEqual([]);
});

it("pauses the rest when the first rendered copy carries the lure", async () => {
  const { teamId, broadcastId } = await newTeamBroadcast("bcast-copy-lure");
  await sendBroadcast(db, broadcastDeps, { broadcastId });
  await judge((await samples(broadcastId))[0]?.id ?? "", CLEAN);
  expect(await sendBroadcast(db, broadcastDeps, { broadcastId })).toBe("sent");
  const first = (await samples(broadcastId)).find(
    (s) => s.kind === "broadcast_copy" && s.screening,
  );
  expect(await judge(first?.id ?? "", LURE)).toBe("judged");
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  expect(team?.broadcastsPausedByOperatorAt).not.toBeNull();
  for (const row of await rows(broadcastId)) {
    expect(await sendEmail(db, sendDeps, { emailId: row.id })).toBe("parked");
  }
  expect(sesCalls).toEqual([]);
});

it("parks every copy for the operator when the judge keeps failing on a young domain", async () => {
  const { broadcastId } = await newTeamBroadcast("bcast-outage", 2);
  const down = answer(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
  expect(await sendBroadcast(db, broadcastDeps, { broadcastId })).toBe("deferred");
  for (let retry = 0; retry <= SCREEN_RETRIES; retry++) {
    const [skeleton] = await samples(broadcastId);
    expect(await judge(skeleton?.id ?? "", down)).toBe("unjudged");
    expect(fanOuts.at(-1)).toBe(broadcastId);
    const outcome = await sendBroadcast(db, broadcastDeps, { broadcastId });
    expect(outcome).toBe(retry < SCREEN_RETRIES ? "deferred" : "sent");
  }
  const written = await rows(broadcastId);
  expect(written).toHaveLength(3);
  for (const row of written) {
    expect(row).toMatchObject({ latestStatus: "queued_quota", parkReason: "screening" });
  }
  // The walk ended, the send did not: the operator decides.
  const [broadcast] = await db
    .select({ status: schema.broadcasts.status })
    .from(schema.broadcasts)
    .where(and(eq(schema.broadcasts.id, broadcastId)));
  expect(broadcast?.status).toBe("sending");
});
