import { serve } from "@hono/node-server";
import { env } from "@millionsend/config";
import { EnvKeyring } from "@millionsend/core";
import { getDb } from "@millionsend/db";
import { Queue } from "@millionsend/queue";
import {
  createCachingCertFetcher,
  createSesv2Client,
  type SesIdentityClient,
} from "@millionsend/ses";
import { createApi } from "./app.js";

if (!env.MASTER_ENCRYPTION_KEY) {
  // Cloud KMS keyring arrives with the AWS package; until then both modes
  // require the env KEK, which self-host mandates anyway.
  throw new Error("MASTER_ENCRYPTION_KEY is required to start the API");
}

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
  keyring: EnvKeyring.fromBase64(env.MASTER_ENCRYPTION_KEY),
  isCloud: env.IS_CLOUD,
  rateLimitPerMinute: env.API_RATE_LIMIT_PER_MINUTE,
  appBaseUrl: env.APP_BASE_URL,
  ses: { clientForRegion, defaultRegion: env.AWS_REGION },
  enqueueEmailSend: async (emailId, opts) => {
    await queue.send(
      "email.send",
      { emailId },
      { dedupeKey: emailId, ...(opts?.startAfter ? { startAfter: opts.startAfter } : {}) },
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
