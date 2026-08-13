import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const boolFromString = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

/**
 * Process environment, validated at boot. Every process (web, api, worker, smtp)
 * imports this and crashes early on misconfiguration instead of at first use.
 *
 * IS_CLOUD is the single seam between the hosted SaaS and self-host:
 * cloud-only variables must stay optional here and be refined below, so a
 * self-host boot never demands Stripe/KMS configuration.
 */
export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.url(),

    IS_CLOUD: boolFromString,

    // Envelope-encryption KEK for email bodies at rest.
    // Self-host: required, 32 bytes base64 (`openssl rand -base64 32`).
    // Cloud: omitted in favor of AWS KMS (KMS_KEY_ID below).
    MASTER_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, "base64").length === 32, {
        message: "MASTER_ENCRYPTION_KEY must be 32 bytes, base64-encoded",
      })
      .optional(),
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
});

export type Env = typeof env;

/**
 * Cross-field rules that createEnv cannot express per-field.
 * Called from process entrypoints after import so tests can construct
 * partial environments without tripping boot checks.
 */
export function assertEnvConsistency(e: Env): void {
  if (e.IS_CLOUD) {
    if (!e.KMS_KEY_ID) {
      throw new Error("IS_CLOUD=true requires KMS_KEY_ID (cloud KEK lives in KMS)");
    }
    if (!e.STRIPE_SECRET_KEY) {
      throw new Error("IS_CLOUD=true requires STRIPE_SECRET_KEY");
    }
  } else if (!e.MASTER_ENCRYPTION_KEY) {
    throw new Error(
      "Self-host requires MASTER_ENCRYPTION_KEY (32 bytes base64; generate with `openssl rand -base64 32`)",
    );
  }
}
