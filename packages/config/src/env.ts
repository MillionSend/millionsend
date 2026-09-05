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
  return parseCommaList(value);
}

/** Comma-separated list → trimmed non-empty entries, or undefined when none. */
export function parseCommaList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

// Built-in defaults, exported for the settings screen's "effective value"
// display — the env proxy is raw process.env under SKIP_ENV_VALIDATION, so
// consumers needing the default without zod's parsing read these.
export const SES_MAX_SEND_RATE_DEFAULT = 14;
export const EMAIL_RETENTION_DAYS_DEFAULT = 30;
export const OPEN_PREFETCH_WINDOW_SECONDS_DEFAULT = 10;

const emailAddress = z.email();

/**
 * Parse a mail From value — `Name <user@domain>` or a bare address — into its
 * display name and address. Null when the address part is not a valid email,
 * so boot validation can reject a typo instead of failing on the first send.
 */
export function parseEmailFrom(value: string): { name: string | null; address: string } | null {
  const match = /^([^<>]*)<([^<>\s]+)>$/.exec(value.trim());
  const name = match?.[1]?.trim().replace(/^"(.*)"$/, "$1") || null;
  const address = match ? (match[2] ?? "") : value.trim();
  if (!emailAddress.safeParse(address).success) return null;
  return { name, address };
}

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
    // Git SHA baked into the image (Dockerfile ARG GIT_SHA); reported by the
    // API's /health so a running deployment can be matched to a commit.
    MILLIONSEND_REVISION: z.string().default("unknown"),
    API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(600),
    DATABASE_URL: z.url(),

    IS_CLOUD: boolFromString,

    // Reverse proxies whose X-Forwarded-For / CF-Connecting-IP headers are
    // trusted for the client IP (comma-separated IPs). Anything else is a
    // spoofable header, so the socket address wins.
    TRUSTED_PROXIES: z
      .string()
      .default("127.0.0.1,::1")
      .transform((v) => parseCommaList(v) ?? []),

    // Webhook SSRF escape hatch: allow http:// and private/loopback targets
    // for local development. Never enable on an internet-reachable instance.
    WEBHOOK_ALLOW_LOCALHOST: boolFromString,

    // SMTP relay (PROCESS=smtp) listen port.
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(2587),
    // Public hostname self-hosters point their app's SMTP client at. Defaults
    // to the APP_BASE_URL host; set when the relay is reachable elsewhere.
    SMTP_PUBLIC_HOST: z.string().optional(),
    // STARTTLS certificate for the SMTP relay. Both set → STARTTLS is
    // offered and required before AUTH; unset → AUTH stays disabled unless
    // the private-network escape hatch below is explicitly enabled.
    SMTP_TLS_CERT_PATH: z.string().optional(),
    SMTP_TLS_KEY_PATH: z.string().optional(),
    // Explicit escape hatch for a private, trusted network. False by default
    // because AUTH PLAIN/LOGIN exposes the API key without TLS.
    SMTP_ALLOW_INSECURE_AUTH: boolFromString,

    // Envelope-encryption KEK for email bodies at rest, and the HKDF root of
    // the tracking/unsubscribe token keys. Always required: cloud wraps new
    // DEKs with KMS but still derives tokens (and reads pre-KMS rows) from it.
    MASTER_ENCRYPTION_KEY: canonicalBase64Key,
    // Cloud only: KMS key (ARN or key id) that wraps per-email DEKs instead
    // of the env KEK. Rows sealed under the env KEK stay readable through
    // the composite keyring.
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

    // One SES tenant per team (reputation + suppression isolation at SES).
    // Unset follows IS_CLOUD; see sesTenantsEnabled().
    SES_TENANTS: z.enum(["true", "false", "1", "0"]).optional(),

    // Messages/second ceiling for THE ONE worker process: the bucket is
    // in-memory, so running N worker replicas multiplies the real SES rate
    // by N. Until the bucket is shared (Postgres-backed), scale the worker
    // vertically only, or divide this value by the replica count. 14/s is
    // SES's standard production default; sandbox accounts must set 1.
    // Bootstrap value only — the instance_settings row overrides it.
    SES_MAX_SEND_RATE: z.coerce.number().positive().default(SES_MAX_SEND_RATE_DEFAULT),
    // Concurrent send lanes in the worker. A lane spends most of a send
    // waiting on SES, so about 1.2 lanes per message/second of send rate
    // keeps the bucket full; the default matches the standard 14/s account.
    SEND_CONCURRENCY: z.coerce.number().int().min(1).default(16),
    // Worker processes sharing one SES account. Each divides the send rate
    // by this number, since the bucket lives in process memory.
    WORKER_REPLICAS: z.coerce.number().int().min(1).default(1),
    // Parallel SQS long-poll loops. One loop is bounded by the round trip to
    // the queue's region; four keep up with a 55/s burst from another region.
    SQS_POLL_CONCURRENCY: z.coerce.number().int().min(1).default(4),
    // Days webhook delivery rows (payload, response, attempts) stay readable
    // in the dashboard before the retention purge deletes them.
    WEBHOOK_DELIVERY_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),

    // Days email BODIES are kept; metadata and events are unaffected.
    // Bootstrap value only — the instance_settings row overrides it.
    EMAIL_RETENTION_DAYS: z.coerce.number().int().min(1).default(EMAIL_RETENTION_DAYS_DEFAULT),
    // Whole email rows (recipients, subject, status, events) age out on this
    // window; bodies leave earlier on EMAIL_RETENTION_DAYS. Thirty days is the
    // industry norm (Resend keeps email data 30 days) and what the metadata
    // tables are sized for; daily counters and broadcast results outlive it.
    EMAIL_METADATA_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
    // A tracking-image fetch within this many seconds of delivery (or before
    // it) is recorded as prefetched, not opened: security gateways scan a
    // message within seconds, while a person reading a push notification
    // takes longer. 0 leaves only the user-agent rules.
    OPEN_PREFETCH_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .default(OPEN_PREFETCH_WINDOW_SECONDS_DEFAULT),

    // Public base URL of this deployment; SNS subscriptions and hosted
    // unsubscribe pages are derived from it.
    APP_BASE_URL: z.url().optional(),

    // Public origin of the API, when a reverse proxy serves it somewhere other
    // than port 3001 of the dashboard host (the compose default the derivation
    // in @millionsend/core assumes). Only what the app PRINTS and what MCP
    // tokens are bound to; the listen port stays PORT.
    PUBLIC_API_URL: z.url().optional(),

    // Legal pages linked from the auth screen's consent line. Both optional;
    // the line renders only the links that are set, and disappears entirely
    // when neither is.
    TERMS_URL: z.url().optional(),
    PRIVACY_URL: z.url().optional(),

    // Sender for system emails (password reset), as `Name <user@domain>` or a
    // bare address; its domain must be a verified identity in this instance's
    // SES account. Unset disables password recovery entirely.
    AUTH_EMAIL_FROM: z.string().optional(),

    // Shared first-email sender for the onboarding flow, as `Name <user@domain>`
    // or a bare address on a domain verified in this instance's SES account.
    // Any team may send from it — but only to its own members' inboxes — so
    // the onboarding snippet runs before a domain is verified. Unset hides the
    // "Send email" button and the snippet asks for the team's own domain.
    ONBOARDING_EMAIL_FROM: z.string().optional(),

    // Cloudflare Turnstile, both keys or neither: sign-in, sign-up, password
    // reset and the onboarding send verify a token when set. Unset, every
    // form works as before with no challenge.
    TURNSTILE_SITE_KEY: z.string().optional(),
    TURNSTILE_SECRET_KEY: z.string().optional(),

    // Sender for account notifications (quota and deliverability alerts to
    // team owners) and team invitation emails, same forms as AUTH_EMAIL_FROM,
    // which it falls back to.
    NOTIFICATIONS_EMAIL_FROM: z.string().optional(),

    // Dashboard session signing secret (`openssl rand -base64 32`).
    // Required only by the web process, which asserts it at boot.
    BETTER_AUTH_SECRET: z.string().min(32).optional(),

    // Self-host signup policy: the FIRST user may always register; after
    // that, registration requires this to be explicitly enabled. Keeps an
    // internet-reachable dashboard from handing strangers the SES account.
    ALLOW_SIGNUP: boolFromString,

    // Cloud-only switch for branded tracking subdomains (a customer CNAMEs
    // track.theirdomain.com at this app). Read through
    // trackingSubdomainsSupported(), which leaves self-host unconditionally on.
    ALLOW_TRACKING_SUBDOMAINS: boolFromString,

    // Host a customer's branded tracking subdomain CNAMEs at. Set to a
    // dedicated tracking edge (e.g. track.millionsend-dns.com — a small box
    // that terminates TLS per customer hostname and proxies /t/* here) when
    // this app itself cannot hold a certificate for customer hostnames, as on
    // a multi-tenant cloud behind a CDN. Unset: the CNAME targets this app's
    // own host, which only works where it can serve those hostnames directly.
    TRACKING_EDGE_HOST: z.string().optional(),
    // Shared secret the tracking edge sends when asking whether a hostname is
    // a configured tracking subdomain (gates on-demand certificate issuance).
    TRACKING_ASK_SECRET: z.string().optional(),

    // Social login for the dashboard. A provider's sign-in button appears
    // only when BOTH its client id and secret are set.
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),

    // Cloud-only (billing). STRIPE_PORTAL_CONFIG selects a customer-portal
    // configuration; unset uses the Stripe account's default one.
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    STRIPE_PORTAL_CONFIG: z.string().optional(),

    // S3-compatible object storage (Cloudflare R2 first-class). ONE credential
    // set shared by every S3-backed feature; each feature is enabled by its
    // bucket variable below. "auto" is R2's region; other S3-compatibles set a
    // real one when the endpoint needs it.
    S3_ENDPOINT: z.url().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_REGION: z.string().default("auto"),

    // Team logo uploads. The bucket must serve objects publicly; they are
    // addressed as S3_STORAGE_PUBLIC_URL/<key>. Unset hides the upload UI
    // everywhere.
    S3_STORAGE_BUCKET: z.string().optional(),
    S3_STORAGE_PUBLIC_URL: z.url().optional(),

    // Backup sidecar gate + tuning (scripts/backup). Only the sidecar's shell
    // scripts consume these; they are declared here so the cross-field boot
    // checks below can reject partial configuration for the whole stack.
    S3_BACKUP_BUCKET: z.string().optional(),
    S3_BACKUP_PREFIX: z.string().optional(),
    BACKUP_CRON: z.string().optional(),
    BACKUP_RETENTION_DAYS: z.string().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  skipValidation: process.env.SKIP_ENV_VALIDATION === "1",
});

export type Env = typeof env;

// Under SKIP_ENV_VALIDATION the env proxy carries raw process.env strings,
// where the string "false" is truthy — so boolean flags are read through
// this instead of tested for truthiness.
function envFlag(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

/** The single seam between the hosted SaaS and self-host. */
export function isCloudDeployment(e: Env = env): boolean {
  return envFlag(e.IS_CLOUD);
}

/** Whether teams get their own SES tenant: explicit SES_TENANTS wins, else the cloud default. */
export function sesTenantsEnabled(e: Env = env): boolean {
  const flag = e.SES_TENANTS as unknown;
  if (flag === undefined || flag === "") return isCloudDeployment(e);
  return envFlag(flag);
}

/** The sender for account notifications; undefined when no system sender is configured. */
export function notificationsEmailFrom(e: Env = env): string | undefined {
  return e.NOTIFICATIONS_EMAIL_FROM ?? e.AUTH_EMAIL_FROM;
}

/**
 * Whether a domain's branded tracking subdomain — a customer CNAME pointing
 * at this app — can actually be served here.
 *
 * Self-host: yes, unconditionally. The operator owns the reverse proxy and
 * its certificates, so pointing another hostname at the app is theirs to
 * arrange, and the domain screen already warns while the CNAME does not
 * resolve.
 *
 * Cloud: only when the operator says so. A customer hostname arriving at a
 * shared, CDN-fronted origin needs per-hostname certificate provisioning set
 * up deliberately; without it the TLS handshake fails, and every tracked link
 * that already shipped points somewhere recipients cannot reach.
 */
export function trackingSubdomainsSupported(e: Env = env): boolean {
  if (!isCloudDeployment(e)) return true;
  // A configured tracking edge is itself the "per-hostname certificates are
  // handled" signal, so it enables branded subdomains on its own. The flag
  // stays for the rarer cloud that serves customer hostnames on the app host
  // directly, with no separate edge.
  return envFlag(e.ALLOW_TRACKING_SUBDOMAINS) || Boolean(e.TRACKING_EDGE_HOST);
}

/**
 * The host a branded tracking subdomain CNAMEs at: the dedicated tracking edge
 * when one is configured, otherwise this app's own host (from `appBaseUrl`).
 */
export function trackingCnameTarget(appBaseUrl: string, e: Env = env): string {
  return e.TRACKING_EDGE_HOST ?? new URL(appBaseUrl).host;
}

const S3_CREDENTIAL_KEYS = ["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;

const S3_BUCKET_KEYS = ["S3_STORAGE_BUCKET", "S3_BACKUP_BUCKET"] as const;

const BACKUP_TUNING_KEYS = ["S3_BACKUP_PREFIX", "BACKUP_CRON", "BACKUP_RETENTION_DAYS"] as const;

/** Cross-field rules that per-field schemas cannot express. */
export function assertEnvConsistency(e: Env): void {
  if (Boolean(e.SMTP_TLS_CERT_PATH) !== Boolean(e.SMTP_TLS_KEY_PATH)) {
    throw new Error("SMTP_TLS_CERT_PATH and SMTP_TLS_KEY_PATH must be set together");
  }
  if (e.AUTH_EMAIL_FROM && parseEmailFrom(e.AUTH_EMAIL_FROM) === null) {
    throw new Error('AUTH_EMAIL_FROM must be "Name <user@domain>" or a bare email address');
  }
  if (e.ONBOARDING_EMAIL_FROM && parseEmailFrom(e.ONBOARDING_EMAIL_FROM) === null) {
    throw new Error('ONBOARDING_EMAIL_FROM must be "Name <user@domain>" or a bare email address');
  }
  if (Boolean(e.TURNSTILE_SITE_KEY) !== Boolean(e.TURNSTILE_SECRET_KEY)) {
    throw new Error("TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must be set together");
  }
  if (e.NOTIFICATIONS_EMAIL_FROM && parseEmailFrom(e.NOTIFICATIONS_EMAIL_FROM) === null) {
    throw new Error(
      'NOTIFICATIONS_EMAIL_FROM must be "Name <user@domain>" or a bare email address',
    );
  }
  // Half a keypair would silently fall back to the default provider chain
  // everywhere AWS clients are built (SES, KMS) — reject it instead. A fully
  // absent pair stays valid: the chain (instance profile, SSO) is a real
  // credential source that env vars cannot attest to.
  if (Boolean(e.AWS_ACCESS_KEY_ID) !== Boolean(e.AWS_SECRET_ACCESS_KEY)) {
    throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together");
  }
  // Partial S3 config is a misconfiguration, not "disabled": silently
  // disabling a feature would make the missing variable invisible.
  const credentialsSet = S3_CREDENTIAL_KEYS.filter((key) => e[key]);
  if (credentialsSet.length > 0 && credentialsSet.length < S3_CREDENTIAL_KEYS.length) {
    const missing = S3_CREDENTIAL_KEYS.filter((key) => !e[key]).join(", ");
    throw new Error(`S3 credentials must be set together; missing: ${missing}`);
  }
  for (const bucket of S3_BUCKET_KEYS) {
    if (e[bucket] && credentialsSet.length === 0) {
      throw new Error(`${bucket} requires the S3 credentials (${S3_CREDENTIAL_KEYS.join(", ")})`);
    }
  }
  if (Boolean(e.S3_STORAGE_BUCKET) !== Boolean(e.S3_STORAGE_PUBLIC_URL)) {
    throw new Error("S3_STORAGE_BUCKET and S3_STORAGE_PUBLIC_URL must be set together");
  }
  for (const key of BACKUP_TUNING_KEYS) {
    if (e[key] && !e.S3_BACKUP_BUCKET) {
      throw new Error(`${key} requires S3_BACKUP_BUCKET`);
    }
  }
  if (e.IS_CLOUD) {
    for (const key of [
      "KMS_KEY_ID",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "APP_BASE_URL",
    ] as const) {
      if (!e[key]) throw new Error(`IS_CLOUD=true requires ${key}`);
    }
  } else if (e.KMS_KEY_ID) {
    // A self-host boot would silently ignore the KMS key and seal everything
    // under the env KEK — almost certainly an IS_CLOUD line lost in env drift.
    throw new Error("KMS_KEY_ID is set but IS_CLOUD is false");
  }
}

if (process.env.SKIP_ENV_VALIDATION !== "1") {
  assertEnvConsistency(env);
}
