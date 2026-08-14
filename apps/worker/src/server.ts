import { env } from "@millionsend/config";
import {
  EnvKeyring,
  getInstanceSettings,
  postJson,
  purgeExpiredIdempotencyKeys,
} from "@millionsend/core";
import { getDb } from "@millionsend/db";
import { Queue } from "@millionsend/queue";
import {
  drainQuotaParked,
  purgeExpiredEmailBodies,
  reconcileStalledSends,
  reconcileWebhookDeliveries,
} from "./handlers/cron.js";
import { deliverWebhook } from "./handlers/deliver-webhook.js";
import { processSesEvent } from "./handlers/process-ses-event.js";
import { createTokenBucket, sendEmail } from "./handlers/send-email.js";
import { createSesSender } from "./ses-sender.js";

if (!env.MASTER_ENCRYPTION_KEY) {
  // Cloud KMS keyring arrives with the AWS package; until then both modes
  // require the env KEK, which self-host mandates anyway.
  throw new Error("MASTER_ENCRYPTION_KEY is required to start the worker");
}

const db = getDb();
const keyring = EnvKeyring.fromBase64(env.MASTER_ENCRYPTION_KEY);
const ses = createSesSender(env.AWS_REGION);
// The bucket is the messages/second control; worker concurrency is not a
// rate limit and must never be treated as one. In-memory ⇒ single worker
// process only (see SES_MAX_SEND_RATE in @millionsend/config). The db-backed
// instance setting overrides env; polled so a Settings → Instance change
// applies within a minute, without a restart.
const bucket = createTokenBucket(env.SES_MAX_SEND_RATE);
const applySendRate = async (): Promise<void> => {
  const { sesMaxSendRate } = await getInstanceSettings(db);
  bucket.setRate(sesMaxSendRate ?? env.SES_MAX_SEND_RATE);
};
await applySendRate();
setInterval(() => {
  // Transient db failure keeps the last applied rate.
  applySendRate().catch((err) => console.warn("send-rate refresh failed", err));
}, 60_000).unref();

const queue = await Queue.start(env.DATABASE_URL);

const enqueueSend = async (emailId: string, startAfter?: Date): Promise<void> => {
  await queue.send(
    "email.send",
    { emailId },
    { dedupeKey: emailId, ...(startAfter ? { startAfter } : {}) },
  );
};

const enqueueWebhook = async (deliveryId: string, startAfter?: Date): Promise<void> => {
  await queue.send(
    "webhook.deliver",
    { deliveryId },
    { dedupeKey: deliveryId, ...(startAfter ? { startAfter } : {}) },
  );
};

await queue.work("email.send", async (payload) => {
  await bucket.take();
  await sendEmail(
    db,
    {
      keyring,
      ses,
      defaultConfigurationSet: env.SES_CONFIGURATION_SET,
      reschedule: (emailId, at) => enqueueSend(emailId, at),
      enqueueWebhookDelivery: enqueueWebhook,
    },
    payload,
  );
});

await queue.work("ses.event", async (payload) => {
  await processSesEvent(db, payload.event, {
    snsMessageId: payload.snsMessageId,
    enqueueWebhookDelivery: enqueueWebhook,
  });
});

await queue.work("webhook.deliver", async (payload) => {
  await deliverWebhook(
    db,
    {
      keyring,
      post: (url, body, headers) =>
        postJson(url, { body, headers, allowLocalhost: env.NODE_ENV === "development" }),
      reenqueue: enqueueWebhook,
    },
    payload,
  );
});

await queue.scheduleCrons({
  "quota.drain": async () => {
    const result = await drainQuotaParked(db, { isCloud: env.IS_CLOUD, enqueueSend });
    console.log(`quota.drain: drained=${result.drained} stillParked=${result.stillParked}`);
  },
  "sends.reconcile": async () => {
    const requeued = await reconcileStalledSends(db, { enqueueSend });
    if (requeued > 0) console.log(`sends.reconcile: requeued=${requeued}`);
  },
  "retention.purge": async () => {
    const purged = await purgeExpiredEmailBodies(db, {
      defaultRetentionDays: env.EMAIL_RETENTION_DAYS,
    });
    if (purged > 0) console.log(`retention.purge: purged=${purged}`);
  },
  "idempotency.purge": async () => {
    await purgeExpiredIdempotencyKeys(db);
  },
  "webhooks.reconcile": async () => {
    const requeued = await reconcileWebhookDeliveries(db, { enqueue: enqueueWebhook });
    if (requeued > 0) console.log(`webhooks.reconcile: requeued=${requeued}`);
  },
});

console.log("millionsend worker running");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    queue.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
