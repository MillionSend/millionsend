import {
  AttachUserPolicyCommand,
  CreateAccessKeyCommand,
  type CreateAccessKeyCommandOutput,
  CreatePolicyCommand,
  CreateUserCommand,
  DeleteAccessKeyCommand,
  DeletePolicyCommand,
  DeleteUserCommand,
  DetachUserPolicyCommand,
  IAMClient,
  ListAccessKeysCommand,
  type ListAccessKeysCommandOutput,
} from "@aws-sdk/client-iam";
import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  DeleteConfigurationSetCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import {
  CreateTopicCommand,
  type CreateTopicCommandOutput,
  DeleteTopicCommand,
  SetTopicAttributesCommand,
  SNSClient,
  SubscribeCommand,
} from "@aws-sdk/client-sns";
import {
  httpsOrigin,
  SES_EVENT_TYPES,
  SES_IAM_POLICY,
  SETUP_NAMES,
  snsTopicPolicy,
} from "./setup-constants.js";

export * from "./setup-constants.js";

export function setupPolicyArn(accountId: string): string {
  return `arn:aws:iam::${accountId}:policy/${SETUP_NAMES.policy}`;
}

export function setupTopicArn(region: string, accountId: string): string {
  return `arn:aws:sns:${region}:${accountId}:${SETUP_NAMES.topic}`;
}

type SetupIamCommand =
  | CreatePolicyCommand
  | CreateUserCommand
  | AttachUserPolicyCommand
  | CreateAccessKeyCommand
  | ListAccessKeysCommand
  | DeleteAccessKeyCommand
  | DetachUserPolicyCommand
  | DeleteUserCommand
  | DeletePolicyCommand;

type SetupSnsCommand =
  | CreateTopicCommand
  | SetTopicAttributesCommand
  | SubscribeCommand
  | DeleteTopicCommand;

type SetupSesCommand =
  | CreateConfigurationSetCommand
  | CreateConfigurationSetEventDestinationCommand
  | DeleteConfigurationSetCommand;

/**
 * Structural subsets of the AWS clients so tests inject fakes
 * (mirrors SesAccountClient in account.ts).
 */
export interface SetupIamClient {
  send(command: SetupIamCommand): Promise<unknown>;
}
export interface SetupSnsClient {
  send(command: SetupSnsCommand): Promise<unknown>;
}
export interface SetupSesClient {
  send(command: SetupSesCommand): Promise<unknown>;
}

export interface SetupClients {
  iam: SetupIamClient;
  sns: SetupSnsClient;
  ses: SetupSesClient;
}

/**
 * Real clients on the SDK default provider chain — the setup CLI runs with the
 * operator's own admin credentials (profile/env), never the app's send key.
 */
export function createSetupClients(region: string): SetupClients {
  return {
    iam: new IAMClient({ region }),
    sns: new SNSClient({ region }),
    ses: new SESv2Client({ region }),
  };
}

export interface SetupInput {
  region: string;
  accountId: string;
  /** Events part (SNS topic + configuration set) is included only for a valid https URL. */
  appBaseUrl?: string | null | undefined;
  onStep?: ((line: string) => void) | undefined;
}

export interface SetupResult {
  accessKeyId: string;
  secretAccessKey: string;
  /** null when the events part was skipped. */
  topicArn: string | null;
}

/** Human-readable plan of what runSetup creates with the same input. */
export function setupPlan(input: Pick<SetupInput, "region" | "appBaseUrl">): string[] {
  const origin = httpsOrigin(input.appBaseUrl);
  const lines = [
    `IAM policy ${SETUP_NAMES.policy} (minimal SES send + identity actions)`,
    `IAM user ${SETUP_NAMES.user} with the policy attached`,
    `Access key for ${SETUP_NAMES.user} — a NEW key on every run`,
  ];
  if (origin) {
    lines.push(
      `SNS topic ${SETUP_NAMES.topic} in ${input.region}, subscribed to ${origin}/ses/events`,
      `SES configuration set ${SETUP_NAMES.configurationSet} publishing ${SES_EVENT_TYPES.length} event types to the topic`,
    );
  } else {
    lines.push(
      "(events skipped: no https APP_BASE_URL — sends work, but no bounce/delivery events)",
    );
  }
  return lines;
}

function errorName(error: unknown): string {
  return (error as { name?: string }).name ?? "";
}

/** Awaits the send, swallowing only the given already-exists/not-found error names. */
async function ignoring(promise: Promise<unknown>, names: string[]): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!names.includes(errorName(error))) throw error;
  }
}

/**
 * Creates everything MillionSend needs in AWS. Re-runnable: resources that
 * already exist are adopted — but every run mints a NEW access key.
 */
export async function runSetup(clients: SetupClients, input: SetupInput): Promise<SetupResult> {
  const step = input.onStep ?? (() => {});
  const origin = httpsOrigin(input.appBaseUrl);

  step(`IAM policy ${SETUP_NAMES.policy}`);
  await ignoring(
    clients.iam.send(
      new CreatePolicyCommand({
        PolicyName: SETUP_NAMES.policy,
        PolicyDocument: JSON.stringify(SES_IAM_POLICY),
      }),
    ),
    ["EntityAlreadyExistsException"],
  );

  step(`IAM user ${SETUP_NAMES.user}`);
  await ignoring(clients.iam.send(new CreateUserCommand({ UserName: SETUP_NAMES.user })), [
    "EntityAlreadyExistsException",
  ]);
  await clients.iam.send(
    new AttachUserPolicyCommand({
      UserName: SETUP_NAMES.user,
      PolicyArn: setupPolicyArn(input.accountId),
    }),
  );

  step("Access key");
  let key: CreateAccessKeyCommandOutput;
  try {
    key = (await clients.iam.send(
      new CreateAccessKeyCommand({ UserName: SETUP_NAMES.user }),
    )) as CreateAccessKeyCommandOutput;
  } catch (error) {
    if (errorName(error) === "LimitExceededException") {
      throw new Error(
        `user ${SETUP_NAMES.user} already has the IAM maximum of 2 access keys — delete a stale one in the IAM console and re-run`,
      );
    }
    throw error;
  }
  const accessKeyId = key.AccessKey?.AccessKeyId;
  const secretAccessKey = key.AccessKey?.SecretAccessKey;
  if (!accessKeyId || !secretAccessKey) throw new Error("CreateAccessKey returned no key material");

  let topicArn: string | null = null;
  if (origin) {
    step(`SNS topic ${SETUP_NAMES.topic}`);
    // CreateTopic is idempotent: it returns the existing topic's ARN.
    const topic = (await clients.sns.send(
      new CreateTopicCommand({ Name: SETUP_NAMES.topic }),
    )) as CreateTopicCommandOutput;
    if (!topic.TopicArn) throw new Error("CreateTopic returned no ARN");
    topicArn = topic.TopicArn;
    await clients.sns.send(
      new SetTopicAttributesCommand({
        TopicArn: topicArn,
        AttributeName: "Policy",
        AttributeValue: JSON.stringify(snsTopicPolicy(topicArn, input.accountId)),
      }),
    );
    // Re-subscribing the same endpoint returns the existing subscription.
    await clients.sns.send(
      new SubscribeCommand({
        TopicArn: topicArn,
        Protocol: "https",
        Endpoint: `${origin}/ses/events`,
      }),
    );

    step(`SES configuration set ${SETUP_NAMES.configurationSet}`);
    await ignoring(
      clients.ses.send(
        new CreateConfigurationSetCommand({
          ConfigurationSetName: SETUP_NAMES.configurationSet,
        }),
      ),
      ["AlreadyExistsException"],
    );
    await ignoring(
      clients.ses.send(
        new CreateConfigurationSetEventDestinationCommand({
          ConfigurationSetName: SETUP_NAMES.configurationSet,
          EventDestinationName: SETUP_NAMES.eventDestination,
          EventDestination: {
            Enabled: true,
            MatchingEventTypes: [...SES_EVENT_TYPES],
            SnsDestination: { TopicArn: topicArn },
          },
        }),
      ),
      ["AlreadyExistsException"],
    );
  }

  return { accessKeyId, secretAccessKey, topicArn };
}

/** Human-readable plan of what runTeardown deletes. */
export function teardownPlan(region: string): string[] {
  return [
    `SES configuration set ${SETUP_NAMES.configurationSet} (and its event destination)`,
    `SNS topic ${SETUP_NAMES.topic} in ${region} (and its subscriptions)`,
    `ALL access keys of IAM user ${SETUP_NAMES.user} — a running server using them stops sending`,
    `IAM user ${SETUP_NAMES.user} and policy ${SETUP_NAMES.policy}`,
  ];
}

/** Deletes everything runSetup created. Missing resources are tolerated. */
export async function runTeardown(
  clients: SetupClients,
  input: { region: string; accountId: string; onStep?: ((line: string) => void) | undefined },
): Promise<void> {
  const step = input.onStep ?? (() => {});

  step(`SES configuration set ${SETUP_NAMES.configurationSet}`);
  await ignoring(
    clients.ses.send(
      new DeleteConfigurationSetCommand({ ConfigurationSetName: SETUP_NAMES.configurationSet }),
    ),
    ["NotFoundException"],
  );

  step(`SNS topic ${SETUP_NAMES.topic}`);
  await ignoring(
    clients.sns.send(
      new DeleteTopicCommand({ TopicArn: setupTopicArn(input.region, input.accountId) }),
    ),
    ["NotFoundException"],
  );

  step(`IAM user ${SETUP_NAMES.user}`);
  let keys: ListAccessKeysCommandOutput | null = null;
  try {
    keys = (await clients.iam.send(
      new ListAccessKeysCommand({ UserName: SETUP_NAMES.user }),
    )) as ListAccessKeysCommandOutput;
  } catch (error) {
    if (errorName(error) !== "NoSuchEntityException") throw error;
  }
  for (const key of keys?.AccessKeyMetadata ?? []) {
    if (!key.AccessKeyId) continue;
    await clients.iam.send(
      new DeleteAccessKeyCommand({ UserName: SETUP_NAMES.user, AccessKeyId: key.AccessKeyId }),
    );
  }
  await ignoring(
    clients.iam.send(
      new DetachUserPolicyCommand({
        UserName: SETUP_NAMES.user,
        PolicyArn: setupPolicyArn(input.accountId),
      }),
    ),
    ["NoSuchEntityException"],
  );
  await ignoring(clients.iam.send(new DeleteUserCommand({ UserName: SETUP_NAMES.user })), [
    "NoSuchEntityException",
  ]);

  step(`IAM policy ${SETUP_NAMES.policy}`);
  await ignoring(
    clients.iam.send(new DeletePolicyCommand({ PolicyArn: setupPolicyArn(input.accountId) })),
    ["NoSuchEntityException"],
  );
}

/** The .env entries a setup run produces, in the order they should print. */
export function setupEnvEntries(region: string, result: SetupResult): Record<string, string> {
  const entries: Record<string, string> = {
    AWS_REGION: region,
    AWS_ACCESS_KEY_ID: result.accessKeyId,
    AWS_SECRET_ACCESS_KEY: result.secretAccessKey,
  };
  if (result.topicArn) {
    entries.SNS_TOPIC_ARNS = result.topicArn;
    entries.SES_CONFIGURATION_SET = SETUP_NAMES.configurationSet;
  }
  return entries;
}

/**
 * Rewrites `KEY=...` lines in a dotenv file, appending keys it does not have
 * yet. Matching tolerates the dotenv variants a hand-edited file accumulates —
 * leading whitespace, `export `, spaces around `=`, an empty value — so an
 * existing line is always replaced in place instead of duplicated at the end.
 * The first occurrence of a key wins; later duplicates of a managed key are
 * removed. Comments and unmanaged lines pass through untouched.
 */
export function upsertEnv(content: string, entries: Record<string, string>): string {
  const wanted = new Map(Object.entries(entries));
  const replaced = new Set<string>();
  const out: string[] = [];
  for (const line of content.split("\n")) {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    const value = key === undefined ? undefined : wanted.get(key);
    if (key === undefined || value === undefined) {
      out.push(line);
    } else if (!replaced.has(key)) {
      replaced.add(key);
      out.push(`${key}=${value}`);
    }
  }
  const missing = [...wanted].filter(([key]) => !replaced.has(key));
  if (missing.length > 0) {
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    for (const [key, value] of missing) out.push(`${key}=${value}`);
    out.push("");
  }
  return out.join("\n");
}
