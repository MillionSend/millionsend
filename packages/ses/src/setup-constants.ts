// Pure constants shared by every AWS setup path (CLI, generated shell script,
// CloudFormation template, dashboard). No SDK or node imports: the web app
// bundles this module client-side via the "./setup-constants" subpath export.

/** AWS resource names every setup path (CLI, shell script, CloudFormation) creates. */
export const SETUP_NAMES = {
  policy: "millionsend-ses",
  user: "millionsend",
  topic: "millionsend-events",
  queue: "millionsend-events",
  configurationSet: "millionsend",
  eventDestination: "millionsend-events",
} as const;

/**
 * SESv2 event types the event destination subscribes to. Deliberately excludes
 * OPEN and CLICK: engagement is tracked app-layer (we rewrite links and inject
 * the pixel ourselves), and subscribing to OPEN/CLICK is what makes SES rewrite
 * links / inject its own pixel. Omitting them keeps SES out of the message body.
 * SEND is excluded too: the worker records the "sent" event locally at send
 * time, so SES's copy would only duplicate the timeline.
 */
export const SES_EVENT_TYPES = [
  "DELIVERY",
  "DELIVERY_DELAY",
  "BOUNCE",
  "COMPLAINT",
  "REJECT",
  "RENDERING_FAILURE",
] as const;

/**
 * Every SES action the instance issues — infra/millionsend-ses.cfn.yaml
 * mirrors the same set. Identity actions support resource-level permissions
 * and are confined to identities; sending stays account-wide because a send
 * that names a configuration set is authorized against that resource too,
 * and GetAccount accepts no resource at all.
 */
export const SES_IAM_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: [
        "ses:CreateEmailIdentity",
        "ses:GetEmailIdentity",
        "ses:DeleteEmailIdentity",
        "ses:PutEmailIdentityMailFromAttributes",
        "ses:PutEmailIdentityDkimSigningAttributes",
      ],
      Resource: "arn:aws:ses:*:*:identity/*",
    },
    {
      Effect: "Allow",
      Action: ["ses:SendEmail", "ses:SendRawEmail", "ses:GetAccount"],
      Resource: "*",
    },
    // Per-team SES tenants (SES_TENANTS). Tenant ARNs have no documented
    // resource-level scope, so the actions stay account-wide.
    {
      Effect: "Allow",
      Action: [
        "ses:CreateTenant",
        "ses:GetTenant",
        "ses:DeleteTenant",
        "ses:CreateTenantResourceAssociation",
        "ses:DeleteTenantResourceAssociation",
      ],
      Resource: "*",
    },
  ],
} as const;

export const SES_IAM_POLICY_JSON = JSON.stringify(SES_IAM_POLICY, null, 2);

/**
 * The self-host .env template, byte-identical to the repo's root .env.example
 * (a packages/ses test pins the equivalence) so the wizard can create a .env
 * in an empty directory with no repo clone. Edit both together.
 */
export function envTemplate(): string {
  return `# MillionSend self-host configuration.
# Save as .env, generate the two secrets below, and \`docker compose up -d\`.
# This file holds every secret the instance has: keep it readable by its
# owner only (chmod 600 .env) and out of version control and backups.

# --- Required ---

# Postgres connection string. The default matches the docker-compose postgres
# service; for local dev without Docker, point it at your own instance
# (e.g. postgres://postgres:postgres@localhost:5432/millionsend).
DATABASE_URL=postgres://millionsend:millionsend@postgres:5432/millionsend

# Password of the compose postgres service; the setup wizard generates one and
# puts it in DATABASE_URL too. Keep both in sync.
POSTGRES_PASSWORD=millionsend

# Standalone deploy/docker-compose.yml only: the image to run. The default,
# ghcr.io/millionsend/millionsend:latest, is the latest tagged release, so
# \`docker compose pull\` is the upgrade; :edge follows main (every build there
# passed the test suite first). Set a version tag or an immutable @sha256
# digest here to hold a version; the backup sidecar pins the same way.
# MILLIONSEND_IMAGE=ghcr.io/millionsend/millionsend@sha256:<digest>
# MILLIONSEND_BACKUP_IMAGE=ghcr.io/millionsend/backup@sha256:<digest>

# Optional compose services, comma-separated: smtp (the relay; mount a
# STARTTLS keypair first), and in deploy/docker-compose.yml also docs (the
# documentation site) and backup (scheduled dumps; needs S3_BACKUP_BUCKET).
# COMPOSE_PROFILES=docs,backup

# Encryption key for email bodies at rest and the root the tracking and
# unsubscribe link keys derive from. Generate: openssl rand -base64 32
# Always required, cloud included. Losing it makes stored bodies
# unrecoverable; changing it orphans old bodies and every link already mailed.
MASTER_ENCRYPTION_KEY=

# Cloud only (IS_CLOUD=true): AWS KMS key (ARN or key id) that wraps per-email
# data keys instead of MASTER_ENCRYPTION_KEY, which stays set (bodies sealed
# under it remain readable; links still derive from it). Boot refuses it
# when IS_CLOUD is false.
# KMS_KEY_ID=

# Dashboard session signing secret. Generate: openssl rand -base64 32
BETTER_AUTH_SECRET=

# Public base URL of this deployment — the origin browsers use to reach the
# dashboard (e.g. https://mail.example.com). Sign-in is only accepted from
# this origin; SNS subscriptions and hosted unsubscribe pages derive from it.
# The default matches the docker-compose setup on the host machine.
# MUST match the exact scheme+host+port you open the dashboard on — including
# a custom WEB_PORT (e.g. http://localhost:3009). A mismatch makes login and
# signup fail with an "invalid origin" error.
APP_BASE_URL=http://localhost:3000

# Public origin of the API, for deployments whose reverse proxy serves it on
# its own hostname (e.g. https://api.example.com) rather than on port 3001 of
# the dashboard host. Unset, that derived URL is what the dashboard prints as
# the API base and what MCP tokens are bound to — correct for the compose
# setup, unroutable once a proxy moves the API. Changes only the published
# URL; the api still listens on PORT.
# PUBLIC_API_URL=

# --- AWS SES (bring your own account) ---

# IAM credentials with ses:SendEmail / ses:SendRawEmail. Omit to use the
# default AWS credential chain (instance profile, SSO, etc).
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=

# Comma-separated SNS topic ARNs allowed to deliver SES events (bounces,
# complaints, deliveries). Unset disables event ingestion entirely.
# See SELF_HOSTING.md for the SNS setup checklist.
SNS_TOPIC_ARNS=

# SQS queue the worker long-polls for SES events (setup always creates it; it
# buffers through restarts and needs no inbound reachability). Only messages
# from topics in SNS_TOPIC_ARNS are accepted. Keep it set even when SNS also
# pushes to https://<your-host>/ses/events — the app dedupes the two.
SQS_QUEUE_URL=

# SES configuration set applied to sends that have no per-domain configuration
# set. Point its event destination at the SNS topic above so delivery events
# reach MillionSend. Unset sends without a configuration set.
SES_CONFIGURATION_SET=

# One SES tenant per team, so SES tracks bounce/complaint reputation per
# customer instead of per account and can pause one sender without pausing
# the rest. Defaults to IS_CLOUD; the IAM policy needs the ses:*Tenant* actions.
SES_TENANTS=

# --- Optional ---

# The first user can always register; after that, signup stays closed unless
# this is true. Keep false when the dashboard is reachable from the internet.
ALLOW_SIGNUP=false

# Hosted cloud only (ignored when IS_CLOUD=false): force branded tracking
# subdomains on even without a TRACKING_EDGE_HOST — for a cloud that serves
# customer hostnames on the app host itself. Setting TRACKING_EDGE_HOST already
# enables them, so leave this false when you run a tracking edge. Self-host
# always allows branded subdomains (the operator owns the proxy and its certs).
ALLOW_TRACKING_SUBDOMAINS=false

# Host a customer's branded tracking subdomain CNAMEs at. Leave unset and the
# CNAME targets this app's own host — correct for self-host, where the operator
# already serves customer hostnames. On a multi-tenant cloud the app cannot
# hold a certificate per customer hostname, so point this at a dedicated
# tracking edge (a small box that terminates TLS on demand per hostname and
# proxies /t/* back here); the customer's CNAME then targets that edge.
# TRACKING_EDGE_HOST=track.example-dns.com
# Shared secret the tracking edge sends when asking whether a hostname is a
# configured tracking subdomain (gates on-demand certificate issuance).
# Generate: openssl rand -hex 32
# TRACKING_ASK_SECRET=

# API port. Under docker compose this moves both the container's listen port
# and the published host port together.
PORT=3001
API_RATE_LIMIT_PER_MINUTE=600

# Compose binds application ports to loopback by default. Set only the service
# that must be reachable directly to 0.0.0.0; prefer a TLS reverse proxy.
WEB_BIND_ADDRESS=127.0.0.1
API_BIND_ADDRESS=127.0.0.1
DOCS_BIND_ADDRESS=127.0.0.1
SMTP_BIND_ADDRESS=127.0.0.1

# Host port the compose file publishes the web dashboard on (the web process
# itself is always 3000 inside the container). Remember to keep APP_BASE_URL
# in sync with wherever the dashboard is actually reachable.
WEB_PORT=3000

# Host port the compose file publishes the documentation site on (the docs
# process itself is always 3002 inside the container). The docs service is
# optional and needs no database.
DOCS_PORT=3002

# SMTP relay (the optional smtp compose service) listen port. Clients
# authenticate with username "millionsend" and an ms_ API key as the password.
SMTP_PORT=2587

# STARTTLS keypair for the SMTP relay (PEM paths inside the container). Both
# set: STARTTLS is offered and required before AUTH. Without a keypair the
# relay refuses to start unless the private-network escape hatch below is
# explicitly enabled.
SMTP_TLS_CERT_PATH=
SMTP_TLS_KEY_PATH=
SMTP_ALLOW_INSECURE_AUTH=false

# Terms of Service / Privacy Policy links for the auth screen's consent line
# ("By signing in, you agree to…"). Optional — unset links are omitted, and
# the whole line is hidden when neither is set.
TERMS_URL=
PRIVACY_URL=

# Sender for account emails (password reset), as "Name <user@domain>" or a
# bare address. Its domain must be a verified identity in this instance's SES
# account. Leave unset to hide password recovery entirely.
AUTH_EMAIL_FROM=

# Shared sender for the onboarding "Send email" button and snippet, as
# "Name <user@domain>" or a bare address on a domain verified in this SES
# account. Any team may send from it, only to its own members' inboxes. Leave
# unset to hide the button; the snippet then asks for the team's own domain.
ONBOARDING_EMAIL_FROM=

# Cloudflare Turnstile (https://dash.cloudflare.com → Turnstile), both keys or
# neither. When set, sign-in, sign-up, password reset and the onboarding
# "Send email" button verify a challenge token; an invisible or managed
# widget works. Leave both unset to run without a captcha.
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=

# Sender for account notifications to team owners (daily quota nearly or fully
# used, bounce/complaint rates at risk or paused) and for team invitation
# emails, same forms as AUTH_EMAIL_FROM. Leave unset to send them from
# AUTH_EMAIL_FROM; with neither set, only the webhook events go out and
# invitations are link-only.
NOTIFICATIONS_EMAIL_FROM=

# Reverse proxies whose forwarded-client-IP headers (X-Forwarded-For,
# CF-Connecting-IP) are trusted, comma-separated. Default: loopback only,
# which covers a proxy on the same host. Add your proxy's address when it
# runs elsewhere; an untrusted source's headers are ignored and the socket
# address is used instead.
# TRUSTED_PROXIES=127.0.0.1,::1

# Local development only: let webhook endpoints target http:// and
# private/loopback addresses. Keep false on any internet-reachable instance.
WEBHOOK_ALLOW_LOCALHOST=false

# Leave false. true enables hosted-cloud behavior (KMS, Stripe billing).
IS_CLOUD=false

# Hosted cloud only (ignored when IS_CLOUD=false): Stripe API secret key, the
# signing secret of the webhook endpoint pointed at /api/billing/webhook, and
# an optional customer-portal configuration id (unset = the account default).
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PORTAL_CONFIG=

# --- Object storage (S3-compatible, optional) ---

# ONE credential set, shared by both S3-backed features below (team logo
# uploads and database backups); each feature is then enabled by its own
# bucket variable. Set all three together. Cloudflare R2 works out of the
# box; its endpoint is https://<accountid>.r2.cloudflarestorage.com
S3_ENDPOINT=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=

# Defaults suit Cloudflare R2. Other S3-compatibles: set a real region if the
# endpoint needs one, and rclone's provider name (AWS, Minio, ...) for the
# backup job.
S3_REGION=auto
S3_PROVIDER=Cloudflare

# Uploads (team logos): a bucket that already exists and serves objects
# PUBLICLY, plus the public base URL it serves from (the R2 public bucket
# URL, or a CDN/custom domain in front of it). Uploaded objects are addressed
# as \${S3_STORAGE_PUBLIC_URL}/<key>. Unset: no upload UI appears anywhere.
S3_STORAGE_BUCKET=
S3_STORAGE_PUBLIC_URL=

# Backups: scheduled pg_dump of the database, run by the \`backup\` compose
# service. Use a SEPARATE, PRIVATE bucket that already exists — dumps contain
# the whole database, and R2 public access is bucket-wide, so a dump in the
# public uploads bucket would be world-readable. Unset: the service prints a
# hint and exits.
S3_BACKUP_BUCKET=

# Backup tuning, meaningful only with S3_BACKUP_BUCKET set: object key prefix
# inside the bucket (default backups), dump schedule (default 0 3 * * *, UTC;
# only the daily form \`<minute> <hour> * * *\` is honoured, any other shape
# makes the backup service exit 1; one dump also runs at every service
# start), and how many days of dumps to keep before pruning (default 14).
S3_BACKUP_PREFIX=
BACKUP_CRON=
BACKUP_RETENTION_DAYS=

# age public key (age1...); set to encrypt dumps before upload. Restore with
# \`age --decrypt -i <key file>\` first.
BACKUP_AGE_RECIPIENT=

# --- Social login (optional) ---

# OAuth credentials for the dashboard's social sign-in. Each provider's
# "Continue with …" button appears only when BOTH its id and secret are set.
# Register this callback URL on the OAuth app: {APP_BASE_URL}/api/auth/callback/<provider>
# e.g. https://mail.example.com/api/auth/callback/google

# Google: https://console.cloud.google.com/apis/credentials (OAuth client ID, type Web application)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# GitHub: https://github.com/settings/developers (New OAuth App)
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# Worker sizing. Lanes: about 1.2 per message/second of SES send rate (default fits 14/s).
# WORKER_REPLICAS divides the send rate per process when more than one worker runs.
# SQS_POLL_CONCURRENCY: parallel SQS long-poll loops (4 keeps up with a 55/s burst).
# WEBHOOK_DELIVERY_RETENTION_DAYS: how long webhook delivery rows stay readable.
# EMAIL_METADATA_RETENTION_DAYS: days whole email rows (recipients, subject, status,
#   events) are kept; bodies leave earlier on the dashboard's retention setting.
#   Daily counters and broadcast results are kept regardless. Was 365 before v0.6.30.
# SEND_CONCURRENCY=16
# WORKER_REPLICAS=1
# SQS_POLL_CONCURRENCY=4
# WEBHOOK_DELIVERY_RETENTION_DAYS=30
# EMAIL_METADATA_RETENTION_DAYS=30
`;
}

/** The https origin of the URL, or null when it is not a valid https URL. */
export function httpsOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * SESv2 SNS event destinations need the topic to allow ses.amazonaws.com to
 * publish, or CreateConfigurationSetEventDestination is rejected.
 */
export function snsTopicPolicy(topicArn: string, accountId: string): object {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "ses.amazonaws.com" },
        Action: "sns:Publish",
        Resource: topicArn,
        Condition: { StringEquals: { "AWS:SourceAccount": accountId } },
      },
    ],
  };
}

/**
 * Events-queue policy: only the events topic may write, and the millionsend
 * IAM user may consume. The consume grant lives here (resource policy) rather
 * than in SES_IAM_POLICY because a same-account resource policy suffices on
 * SQS, and the identity policy — created once, adopted on re-runs — could not
 * gain new statements on deployments that predate the queue.
 */
export function sqsQueuePolicy(queueArn: string, topicArn: string, accountId: string): object {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "sns.amazonaws.com" },
        Action: "sqs:SendMessage",
        Resource: queueArn,
        Condition: { ArnEquals: { "aws:SourceArn": topicArn } },
      },
      {
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${accountId}:user/${SETUP_NAMES.user}` },
        Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
        Resource: queueArn,
      },
    ],
  };
}
