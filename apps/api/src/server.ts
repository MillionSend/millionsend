import { serve } from "@hono/node-server";
import { env } from "@millionsend/config";
import { EnvKeyring } from "@millionsend/core";
import { getDb } from "@millionsend/db";
import { Queue } from "@millionsend/queue";
import { createCachingCertFetcher } from "@millionsend/ses";
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

const app = createApi({
  db: getDb(),
  keyring: EnvKeyring.fromBase64(env.MASTER_ENCRYPTION_KEY),
  isCloud: env.IS_CLOUD,
  appBaseUrl: env.APP_BASE_URL,
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
