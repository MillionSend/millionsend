import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const boolFromString = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

/**
 * Comma-separated ARNs → non-empty array, or undefined. Values like "," or
 * whitespace must yield undefined, not [] — a truthy empty allowlist would
 * mount the SNS endpoint yet 403 every delivery, including the
 * SubscriptionConfirmation needed to ever receive events.
 */
export function parseSnsTopicArns(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const arns = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return arns.length > 0 ? arns : undefined;
}

// Built-in defaults, exported for the settings screen's "effective value"
// display — the env proxy is raw process.env under SKIP_ENV_VALIDATION, so
// consumers needing the default without zod's parsing read these.
export const SES_MAX_SEND_RATE_DEFAULT = 14;
export const EMAIL_RETENTION_DAYS_DEFAULT = 30;

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
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    DATABASE_URL: z.url(),

    IS_CLOUD: boolFromString,

    // SMTP relay (PROCESS=smtp) listen port.
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(2587),
    // Public hostname self-hosters point their app's SMTP client at. Defaults
    // to the APP_BASE_URL host; set when the relay is reachable elsewhere.
    SMTP_PUBLIC_HOST: z.string().optional(),
    // STARTTLS certificate for the SMTP relay. Both set → STARTTLS is
    // offered and required before AUTH; unset → plaintext (run the relay
    // inside your own network or behind a TLS-terminating load balancer).
    SMTP_TLS_CERT_PATH: z.string().optional(),
    SMTP_TLS_KEY_PATH: z.string().optional(),

    // Envelope-encryption KEK for email bodies at rest.
    // Self-host: required. Cloud: omitted in favor of KMS_KEY_ID.
    MASTER_ENCRYPTION_KEY: canonicalBase64Key.optional(),
    KMS_KEY_ID: z.string().optional(),

    // BYO-SES for self-host; cloud uses the platform account.
    AWS_REGION: z.string().default("us-east-1"),
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),

    // SNS topics allowed to deliver SES events (comma-separated ARNs).
    // Unset disables the ingestion endpoint entirely — signature checks
    // without a topic allowlist would accept any AWS account's topic.
    SNS_TOPIC_ARNS: z.string().optional().transform(parseSnsTopicArns),

    // SQS queue the worker long-polls for SES events when SNS has no public
    // https endpoint to push to. Requires SNS_TOPIC_ARNS — the same allowlist
    // authenticates messages read from the queue.
    SQS_QUEUE_URL: z.url().optional(),

    // SES configuration set whose event destination feeds the SNS topic
    // (SELF_HOSTING checklist). Used for sends whenever a domain has no
    // per-domain set recorded; without it SES publishes no events.
    SES_CONFIGURATION_SET: z.string().optional(),

    // Messages/second ceiling for THE ONE worker process: the bucket is
    // in-memory, so running N worker replicas multiplies the real SES rate
    // by N. Until the bucket is shared (Postgres-backed), scale the worker
    // vertically only, or divide this value by the replica count. 14/s is
    // SES's standard production default; sandbox accounts must set 1.
    // Bootstrap value only — the instance_settings row overrides it.
    SES_MAX_SEND_RATE: z.coerce.number().positive().default(SES_MAX_SEND_RATE_DEFAULT),

    // Days email BODIES are kept; metadata and events are unaffected.
    // Bootstrap value only — the instance_settings row overrides it.
    EMAIL_RETENTION_DAYS: z.coerce.number().int().min(1).default(EMAIL_RETENTION_DAYS_DEFAULT),

    // Public base URL of this deployment; SNS subscriptions and hosted
    // unsubscribe pages are derived from it.
    APP_BASE_URL: z.url().optional(),

    // Dashboard session signing secret (`openssl rand -base64 32`).
    // Required only by the web process, which asserts it at boot.
    BETTER_AUTH_SECRET: z.string().min(32).optional(),

    // Self-host signup policy: the FIRST user may always register; after
    // that, registration requires this to be explicitly enabled. Keeps an
    // internet-reachable dashboard from handing strangers the SES account.
    ALLOW_SIGNUP: boolFromString,

    // Social login for the dashboard. A provider's sign-in button appears
    // only when BOTH its client id and secret are set.
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),

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
