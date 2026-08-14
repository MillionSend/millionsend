import {
  httpsOrigin,
  SES_EVENT_TYPES,
  SES_IAM_POLICY,
  SETUP_NAMES,
  snsTopicPolicy,
} from "@millionsend/ses/setup-constants";

export const CFN_DEPLOY_COMMAND =
  "aws cloudformation deploy --template-file infra/millionsend-ses.cfn.yaml --stack-name millionsend --capabilities CAPABILITY_NAMED_IAM";

const CFN_TEMPLATE_URL = "https://millionsend-public.s3.amazonaws.com/millionsend-ses.cfn.yaml";

/**
 * CloudFormation quick-create review page for the hosted template
 * (maintainer notes on the hosted copy: SELF_HOSTING.md).
 */
export function cfnQuickCreateUrl(region: string): string {
  return `https://console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/create/review?templateURL=${CFN_TEMPLATE_URL}&stackName=millionsend`;
}

// The shell script interpolates $TOPIC_ARN/$ACCOUNT_ID at run time, so the
// JSON payloads are built around shell-quoted variable splices — snsTopicPolicy
// with placeholder values, single quotes closed around each splice.
const SNS_TOPIC_POLICY_SHELL = JSON.stringify(snsTopicPolicy("__TOPIC__", "__ACCOUNT__"))
  .replace('"__TOPIC__"', '"\'"$TOPIC_ARN"\'"')
  .replace('"__ACCOUNT__"', '"\'"$ACCOUNT_ID"\'"');

const EVENT_DESTINATION_SHELL = `{"Enabled":true,"MatchingEventTypes":${JSON.stringify(
  SES_EVENT_TYPES,
)},"SnsDestination":{"TopicArn":"'"$TOPIC_ARN"'"}}`;

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
    `echo "==> IAM policy ${SETUP_NAMES.policy}"`,
    `aws iam create-policy --policy-name ${SETUP_NAMES.policy} --policy-document '${JSON.stringify(SES_IAM_POLICY)}' >/dev/null 2>&1 || true`,
    `POLICY_ARN="arn:aws:iam::$ACCOUNT_ID:policy/${SETUP_NAMES.policy}"`,
    "",
    `echo "==> IAM user ${SETUP_NAMES.user}"`,
    `aws iam create-user --user-name ${SETUP_NAMES.user} >/dev/null 2>&1 || true`,
    `aws iam attach-user-policy --user-name ${SETUP_NAMES.user} --policy-arn "$POLICY_ARN" || exit 1`,
    "",
    'echo "==> Access key"',
    `KEY=$(aws iam create-access-key --user-name ${SETUP_NAMES.user} \\`,
    '  --query "[AccessKey.AccessKeyId,AccessKey.SecretAccessKey]" --output text) || exit 1',
    "ACCESS_KEY_ID=$(printf '%s' \"$KEY\" | cut -f1)",
    "SECRET_ACCESS_KEY=$(printf '%s' \"$KEY\" | cut -f2)",
  ];

  if (origin) {
    lines.push(
      "",
      `echo "==> SNS topic ${SETUP_NAMES.topic}"`,
      "# create-topic is idempotent: it returns the existing topic's ARN.",
      `TOPIC_ARN=$(aws sns create-topic --name ${SETUP_NAMES.topic} --region "$REGION" --query TopicArn --output text) || exit 1`,
      'aws sns set-topic-attributes --topic-arn "$TOPIC_ARN" --attribute-name Policy \\',
      `  --attribute-value '${SNS_TOPIC_POLICY_SHELL}' --region "$REGION" || exit 1`,
      'aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol https \\',
      `  --notification-endpoint "${origin}/ses/events" --region "$REGION" >/dev/null || exit 1`,
      "",
      `echo "==> SES configuration set ${SETUP_NAMES.configurationSet}"`,
      `aws sesv2 create-configuration-set --configuration-set-name ${SETUP_NAMES.configurationSet} --region "$REGION" >/dev/null 2>&1 || true`,
      "aws sesv2 create-configuration-set-event-destination \\",
      `  --configuration-set-name ${SETUP_NAMES.configurationSet} --event-destination-name ${SETUP_NAMES.eventDestination} \\`,
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
      `echo "SES_CONFIGURATION_SET=${SETUP_NAMES.configurationSet}"`,
      'echo ""',
      'echo "# The event subscription confirms itself once the app runs with these values;"',
      "echo \"# if it stays pending, use 'Request confirmation' on it in the SNS console.\"",
    );
  }
  lines.push("");
  return lines.join("\n");
}
