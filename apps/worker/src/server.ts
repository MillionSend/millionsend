import { SQSClient } from "@aws-sdk/client-sqs";
import { createStripe, purgeStripeEvents, reconcileTeamPlan } from "@millionsend/billing";
import {
  env,
  sesTenantsEnabled,
  trackingCnameTarget,
  trackingSubdomainsSupported,
} from "@millionsend/config";
import {
  deriveTrackingKey,
  deriveUnsubscribeKey,
  getInstanceSettings,
  postJson,
  purgeExpiredIdempotencyKeys,
  sesEventsHealth,
} from "@millionsend/core";
import { getDb } from "@millionsend/db";
import { Queue } from "@millionsend/queue";
import {
  createKeyringFromEnv,
  createSesv2Client,
  nodeDnsResolver,
  type SesIdentityClient,
} from "@millionsend/ses";
import {
  drainQuotaParked,
  purgeExpiredApiRequests,
  purgeExpiredEmailBodies,
  purgeExpiredEmailMetadata,
  purgeExpiredSessions,
  reapStaleTrackingSubdomains,
  reapUnverifiedDomains,
  reconcileBillingPlans,
  reconcileStalledBroadcasts,
  reconcileStalledSends,
  reconcileWebhookDeliveries,
  reverifyDomains,
  stripExpiredEventPayloads,
} from "./handlers/cron.js";
import { abandonWebhookDelivery, deliverWebhook } from "./handlers/deliver-webhook.js";
import { sweepNotifications } from "./handlers/notify.js";
import { runPlatformBreaker } from "./handlers/platform-breaker.js";
import { processSesEvent } from "./handlers/process-ses-event.js";
import { sendBroadcast } from "./handlers/send-broadcast.js";
import { createTokenBucket, failQueuedEmail, sendEmail } from "./handlers/send-email.js";
import { syncTenants } from "./handlers/tenants.js";
import { createSesSender } from "./ses-sender.js";
import { startSqsPoller } from "./sqs-poller.js";
import { createSystemMailer } from "./system-mail.js";

if (!env.MASTER_ENCRYPTION_KEY) {
  // Required even when cloud wraps DEKs with KMS: tracking/unsubscribe token
  // keys derive from this key via HKDF, and KMS cannot serve as a local
  // derivation root.
  throw new Error("MASTER_ENCRYPTION_KEY is required to start the worker");
}

const db = getDb();
const keyring = createKeyringFromEnv(env);
// Days whole email rows (recipients, subject, events) are kept; bodies age
// out earlier on EMAIL_RETENTION_DAYS. Read here until it joins the env schema.
const metadataRetentionDays = env.EMAIL_METADATA_RETENTION_DAYS;
const stripe = env.IS_CLOUD && env.STRIPE_SECRET_KEY ? createStripe(env.STRIPE_SECRET_KEY) : null;
const masterKeyBytes = Buffer.from(env.MASTER_ENCRYPTION_KEY, "base64");
const unsubscribeSecretKey = deriveUnsubscribeKey(masterKeyBytes);
// App-layer tracking signs tokens with an HKDF-derived key; defaultBaseUrl is
// the redirect host for domains without a custom tracking subdomain. Absent
// APP_BASE_URL only fails a send whose domain has tracking on and no subdomain.
const tracking = {
  secretKey: deriveTrackingKey(masterKeyBytes),
  allowSubdomains: trackingSubdomainsSupported(),
  requireBrandedHost: env.IS_CLOUD,
  ...(env.APP_BASE_URL ? { defaultBaseUrl: env.APP_BASE_URL } : {}),
};
// Absent APP_BASE_URL doesn't stop the worker — transactional mail still
// flows — but broadcast fan-out and broadcast sends refuse loudly.
const unsubscribe = env.APP_BASE_URL
  ? { secretKey: unsubscribeSecretKey, baseUrl: env.APP_BASE_URL }
  : undefined;
const ses = createSesSender(env.AWS_REGION);
const mailer = createSystemMailer();
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
  await sendEmail(
    db,
    {
      keyring,
      ses,
      defaultConfigurationSet: env.SES_CONFIGURATION_SET,
      onboardingEmailFrom: env.ONBOARDING_EMAIL_FROM,
      throttle: () => bucket.take(),
      reschedule: (emailId, at) => enqueueSend(emailId, at),
      enqueueWebhookDelivery: enqueueWebhook,
      tracking,
      ...(unsubscribe ? { unsubscribe } : {}),
    },
    payload,
  );
});

// Retries exhausted: the row must not stay "queued" for the reconcile sweep
// to resurrect forever.
await queue.workDeadLetter("email.send", async ({ emailId }) => {
  const failed = await failQueuedEmail(db, emailId, "retries_exhausted");
  console.error(`email.send: dead-lettered ${emailId} (marked failed=${failed})`);
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

// SES events over SQS for deployments without a public https URL. The topic
// allowlist gates it exactly like the https endpoint — a queue URL without
// the allowlist stays inert instead of accepting arbitrary payloads.
if (env.SQS_QUEUE_URL) {
  const allowedTopicArns = env.SNS_TOPIC_ARNS ?? [];
  if (allowedTopicArns.length === 0) {
    console.warn("SQS_QUEUE_URL is set but SNS_TOPIC_ARNS is empty — SQS event polling disabled");
  } else {
    startSqsPoller({
      sqs: new SQSClient({
        region: env.AWS_REGION,
        ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
          ? {
              credentials: {
                accessKeyId: env.AWS_ACCESS_KEY_ID,
                secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
              },
            }
          : {}),
      }),
      queueUrl: env.SQS_QUEUE_URL,
      allowedTopicArns,
      enqueueSesEvent: async (event, snsMessageId) => {
        await queue.send("ses.event", { event, snsMessageId }, { dedupeKey: snsMessageId });
      },
      log: (line) => console.warn(line),
    });
    console.log(`sqs poller: long-polling ${env.SQS_QUEUE_URL}`);
  }
}

await queue.work(
  "webhook.deliver",
  async (payload) => {
    await deliverWebhook(
      db,
      {
        keyring,
        post: (url, body, headers) =>
          postJson(url, { body, headers, allowLocalhost: env.WEBHOOK_ALLOW_LOCALHOST }),
        reenqueue: enqueueWebhook,
      },
      payload,
    );
  },
  // Receivers are tenant-controlled and can stall for the full timeout;
  // several workers keep one slow endpoint from serializing every tenant.
  { concurrency: 8 },
);

await queue.workDeadLetter("webhook.deliver", async ({ deliveryId }) => {
  const abandoned = await abandonWebhookDelivery(db, deliveryId);
  console.error(`webhook.deliver: dead-lettered ${deliveryId} (marked exhausted=${abandoned})`);
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
    const stripped = await stripExpiredEventPayloads(db, {
      defaultRetentionDays: env.EMAIL_RETENTION_DAYS,
    });
    const metadata = await purgeExpiredEmailMetadata(db, { retentionDays: metadataRetentionDays });
    const sessions = await purgeExpiredSessions(db);
    const stripeEvents = await purgeStripeEvents(db);
    const counts = {
      purged,
      apiRequests: requests,
      events: stripped.events,
      deliveries: stripped.deliveries,
      emails: metadata.emails,
      oldDeliveries: metadata.deliveries,
      sessions,
      stripeEvents,
    };
    if (Object.values(counts).some((n) => n > 0)) {
      console.log(
        `retention.purge: ${Object.entries(counts)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`,
      );
    }
  },
  "billing.reconcile": async () => {
    if (!stripe) return;
    const result = await reconcileBillingPlans(db, {
      reconcileTeam: (teamId) => reconcileTeamPlan({ db, stripe, log: console.warn }, teamId),
    });
    console.log(`billing.reconcile: reconciled=${result.reconciled} failed=${result.failed}`);
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
  "notifications.sweep": async () => {
    const result = await sweepNotifications(db, {
      isCloud: env.IS_CLOUD,
      mailer,
      enqueueWebhook: (deliveryId) => enqueueWebhook(deliveryId),
      appBaseUrl: env.APP_BASE_URL,
    });
    if (result.sent > 0) console.log(`notifications.sweep: sent=${result.sent}`);
  },
  "platform.breaker": async () => {
    // Without SES events there are no bounce/complaint counts to judge.
    if (!env.SNS_TOPIC_ARNS?.length) return;
    await runPlatformBreaker(db, { mailer, appBaseUrl: env.APP_BASE_URL });
  },
  "events.health": async () => {
    // No topic allowlist = ingestion disabled on purpose; nothing to judge.
    if (!env.SNS_TOPIC_ARNS?.length) return;
    const health = await sesEventsHealth(db);
    if (health.status !== "unhealthy") return;
    console.warn(
      `events.health: ${health.sentInWindow} email(s) sent in the last 2h but no SES event arrived (last one ${health.lastSesEventAt?.toISOString() ?? "never"}) — the SNS subscription is missing or pending confirmation, or SQS_QUEUE_URL is empty / the queue is not being read`,
    );
  },
  "domains.reverify": async () => {
    const result = await reverifyDomains(db, { clientForRegion, resolver: nodeDnsResolver });
    if (result.checked > 0 || result.failed > 0) {
      console.log(`domains.reverify: checked=${result.checked} failed=${result.failed}`);
    }
    // Branded tracking CNAMEs never gate domain status, so reverify above skips
    // them; sweep them here to clear a resolved subdomain's clock or unset one
    // that never resolved. trackingCnameTarget short-circuits to the edge host
    // before parsing APP_BASE_URL, so an empty fallback is only ever ignored.
    const trackingCnameValue =
      env.TRACKING_EDGE_HOST || env.APP_BASE_URL
        ? trackingCnameTarget(env.APP_BASE_URL ?? "")
        : null;
    const tracking = await reapStaleTrackingSubdomains(db, {
      resolver: nodeDnsResolver,
      trackingCnameValue,
    });
    if (tracking.unset > 0) console.log(`domains.reap-tracking: unset=${tracking.unset}`);
  },
  "tenants.sync": async () => {
    const result = await syncTenants(db, {
      clientForRegion,
      configurationSet: env.SES_CONFIGURATION_SET,
      enabled: sesTenantsEnabled(),
    });
    if (result.associated > 0 || result.failed > 0) {
      console.log(`tenants.sync: associated=${result.associated} failed=${result.failed}`);
    }
  },
  "domains.reap": async () => {
    // Cloud-only: squatting is a cross-tenant problem. Self-host is one
    // operator's own teams and adopts existing SES identities on create, so
    // an unverified row blocks nobody there.
    if (!env.IS_CLOUD) return;
    const reaped = await reapUnverifiedDomains(db, { clientForRegion });
    if (reaped > 0) console.log(`domains.reap: reaped=${reaped}`);
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
