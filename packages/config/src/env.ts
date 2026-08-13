import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const boolFromString = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

// Canonical base64 only: Buffer.from silently skips foreign characters, so a
// mangled key could pass a length check yet decode differently elsewhere —
// which would make previously encrypted bodies unrecoverable.
const canonicalBase64Key = z.string().refine(
  (v) => {
    const decoded = Buffer.from(v, "base64");
    return decoded.length === 32 && decoded.toString("base64") === v;
  },
  { message: "must be 32 bytes of canonical base64 (`openssl rand -base64 32`)" },
);

/**
 * Process environment, validated at import so every process (web, api,
 * worker, smtp) crashes at boot on misconfiguration instead of at first use.
 * Tests set SKIP_ENV_VALIDATION=1 to construct partial environments.
 *
 * IS_CLOUD is the single seam between the hosted SaaS and self-host:
 * cloud-only variables stay optional per-field and are enforced by the
 * cross-field rules below, so a self-host boot never demands Stripe/KMS
 * configuration.
 */
export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.url(),

    IS_CLOUD: boolFromString,

    // Envelope-encryption KEK for email bodies at rest.
    // Self-host: required. Cloud: omitted in favor of KMS_KEY_ID.
    MASTER_ENCRYPTION_KEY: canonicalBase64Key.optional(),
    KMS_KEY_ID: z.string().optional(),

    // BYO-SES for self-host; cloud uses the platform account.
    AWS_REGION: z.string().default("us-east-1"),
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),

    // Public base URL of this deployment; SNS subscriptions and hosted
    // unsubscribe pages are derived from it.
    APP_BASE_URL: z.url().optional(),

    // Cloud-only (billing).
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  skipValidation: process.env.SKIP_ENV_VALIDATION === "1",
});

export type Env = typeof env;

/** Cross-field rules that per-field schemas cannot express. */
export function assertEnvConsistency(e: Env): void {
  if (e.IS_CLOUD) {
    for (const key of [
      "KMS_KEY_ID",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "APP_BASE_URL",
    ] as const) {
      if (!e[key]) throw new Error(`IS_CLOUD=true requires ${key}`);
    }
  } else if (!e.MASTER_ENCRYPTION_KEY) {
    throw new Error(
      "Self-host requires MASTER_ENCRYPTION_KEY (32 bytes base64; generate with `openssl rand -base64 32`)",
    );
  }
}

if (process.env.SKIP_ENV_VALIDATION !== "1") {
  assertEnvConsistency(env);
}
