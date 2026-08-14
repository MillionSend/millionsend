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

/** SESv2 event types the event destination subscribes to — the full set the app ingests. */
export const SES_EVENT_TYPES = [
  "SEND",
  "DELIVERY",
  "DELIVERY_DELAY",
  "BOUNCE",
  "COMPLAINT",
  "OPEN",
  "CLICK",
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
