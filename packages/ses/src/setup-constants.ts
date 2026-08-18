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

/** Every SES action the instance issues — infra/millionsend-ses.cfn.yaml mirrors the same set. */
export const SES_IAM_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: [
        "ses:SendEmail",
        "ses:SendRawEmail",
        "ses:CreateEmailIdentity",
        "ses:GetEmailIdentity",
        "ses:DeleteEmailIdentity",
        "ses:PutEmailIdentityMailFromAttributes",
        "ses:GetAccount",
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
# The standalone deploy compose file also requires an explicit released image.

# --- Required ---

# Postgres connection string. The default matches the docker-compose postgres
# service; for local dev without Docker, point it at your own instance
# (e.g. postgres://postgres:postgres@localhost:5432/millionsend).
DATABASE_URL=postgres://millionsend:millionsend@postgres:5432/millionsend

# Required by deploy/docker-compose.yml. Prefer an immutable digest in
# production, for example ghcr.io/millionsend/millionsend@sha256:<digest>.
# MILLIONSEND_IMAGE=ghcr.io/millionsend/millionsend:<released-version>

# Encryption key for email bodies at rest. Generate: openssl rand -base64 32
# Losing it makes stored bodies unrecoverable; changing it orphans old bodies.
MASTER_ENCRYPTION_KEY=

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

# SQS queue the worker long-polls for SES events when this deployment has no
# public https URL for SNS to push to (setup creates it in that case). Only
# messages from topics in SNS_TOPIC_ARNS are accepted. Leave unset when SNS
# delivers to https://<your-host>/ses/events directly.
SQS_QUEUE_URL=

# SES configuration set applied to sends that have no per-domain configuration
# set. Point its event destination at the SNS topic above so delivery events
# reach MillionSend. Unset sends without a configuration set.
SES_CONFIGURATION_SET=

# --- Optional ---

# The first user can always register; after that, signup stays closed unless
# this is true. Keep false when the dashboard is reachable from the internet.
ALLOW_SIGNUP=false

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
# set: STARTTLS is offered and required before AUTH. Without a keypair, AUTH is
# disabled unless the private-network escape hatch below is explicitly enabled.
SMTP_TLS_CERT_PATH=
SMTP_TLS_KEY_PATH=
SMTP_ALLOW_INSECURE_AUTH=false

# Leave false. true enables hosted-cloud behavior (KMS, Stripe billing).
IS_CLOUD=false

# --- Backups (optional) ---

# Scheduled pg_dump of the database to any S3-compatible bucket, run by the
# \`backup\` compose service. Disabled until all four BACKUP_S3_* values below
# are set — until then the service prints a hint and exits. The bucket must
# already exist. Cloudflare R2 endpoint: https://<accountid>.r2.cloudflarestorage.com
BACKUP_S3_ENDPOINT=
BACKUP_S3_BUCKET=
BACKUP_S3_ACCESS_KEY_ID=
BACKUP_S3_SECRET_ACCESS_KEY=

# Defaults suit Cloudflare R2. Other S3-compatibles: set rclone's provider
# name (AWS, Minio, ...) and a real region if the endpoint needs one.
BACKUP_S3_PROVIDER=Cloudflare
BACKUP_S3_REGION=auto

# Object key prefix inside the bucket, dump schedule (BusyBox cron syntax,
# UTC; one dump also runs at every service start), and how many days of dumps
# to keep before pruning.
BACKUP_S3_PREFIX=backups
BACKUP_CRON=0 3 * * *
BACKUP_RETENTION_DAYS=14

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
