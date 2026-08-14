import { randomBytes } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import { createApi } from "@millionsend/api";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SerializedSesEvent } from "@millionsend/queue";
import {
  createTeam,
  createTestDb,
  SNS_TEST_CERT_URL,
  SNS_TEST_TOPIC_ARN,
  signSnsMessage,
  snsTestCertPem,
} from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { Resend } from "resend";
import { afterAll, beforeAll, expect, it } from "vitest";
import { processSesEvent } from "../src/handlers/process-ses-event.js";
import { type SesSender, sendEmail } from "../src/handlers/send-email.js";

/**
 * The whole loop, end to end: the OFFICIAL resend SDK sends through a live
 * MillionSend API; the worker send handler pushes it through a fake SES;
 * SES events come back as cryptographically signed SNS posts to the live
 * ingestion endpoint; the event handler drives status and auto-suppression;
 * and the next send enforces that suppression. Only SES itself is faked.
 */

const VICTIM = "victim@e2e.test";
const SES_MESSAGE_ID = "ses-e2e-0001";

let db: Db;
let closeDb: () => Promise<void>;
let server: ServerType;
let baseUrl: string;
let resend: Resend;
let teamId: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const jobs: { event: SerializedSesEvent; dedupeKey: string }[] = [];
const rawSends: Buffer[] = [];
const fakeSes: SesSender = {
  async sendRaw({ raw }) {
    rawSends.push(raw);
    return { messageId: SES_MESSAGE_ID };
  },
};

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  teamId = await createTeam(db, "e2e");
  await db.insert(schema.domains).values({
    teamId,
    name: "e2e.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  const key = generateApiKey("test");
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "e2e",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  const app = createApi({
    db,
    keyring,
    isCloud: true,
    sns: {
      allowedTopicArns: [SNS_TEST_TOPIC_ARN],
      fetchCert: async () => snsTestCertPem(),
      enqueueSesEvent: async (event, dedupeKey) => {
        jobs.push({ event, dedupeKey });
      },
    },
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
  resend = new Resend(key.token, { baseUrl });
});

afterAll(async () => {
  server.close();
  await closeDb();
});

function sesEventMessage(payload: Record<string, unknown>, snsMessageId: string): string {
  return JSON.stringify(
    signSnsMessage({
      Type: "Notification",
      MessageId: snsMessageId,
      TopicArn: SNS_TEST_TOPIC_ARN,
      Message: JSON.stringify(payload),
      Timestamp: new Date().toISOString(),
      SignatureVersion: "2",
      SigningCertURL: SNS_TEST_CERT_URL,
    }),
  );
}

async function postSnsEvent(body: string): Promise<Response> {
  return fetch(`${baseUrl}/ses/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

let emailId: string;

it("accepts a send from the official resend SDK", async () => {
  const { data, error } = await resend.emails.send({
    from: "E2E <hello@e2e.dev>",
    to: [VICTIM],
    subject: "end to end",
    html: "<p>hello</p>",
  });
  expect(error).toBeNull();
  if (!data) throw new Error("no data");
  emailId = data.id;
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
  expect(row?.latestStatus).toBe("queued");
});

it("worker sends it through (fake) SES and records the join key", async () => {
  expect(await sendEmail(db, { keyring, ses: fakeSes }, { emailId })).toBe("sent");
  expect(rawSends).toHaveLength(1);
  expect(rawSends[0]?.toString("utf8").toLowerCase()).toContain(
    `x-millionsend-email-id: ${emailId}`,
  );
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
  expect(row?.sesMessageId).toBe(SES_MESSAGE_ID);
  expect(row?.latestStatus).toBe("sent");
});

it("a signed Delivery event lands over the wire and drives the status", async () => {
  const res = await postSnsEvent(
    sesEventMessage(
      {
        eventType: "Delivery",
        mail: { messageId: SES_MESSAGE_ID, timestamp: new Date().toISOString() },
        delivery: { timestamp: new Date().toISOString(), smtpResponse: "250 OK" },
      },
      "sns-e2e-delivery",
    ),
  );
  expect(res.status).toBe(200);
  const job = jobs.find((j) => j.dedupeKey === "sns-e2e-delivery");
  if (!job) throw new Error("delivery job not enqueued");
  await processSesEvent(db, job.event);

  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
  expect(row?.latestStatus).toBe("delivered");
});

it("a signed Permanent bounce suppresses the recipient", async () => {
  const res = await postSnsEvent(
    sesEventMessage(
      {
        eventType: "Bounce",
        mail: { messageId: SES_MESSAGE_ID, timestamp: new Date().toISOString() },
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "General",
          timestamp: new Date().toISOString(),
          bouncedRecipients: [{ emailAddress: VICTIM, diagnosticCode: "550 5.1.1 user unknown" }],
        },
      },
      "sns-e2e-bounce",
    ),
  );
  expect(res.status).toBe(200);
  const job = jobs.find((j) => j.dedupeKey === "sns-e2e-bounce");
  if (!job) throw new Error("bounce job not enqueued");
  await processSesEvent(db, job.event);

  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
  expect(row?.latestStatus).toBe("bounced");
  const suppressions = await db
    .select()
    .from(schema.suppressions)
    .where(eq(schema.suppressions.teamId, teamId));
  expect(suppressions).toHaveLength(1);
  expect(suppressions[0]?.reason).toBe("hard_bounce");
});

it("the SDK sees the bounce on GET", async () => {
  const { data } = await resend.emails.get(emailId);
  expect(data?.last_event).toBe("bounced");
});

it("the next send to the bounced recipient is refused or stripped", async () => {
  // Alone: nothing left to deliver to.
  const refused = await resend.emails.send({
    from: "E2E <hello@e2e.dev>",
    to: [VICTIM],
    subject: "again",
    text: "hi",
  });
  expect(refused.data).toBeNull();
  expect(refused.error?.message).toContain("suppressed");

  // With company: accepted, but the suppressed address is stripped.
  const stripped = await resend.emails.send({
    from: "E2E <hello@e2e.dev>",
    to: [VICTIM, "ok@e2e.test"],
    subject: "again",
    text: "hi",
  });
  expect(stripped.error).toBeNull();
  if (!stripped.data) throw new Error("no data");
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, stripped.data.id));
  expect(row?.to).toEqual(["ok@e2e.test"]);
});
