import { readFileSync } from "node:fs";
import { env } from "@millionsend/config";
import { EnvKeyring } from "@millionsend/core";
import { getDb } from "@millionsend/db";
import { Queue } from "@millionsend/queue";
import { createSmtpServer } from "./smtp.js";

if (!env.MASTER_ENCRYPTION_KEY) {
  // Cloud KMS keyring arrives with the AWS package; until then both modes
  // require the env KEK, which self-host mandates anyway.
  throw new Error("MASTER_ENCRYPTION_KEY is required to start the SMTP relay");
}

// The relay is an email.send producer, so the queue is unconditional.
const queue = await Queue.start(env.DATABASE_URL);

const certPath = env.SMTP_TLS_CERT_PATH;
const keyPath = env.SMTP_TLS_KEY_PATH;
if (!certPath && !env.SMTP_ALLOW_INSECURE_AUTH) {
  throw new Error(
    "SMTP requires TLS; set SMTP_TLS_CERT_PATH and SMTP_TLS_KEY_PATH, or explicitly set SMTP_ALLOW_INSECURE_AUTH=true only on a trusted private network",
  );
}

const server = createSmtpServer({
  db: getDb(),
  keyring: EnvKeyring.fromBase64(env.MASTER_ENCRYPTION_KEY),
  isCloud: env.IS_CLOUD,
  enqueueEmailSend: async (emailId, opts) => {
    await queue.send(
      "email.send",
      { emailId },
      { dedupeKey: emailId, ...(opts?.startAfter ? { startAfter: opts.startAfter } : {}) },
    );
  },
  ...(certPath && keyPath
    ? { tls: { cert: readFileSync(certPath), key: readFileSync(keyPath) } }
    : {}),
  allowInsecureAuth: env.SMTP_ALLOW_INSECURE_AUTH,
});

server.on("error", (err) => {
  console.error("smtp server error", err);
});

server.listen(env.SMTP_PORT, () => {
  console.log(`millionsend smtp listening on :${env.SMTP_PORT}`);
});
