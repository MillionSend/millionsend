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

export const CFN_DEPLOY_COMMAND =
  "aws cloudformation deploy --template-file infra/millionsend-ses.cfn.yaml --stack-name millionsend --capabilities CAPABILITY_NAMED_IAM";

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

// SESv2 SNS event destinations need the topic to allow ses.amazonaws.com to
// publish, or CreateConfigurationSetEventDestination is rejected.
const SNS_TOPIC_POLICY_SHELL =
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ses.amazonaws.com"},"Action":"sns:Publish","Resource":"\'"$TOPIC_ARN"\'","Condition":{"StringEquals":{"AWS:SourceAccount":"\'"$ACCOUNT_ID"\'"}}}]}';

const EVENT_DESTINATION_SHELL =
  '{"Enabled":true,"MatchingEventTypes":["SEND","DELIVERY","DELIVERY_DELAY","BOUNCE","COMPLAINT","OPEN","CLICK","REJECT","RENDERING_FAILURE"],"SnsDestination":{"TopicArn":"\'"$TOPIC_ARN"\'"}}';

/**
 * POSIX shell script an operator pastes into a terminal where the aws CLI has
 * admin credentials. Creates the IAM policy + user + access key and, when
 * includeEvents and appBaseUrl is a valid https URL, the SNS topic + SESv2
 * configuration set — then prints the exact .env lines to paste.
 *
 * Only shell-safe inputs are interpolated: region is validated, appBaseUrl is
 * reduced to its URL origin (no query/path/quotes can survive).
 */
export function buildAwsSetupScript(opts: {
  region: string;
  appBaseUrl?: string | null | undefined;
  includeEvents?: boolean;
}): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(opts.region)) {
    throw new Error(`invalid AWS region: ${opts.region}`);
  }
  const origin = opts.includeEvents ? httpsOrigin(opts.appBaseUrl) : null;

  const lines = [
    "#!/bin/sh",
    "# MillionSend AWS setup. Run where the aws CLI has admin credentials.",
    "# Re-runnable: creates that may already exist are tolerated (|| true) —",
    "# but every run mints a NEW access key; delete stale keys in the IAM console.",
    "set -u",
    "",
    `REGION="${opts.region}"`,
    "ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text) || exit 1",
    "",
    'echo "==> IAM policy millionsend-ses"',
    `aws iam create-policy --policy-name millionsend-ses --policy-document '${JSON.stringify(SES_IAM_POLICY)}' >/dev/null 2>&1 || true`,
    'POLICY_ARN="arn:aws:iam::$ACCOUNT_ID:policy/millionsend-ses"',
    "",
    'echo "==> IAM user millionsend"',
    "aws iam create-user --user-name millionsend >/dev/null 2>&1 || true",
    'aws iam attach-user-policy --user-name millionsend --policy-arn "$POLICY_ARN" || exit 1',
    "",
    'echo "==> Access key"',
    "KEY=$(aws iam create-access-key --user-name millionsend \\",
    '  --query "[AccessKey.AccessKeyId,AccessKey.SecretAccessKey]" --output text) || exit 1',
    "ACCESS_KEY_ID=$(printf '%s' \"$KEY\" | cut -f1)",
    "SECRET_ACCESS_KEY=$(printf '%s' \"$KEY\" | cut -f2)",
  ];

  if (origin) {
    lines.push(
      "",
      'echo "==> SNS topic millionsend-events"',
      "# create-topic is idempotent: it returns the existing topic's ARN.",
      'TOPIC_ARN=$(aws sns create-topic --name millionsend-events --region "$REGION" --query TopicArn --output text) || exit 1',
      'aws sns set-topic-attributes --topic-arn "$TOPIC_ARN" --attribute-name Policy \\',
      `  --attribute-value '${SNS_TOPIC_POLICY_SHELL}' --region "$REGION" || exit 1`,
      'aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol https \\',
      `  --notification-endpoint "${origin}/ses/events" --region "$REGION" >/dev/null || exit 1`,
      "",
      'echo "==> SES configuration set millionsend"',
      'aws sesv2 create-configuration-set --configuration-set-name millionsend --region "$REGION" >/dev/null 2>&1 || true',
      "aws sesv2 create-configuration-set-event-destination \\",
      "  --configuration-set-name millionsend --event-destination-name millionsend-events \\",
      `  --event-destination '${EVENT_DESTINATION_SHELL}' \\`,
      '  --region "$REGION" >/dev/null 2>&1 || true',
    );
  }

  lines.push(
    "",
    'echo ""',
    'echo "==> Done. Paste these lines into .env:"',
    'echo ""',
    'echo "AWS_REGION=$REGION"',
    'echo "AWS_ACCESS_KEY_ID=$ACCESS_KEY_ID"',
    'echo "AWS_SECRET_ACCESS_KEY=$SECRET_ACCESS_KEY"',
  );
  if (origin) {
    lines.push(
      'echo "SNS_TOPIC_ARNS=$TOPIC_ARN"',
      'echo "SES_CONFIGURATION_SET=millionsend"',
      'echo ""',
      'echo "# The event subscription confirms itself once the app runs with these values;"',
      "echo \"# if it stays pending, use 'Request confirmation' on it in the SNS console.\"",
    );
  }
  lines.push("");
  return lines.join("\n");
}
