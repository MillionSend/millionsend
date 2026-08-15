import { randomBytes } from "node:crypto";
import { EnvKeyring } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import type { SerializedSesEvent } from "@millionsend/queue";
import {
  SNS_TEST_CERT_URL,
  SNS_TEST_TOPIC_ARN,
  signSnsMessage,
  snsTestCertPem,
  type UnsignedSnsMessage,
} from "@millionsend/ses/test-support";
import { createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createApi } from "../src/app.js";

/**
 * The ingestion endpoint's contract: nothing unsigned, off-topic, or
 * pointing at a non-AWS host gets in — and a valid message becomes exactly
 * one queued job keyed on the SNS MessageId.
 */

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let enqueued: { event: SerializedSesEvent; dedupeKey: string }[];
let confirmed: string[];
let certFetches: string[];

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
    sns: {
      allowedTopicArns: [SNS_TEST_TOPIC_ARN],
      fetchCert: async (url) => {
        certFetches.push(url);
        return snsTestCertPem();
      },
      enqueueSesEvent: async (event, dedupeKey) => {
        enqueued.push({ event, dedupeKey });
      },
      confirmSubscription: async (url) => {
        confirmed.push(url);
      },
    },
  });
});
beforeEach(() => {
  enqueued = [];
  confirmed = [];
  certFetches = [];
});
afterAll(() => close());

function baseNotification(message: unknown): UnsignedSnsMessage {
  return {
    Type: "Notification",
    MessageId: "sns-mid-1",
    TopicArn: SNS_TEST_TOPIC_ARN,
    Message: typeof message === "string" ? message : JSON.stringify(message),
    Timestamp: "2026-08-14T00:00:00.000Z",
    SignatureVersion: "2",
    SigningCertURL: SNS_TEST_CERT_URL,
  };
}

const deliveryPayload = {
  eventType: "Delivery",
  mail: { messageId: "ses-mid-1", timestamp: "2026-08-14T00:00:00.000Z" },
  delivery: { timestamp: "2026-08-14T00:00:01.000Z", smtpResponse: "250 OK" },
};

async function post(body: unknown): Promise<Response> {
  return app.request("/ses/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

it("valid signed notification: 200 and one job keyed by SNS MessageId", async () => {
  const res = await post(signSnsMessage(baseNotification(deliveryPayload)));
  expect(res.status).toBe(200);
  expect(enqueued).toHaveLength(1);
  expect(enqueued[0]?.dedupeKey).toBe("sns-mid-1");
  expect(enqueued[0]?.event.eventType).toBe("Delivery");
  expect(enqueued[0]?.event.sesMessageId).toBe("ses-mid-1");
});

it("tampered message: 403, nothing enqueued", async () => {
  const signed = signSnsMessage(baseNotification(deliveryPayload));
  const res = await post({
    ...signed,
    Message: JSON.stringify({ ...deliveryPayload, eventType: "Bounce" }),
  });
  expect(res.status).toBe(403);
  expect(enqueued).toHaveLength(0);
});

it("unlisted topic: 403 — a valid Amazon signature is not enough", async () => {
  const msg = signSnsMessage({
    ...baseNotification(deliveryPayload),
    TopicArn: "arn:aws:sns:us-east-1:999999999999:not-ours",
  });
  const res = await post(msg);
  expect(res.status).toBe(403);
  expect(enqueued).toHaveLength(0);
});

it("attacker cert host: 403 and the cert is NEVER fetched", async () => {
  const msg = signSnsMessage({
    ...baseNotification(deliveryPayload),
    SigningCertURL: "https://sns.us-east-1.amazonaws.com.evil.io/cert.pem",
  });
  const res = await post(msg);
  expect(res.status).toBe(403);
  expect(certFetches).toHaveLength(0);
  expect(enqueued).toHaveLength(0);
});

it('an explicit "Subject": null still verifies — SNS delivery paths disagree on absent vs null', async () => {
  const signed = signSnsMessage(baseNotification(deliveryPayload));
  const res = await post({ ...signed, Subject: null });
  expect(res.status).toBe(200);
  expect(enqueued).toHaveLength(1);
});

it("non-JSON and non-SNS bodies: 400", async () => {
  expect((await post("not json {")).status).toBe(400);
  expect((await post({ hello: "world" })).status).toBe(400);
});

it("verified notification with unparseable Message: acked, not enqueued", async () => {
  const res = await post(signSnsMessage(baseNotification("this is not json")));
  expect(res.status).toBe(200);
  expect(enqueued).toHaveLength(0);
});

it("verified notification that is not an SES event: acked, not enqueued", async () => {
  const res = await post(signSnsMessage(baseNotification({ eventType: "Delivery" })));
  expect(res.status).toBe(200);
  expect(enqueued).toHaveLength(0);
});

it("SubscriptionConfirmation: confirms only sns.<region>.amazonaws.com URLs", async () => {
  const base: UnsignedSnsMessage = {
    Type: "SubscriptionConfirmation",
    MessageId: "sns-sub-1",
    TopicArn: SNS_TEST_TOPIC_ARN,
    Message: "You have chosen to subscribe",
    Timestamp: "2026-08-14T00:00:00.000Z",
    SignatureVersion: "2",
    SigningCertURL: SNS_TEST_CERT_URL,
    Token: "tok",
    SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=tok",
  };
  const ok = await post(signSnsMessage(base));
  expect(ok.status).toBe(200);
  expect(confirmed).toEqual([base.SubscribeURL]);

  const evil = await post(
    signSnsMessage({ ...base, SubscribeURL: "https://evil.io/?Action=ConfirmSubscription" }),
  );
  expect(evil.status).toBe(400);
  expect(confirmed).toHaveLength(1);
});

it("endpoint does not exist when SNS ingestion is not configured", async () => {
  const bare = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    enqueueEmailSend: async () => {},
  });
  const res = await bare.request("/ses/events", { method: "POST", body: "{}" });
  expect(res.status).toBe(404);
});
