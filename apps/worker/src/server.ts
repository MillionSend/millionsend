import { SESv2Client } from "@aws-sdk/client-sesv2";
import { env } from "@millionsend/config";
import { EnvKeyring, purgeExpiredIdempotencyKeys } from "@millionsend/core";
import { getDb } from "@millionsend/db";
import { Queue } from "@millionsend/queue";
import { drainQuotaParked, purgeExpiredEmailBodies } from "./handlers/cron.js";
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
const ses = createSesSender(new SESv2Client({ region: env.AWS_REGION }));
// The bucket is the messages/second control; worker concurrency is not a
// rate limit and must never be treated as one.
const takeToken = createTokenBucket(env.SES_MAX_SEND_RATE);

const queue = await Queue.start(env.DATABASE_URL);

await queue.work("email.send", async (payload) => {
  await takeToken();
  await sendEmail(db, { keyring, ses }, payload);
});

await queue.work("ses.event", async (payload) => {
  await processSesEvent(db, payload.event);
});

await queue.scheduleCrons({
  "quota.drain": async () => {
    const result = await drainQuotaParked(db, {
      isCloud: env.IS_CLOUD,
      enqueueSend: async (emailId) => {
        await queue.send("email.send", { emailId });
      },
    });
    console.log(`quota.drain: drained=${result.drained} stillParked=${result.stillParked}`);
  },
  "retention.purge": async () => {
    const purged = await purgeExpiredEmailBodies(db, {
      retentionDays: env.EMAIL_RETENTION_DAYS,
    });
    if (purged > 0) console.log(`retention.purge: purged=${purged}`);
  },
  "idempotency.purge": async () => {
    await purgeExpiredIdempotencyKeys(db);
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
