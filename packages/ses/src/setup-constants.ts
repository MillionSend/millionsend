// Pure constants shared by every AWS setup path (CLI, generated shell script,
// CloudFormation template, dashboard). No SDK or node imports: the web app
// bundles this module client-side via the "./setup-constants" subpath export.

/** AWS resource names every setup path (CLI, shell script, CloudFormation) creates. */
export const SETUP_NAMES = {
  policy: "millionsend-ses",
  user: "millionsend",
  topic: "millionsend-events",
  configurationSet: "millionsend",
  eventDestination: "millionsend-events",
} as const;

/**
 * SESv2 event types the event destination subscribes to. Deliberately excludes
 * OPEN and CLICK: engagement is tracked app-layer (we rewrite links and inject
 * the pixel ourselves), and subscribing to OPEN/CLICK is what makes SES rewrite
 * links / inject its own pixel. Omitting them keeps SES out of the message body.
 */
export const SES_EVENT_TYPES = [
  "SEND",
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
# Everything else has working local defaults.

# --- Required ---

# Postgres connection string. The default matches the docker-compose postgres
# service; for local dev without Docker, point it at your own instance
# (e.g. postgres://postgres:postgres@localhost:5432/millionsend).
DATABASE_URL=postgres://millionsend:millionsend@postgres:5432/millionsend

# Encryption key for email bodies at rest. Generate: openssl rand -base64 32
# Losing it makes stored bodies unrecoverable; changing it orphans old bodies.
MASTER_ENCRYPTION_KEY=

# Dashboard session signing secret. Generate: openssl rand -base64 32
BETTER_AUTH_SECRET=

# Public base URL of this deployment — the origin browsers use to reach the
# dashboard (e.g. https://mail.example.com). Sign-in is only accepted from
# this origin; SNS subscriptions and hosted unsubscribe pages derive from it.
# The default matches the docker-compose setup on the host machine.
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

# SES configuration set applied to sends that have no per-domain configuration
# set. Point its event destination at the SNS topic above so delivery events
# reach MillionSend. Unset sends without a configuration set.
SES_CONFIGURATION_SET=

# --- Optional ---

# The first user can always register; after that, signup stays closed unless
# this is true. Keep false when the dashboard is reachable from the internet.
ALLOW_SIGNUP=false

# API port (the web dashboard is always 3000).
PORT=3001

# SMTP relay (the optional smtp compose service) listen port. Clients
# authenticate with username "millionsend" and an ms_ API key as the password.
SMTP_PORT=2587

# STARTTLS keypair for the SMTP relay (PEM paths inside the container). Both
# set: STARTTLS is offered and required before AUTH. Unset: plaintext — keep
# the port inside your own network or behind a TLS-terminating load balancer.
SMTP_TLS_CERT_PATH=
SMTP_TLS_KEY_PATH=

# Leave false. true enables hosted-cloud behavior (KMS, Stripe billing).
IS_CLOUD=false
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
