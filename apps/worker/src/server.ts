import { env } from "@millionsend/config";
import {
  deriveTrackingKey,
  deriveUnsubscribeKey,
  EnvKeyring,
  getInstanceSettings,
  postJson,
  purgeExpiredIdempotencyKeys,
} from "@millionsend/core";
import { getDb } from "@millionsend/db";
import { Queue } from "@millionsend/queue";
import { createSesv2Client, nodeDnsResolver, type SesIdentityClient } from "@millionsend/ses";
import {
  drainQuotaParked,
  purgeExpiredApiRequests,
  purgeExpiredEmailBodies,
  reconcileStalledBroadcasts,
  reconcileStalledSends,
  reconcileWebhookDeliveries,
  reverifyDomains,
} from "./handlers/cron.js";
import { deliverWebhook } from "./handlers/deliver-webhook.js";
import { processSesEvent } from "./handlers/process-ses-event.js";
import { sendBroadcast } from "./handlers/send-broadcast.js";
import { createTokenBucket, sendEmail } from "./handlers/send-email.js";
import { createSesSender } from "./ses-sender.js";

if (!env.MASTER_ENCRYPTION_KEY) {
  // Cloud KMS keyring arrives with the AWS package; until then both modes
  // require the env KEK, which self-host mandates anyway.
  throw new Error("MASTER_ENCRYPTION_KEY is required to start the worker");
}

const db = getDb();
const keyring = EnvKeyring.fromBase64(env.MASTER_ENCRYPTION_KEY);
const masterKeyBytes = Buffer.from(env.MASTER_ENCRYPTION_KEY, "base64");
const unsubscribeSecretKey = deriveUnsubscribeKey(masterKeyBytes);
// App-layer tracking signs tokens with an HKDF-derived key; defaultBaseUrl is
// the redirect host for domains without a custom tracking subdomain. Absent
// APP_BASE_URL only fails a send whose domain has tracking on and no subdomain.
const tracking = {
  secretKey: deriveTrackingKey(masterKeyBytes),
  ...(env.APP_BASE_URL ? { defaultBaseUrl: env.APP_BASE_URL } : {}),
};
// Absent APP_BASE_URL doesn't stop the worker — transactional mail still
// flows — but broadcast fan-out and broadcast sends refuse loudly.
const unsubscribe = env.APP_BASE_URL
  ? { secretKey: unsubscribeSecretKey, baseUrl: env.APP_BASE_URL }
  : undefined;
const ses = createSesSender(env.AWS_REGION);
// SESv2 identity clients (GetEmailIdentity) for domain re-verification, cached
// per region since identities live in the domain's region. Distinct from the
// send client above (SendEmail); credentials fall back to the provider chain.
const identityClients = new Map<string, SesIdentityClient>();
const clientForRegion = (region: string): SesIdentityClient => {
  let client = identityClients.get(region);
  if (!client) {
    client = createSesv2Client({
      region,
      ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
        : {}),
    });
    identityClients.set(region, client);
  }
  return client;
};
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
      tracking,
      ...(unsubscribe ? { unsubscribe } : {}),
    },
    payload,
  );
});

const enqueueBroadcast = async (broadcastId: string, startAfter?: Date): Promise<void> => {
  await queue.send(
    "broadcast.send",
    { broadcastId },
    { dedupeKey: broadcastId, ...(startAfter ? { startAfter } : {}) },
  );
};

await queue.work("broadcast.send", async (payload) => {
  await sendBroadcast(
    db,
    {
      keyring,
      unsubscribeSecretKey,
      appBaseUrl: env.APP_BASE_URL,
      isCloud: env.IS_CLOUD,
      enqueueEmailSend: enqueueSend,
      reschedule: (broadcastId, at) => enqueueBroadcast(broadcastId, at),
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
    const requests = await purgeExpiredApiRequests(db, {
      defaultRetentionDays: env.EMAIL_RETENTION_DAYS,
    });
    if (purged > 0 || requests > 0) {
      console.log(`retention.purge: purged=${purged} apiRequests=${requests}`);
    }
  },
  "idempotency.purge": async () => {
    await purgeExpiredIdempotencyKeys(db);
  },
  "webhooks.reconcile": async () => {
    const requeued = await reconcileWebhookDeliveries(db, { enqueue: enqueueWebhook });
    if (requeued > 0) console.log(`webhooks.reconcile: requeued=${requeued}`);
  },
  "broadcasts.reconcile": async () => {
    const requeued = await reconcileStalledBroadcasts(db, {
      enqueue: (broadcastId) => enqueueBroadcast(broadcastId),
    });
    if (requeued > 0) console.log(`broadcasts.reconcile: requeued=${requeued}`);
  },
  "domains.reverify": async () => {
    const result = await reverifyDomains(db, { clientForRegion, resolver: nodeDnsResolver });
    if (result.checked > 0 || result.failed > 0) {
      console.log(`domains.reverify: checked=${result.checked} failed=${result.failed}`);
    }
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
