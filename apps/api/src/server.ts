import { serve } from "@hono/node-server";
import { env } from "@millionsend/config";
import { EnvKeyring } from "@millionsend/core";
import { getDb } from "@millionsend/db";
import { createApi } from "./app.js";

if (!env.MASTER_ENCRYPTION_KEY) {
  // Cloud KMS keyring arrives with the AWS package; until then both modes
  // require the env KEK, which self-host mandates anyway.
  throw new Error("MASTER_ENCRYPTION_KEY is required to start the API");
}

const app = createApi({
  db: getDb(),
  keyring: EnvKeyring.fromBase64(env.MASTER_ENCRYPTION_KEY),
  isCloud: env.IS_CLOUD,
});

const port = env.PORT;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`millionsend api listening on :${info.port}`);
});
