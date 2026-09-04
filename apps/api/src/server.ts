import { serve } from "@hono/node-server";
import { env, sesTenantsEnabled, trackingSubdomainsSupported } from "@millionsend/config";
import { deriveUnsubscribeKey } from "@millionsend/core";
import { getDb } from "@millionsend/db";
import { EMAIL_SEND_PRIORITY, Queue } from "@millionsend/queue";
import {
  createCachingCertFetcher,
  createKeyringFromEnv,
  createSesv2Client,
  type SesIdentityClient,
} from "@millionsend/ses";
import { createApi } from "./app.js";

// Throws on missing encryption configuration, so boot fails before any
// listener starts.
const keyring = createKeyringFromEnv(env);

// The API is the email.send producer, so the queue is unconditional.
const queue = await Queue.start(env.DATABASE_URL);

// SES event ingestion exists only when a topic allowlist is configured —
// signature checks without one would accept any AWS account's topic.
const snsTopicArns = env.SNS_TOPIC_ARNS;

// One client per region: identities live in the domain's region, which may
// differ from AWS_REGION (mirrors the dashboard's defaultSesDeps in
// apps/web/src/server/routers/domains.ts). Credentials fall back to the
// default provider chain.
const regionClients = new Map<string, SesIdentityClient>();
function clientForRegion(region: string): SesIdentityClient {
  let client = regionClients.get(region);
  if (!client) {
    client = createSesv2Client({
      region,
      ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
        : {}),
    });
    regionClients.set(region, client);
  }
  return client;
}

const app = createApi({
  db: getDb(),
  keyring,
  isCloud: env.IS_CLOUD,
  onboardingEmailFrom: env.ONBOARDING_EMAIL_FROM,
  rateLimitPerMinute: env.API_RATE_LIMIT_PER_MINUTE,
  revision: env.MILLIONSEND_REVISION,
  appBaseUrl: env.APP_BASE_URL,
  publicApiUrl: env.PUBLIC_API_URL,
  unsubscribeSecretKey: deriveUnsubscribeKey(Buffer.from(env.MASTER_ENCRYPTION_KEY, "base64")),
  enqueueWebhookDelivery: async (deliveryId) => {
    await queue.send("webhook.deliver", { deliveryId }, { dedupeKey: deliveryId });
  },
  trackingSubdomains: trackingSubdomainsSupported(),
  ses: {
    clientForRegion,
    defaultRegion: env.AWS_REGION,
    authEmailFrom: env.AUTH_EMAIL_FROM,
    onboardingEmailFrom: env.ONBOARDING_EMAIL_FROM,
    notificationsEmailFrom: env.NOTIFICATIONS_EMAIL_FROM,
    ...(sesTenantsEnabled() ? { tenants: { configurationSet: env.SES_CONFIGURATION_SET } } : {}),
  },
  enqueueEmailSend: async (emailId, opts) => {
    await queue.send(
      "email.send",
      { emailId },
      {
        dedupeKey: emailId,
        priority: EMAIL_SEND_PRIORITY.transactional,
        ...(opts?.startAfter ? { startAfter: opts.startAfter } : {}),
      },
    );
  },
  enqueueBroadcastSend: async (broadcastId, opts) => {
    await queue.send(
      "broadcast.send",
      { broadcastId },
      { dedupeKey: broadcastId, ...(opts?.startAfter ? { startAfter: opts.startAfter } : {}) },
    );
  },
  ...(snsTopicArns
    ? {
        sns: {
          allowedTopicArns: snsTopicArns,
          fetchCert: createCachingCertFetcher(),
          enqueueSesEvent: async (event, snsMessageId) => {
            await queue.send("ses.event", { event, snsMessageId }, { dedupeKey: snsMessageId });
          },
        },
      }
    : {}),
});

const port = env.PORT;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`millionsend api listening on :${info.port}`);
});
