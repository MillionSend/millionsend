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

// SES event ingestion exists only when a topic allowlist is configured —
// signature checks without one would accept any AWS account's topic.
const snsTopicArns = env.SNS_TOPIC_ARNS;
const queue = snsTopicArns ? await Queue.start(env.DATABASE_URL) : null;

const app = createApi({
  db: getDb(),
  keyring: EnvKeyring.fromBase64(env.MASTER_ENCRYPTION_KEY),
  isCloud: env.IS_CLOUD,
  ...(queue && snsTopicArns
    ? {
        sns: {
          allowedTopicArns: snsTopicArns,
          fetchCert: createCachingCertFetcher(),
          enqueueSesEvent: async (event, dedupeKey) => {
            await queue.send("ses.event", { event }, { dedupeKey });
          },
        },
      }
    : {}),
});

const port = env.PORT;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`millionsend api listening on :${info.port}`);
});
