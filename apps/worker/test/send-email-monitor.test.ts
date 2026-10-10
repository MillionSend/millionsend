import { randomBytes } from "node:crypto";
import {
  EnvKeyring,
  encryptEmailBody,
  MONITOR_SETTING_DEFAULTS,
  type MonitorDeps,
  SYSTEM_MAIL_TAG,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type SendDeps, type SesSender, sendEmail } from "../src/handlers/send-email.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let domainId: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const ses: SesSender = { sendRaw: async () => ({ messageId: `mid-${Math.random()}` }) };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "monitored");
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: "acme.dev",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
    })
    .returning({ id: schema.domains.id });
  domainId = domain?.id ?? "";
});
afterAll(() => close());

async function insertEmail(over: Partial<typeof schema.emails.$inferInsert> = {}): Promise<string> {
  const encrypted = await encryptEmailBody({ html: "<p>hello</p>", text: "hello" }, keyring);
  const [row] = await db
    .insert(schema.emails)
    .values({
      teamId,
      domainId,
      from: "Acme <a@acme.dev>",
      to: ["r@example.com"],
      subject: "hi",
      latestStatus: "queued",
      bodyCiphertext: encrypted.ciphertext,
      bodyIv: encrypted.iv,
      bodyWrappedDek: encrypted.wrappedDek,
      bodyKeyVersion: encrypted.keyVersion,
      ...over,
    })
    .returning({ id: schema.emails.id });
  return row?.id ?? "";
}

const samplesFor = (emailId: string) =>
  db.select().from(schema.monitorSamples).where(eq(schema.monitorSamples.emailId, emailId));

it("draws an accepted send into a pending sample and queues the judge", async () => {
  const queued: string[] = [];
  const monitor: MonitorDeps = {
    samplingKey: Buffer.alloc(32, 7),
    settings: async () => MONITOR_SETTING_DEFAULTS,
    enqueueJudge: async (id) => void queued.push(id),
  };
  const emailId = await insertEmail();
  expect(await sendEmail(db, { keyring, ses, monitor }, { emailId })).toBe("sent");
  const samples = await samplesFor(emailId);
  expect(samples).toMatchObject([{ teamId, kind: "first_sends", status: "pending" }]);
  expect(queued).toEqual([samples[0]?.id]);
  expect(await db.select().from(schema.teamMonitor)).toMatchObject([{ teamId, sentTotal: 1 }]);
});

it("keeps the send's outcome when the draw throws, and draws nothing without the dep or for account mail", async () => {
  const broken: MonitorDeps = {
    samplingKey: Buffer.alloc(32, 7),
    settings: async () => {
      throw new Error("settings down");
    },
    enqueueJudge: async () => {},
  };
  const emailId = await insertEmail();
  expect(await sendEmail(db, { keyring, ses, monitor: broken }, { emailId })).toBe("sent");
  expect(await samplesFor(emailId)).toEqual([]);
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
  expect(row?.latestStatus).toBe("sent");

  const plain = await insertEmail();
  const deps: SendDeps = { keyring, ses };
  expect(await sendEmail(db, deps, { emailId: plain })).toBe("sent");
  expect(await samplesFor(plain)).toEqual([]);

  const queued: string[] = [];
  const monitor: MonitorDeps = {
    samplingKey: Buffer.alloc(32, 7),
    settings: async () => MONITOR_SETTING_DEFAULTS,
    enqueueJudge: async (id) => void queued.push(id),
  };
  const system = await insertEmail({ tags: { [SYSTEM_MAIL_TAG]: "welcome" } });
  expect(await sendEmail(db, { keyring, ses, monitor }, { emailId: system })).toBe("sent");
  expect(await samplesFor(system)).toEqual([]);
  expect(queued).toEqual([]);
});

it("never draws the fixed onboarding email, nor counts it as the team's first send", async () => {
  const onboardingEmailFrom = "MillionSend <hello@ms.example>";
  const fresh = await createTeam(db, "onboarding-only");
  const queued: string[] = [];
  const monitor: MonitorDeps = {
    samplingKey: Buffer.alloc(32, 7),
    settings: async () => MONITOR_SETTING_DEFAULTS,
    enqueueJudge: async (id) => void queued.push(id),
  };
  const emailId = await insertEmail({
    teamId: fresh,
    domainId: null,
    from: onboardingEmailFrom,
    subject: "It works.",
  });
  expect(await sendEmail(db, { keyring, ses, monitor, onboardingEmailFrom }, { emailId })).toBe(
    "sent",
  );
  expect(await samplesFor(emailId)).toEqual([]);
  expect(queued).toEqual([]);
  expect(
    await db.select().from(schema.teamMonitor).where(eq(schema.teamMonitor.teamId, fresh)),
  ).toEqual([]);
});
