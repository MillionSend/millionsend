import {
  AttachUserPolicyCommand,
  CreateAccessKeyCommand,
  CreatePolicyCommand,
  CreateUserCommand,
  DeleteAccessKeyCommand,
  DeletePolicyCommand,
  DeleteUserCommand,
  DetachUserPolicyCommand,
  ListAccessKeysCommand,
} from "@aws-sdk/client-iam";
import { CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  DeleteConfigurationSetCommand,
} from "@aws-sdk/client-sesv2";
import {
  CreateTopicCommand,
  DeleteTopicCommand,
  SetTopicAttributesCommand,
  SubscribeCommand,
} from "@aws-sdk/client-sns";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";
import {
  ensureBucket,
  httpsOrigin,
  runEventsSetup,
  runSetup,
  runTeardown,
  type SetupClients,
  type StorageClient,
  setupEnvEntries,
  setupPlan,
  storageEnvEntries,
  upsertEnv,
} from "../src/setup.js";

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

/**
 * One fake for all three clients: records every command and answers by
 * command type. `errors` maps a command constructor name to the error its
 * send should throw (for already-exists / not-found reruns).
 */
function fakeClients(options: { errors?: Record<string, Error>; accessKeys?: string[] } = {}) {
  const calls: object[] = [];
  const send = async (command: object): Promise<unknown> => {
    calls.push(command);
    const error = options.errors?.[command.constructor.name];
    if (error) throw error;
    if (command instanceof CreateAccessKeyCommand) {
      return { AccessKey: { AccessKeyId: "AKIATEST", SecretAccessKey: "secret123" } };
    }
    if (command instanceof CreateTopicCommand) {
      return { TopicArn: "arn:aws:sns:us-east-1:123456789012:millionsend-events" };
    }
    if (command instanceof CreateQueueCommand || command instanceof GetQueueUrlCommand) {
      return { QueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/millionsend-events" };
    }
    if (command instanceof GetQueueAttributesCommand) {
      return { Attributes: { QueueArn: "arn:aws:sqs:us-east-1:123456789012:millionsend-events" } };
    }
    if (command instanceof ListAccessKeysCommand) {
      return {
        AccessKeyMetadata: (options.accessKeys ?? []).map((id) => ({ AccessKeyId: id })),
      };
    }
    return {};
  };
  const clients: SetupClients = { iam: { send }, sns: { send }, sqs: { send }, ses: { send } };
  return { clients, calls };
}

const input = {
  region: "us-east-1",
  accountId: "123456789012",
  appBaseUrl: "https://mail.example.com",
};

describe("httpsOrigin", () => {
  it("reduces a valid https URL to its origin", () => {
    expect(httpsOrigin("https://mail.example.com/some/path?q=1")).toBe("https://mail.example.com");
  });

  it("rejects http, garbage, and empty input", () => {
    expect(httpsOrigin("http://mail.example.com")).toBeNull();
    expect(httpsOrigin("not a url")).toBeNull();
    expect(httpsOrigin("")).toBeNull();
    expect(httpsOrigin(null)).toBeNull();
  });
});

describe("setupPlan", () => {
  it("routes events to https or the SQS queue depending on appBaseUrl", () => {
    expect(setupPlan(input).join("\n")).toContain("subscribed to https://mail.example.com");
    const viaQueue = setupPlan({ region: "us-east-1", appBaseUrl: "http://x" }).join("\n");
    expect(viaQueue).toContain("delivering to SQS queue millionsend-events");
    expect(viaQueue).toContain("SES configuration set millionsend");
  });
});

describe("runSetup", () => {
  it("creates policy, user, key, topic, subscription, and configuration set", async () => {
    const { clients, calls } = fakeClients();
    const result = await runSetup(clients, input);
    expect(result).toEqual({
      accessKeyId: "AKIATEST",
      secretAccessKey: "secret123",
      topicArn: "arn:aws:sns:us-east-1:123456789012:millionsend-events",
      queueUrl: null,
    });
    expect(calls.map((c) => c.constructor)).toEqual([
      CreatePolicyCommand,
      CreateUserCommand,
      AttachUserPolicyCommand,
      CreateAccessKeyCommand,
      CreateTopicCommand,
      SetTopicAttributesCommand,
      SubscribeCommand,
      CreateConfigurationSetCommand,
      CreateConfigurationSetEventDestinationCommand,
    ]);
    const subscribe = calls.find((c) => c instanceof SubscribeCommand) as SubscribeCommand;
    expect(subscribe.input.Endpoint).toBe("https://mail.example.com/ses/events");
    const attach = calls.find(
      (c) => c instanceof AttachUserPolicyCommand,
    ) as AttachUserPolicyCommand;
    expect(attach.input.PolicyArn).toBe("arn:aws:iam::123456789012:policy/millionsend-ses");
  });

  it("creates the SQS events queue instead of an https subscription without https", async () => {
    const { clients, calls } = fakeClients();
    const result = await runSetup(clients, { ...input, appBaseUrl: null });
    expect(result.topicArn).toBe("arn:aws:sns:us-east-1:123456789012:millionsend-events");
    expect(result.queueUrl).toBe(
      "https://sqs.us-east-1.amazonaws.com/123456789012/millionsend-events",
    );
    expect(calls.map((c) => c.constructor)).toEqual([
      CreatePolicyCommand,
      CreateUserCommand,
      AttachUserPolicyCommand,
      CreateAccessKeyCommand,
      CreateTopicCommand,
      SetTopicAttributesCommand,
      CreateQueueCommand,
      GetQueueAttributesCommand,
      SetQueueAttributesCommand,
      SubscribeCommand,
      CreateConfigurationSetCommand,
      CreateConfigurationSetEventDestinationCommand,
    ]);
    const subscribe = calls.find((c) => c instanceof SubscribeCommand) as SubscribeCommand;
    expect(subscribe.input.Protocol).toBe("sqs");
    expect(subscribe.input.Endpoint).toBe("arn:aws:sqs:us-east-1:123456789012:millionsend-events");
    const policy = calls.find(
      (c) => c instanceof SetQueueAttributesCommand,
    ) as SetQueueAttributesCommand;
    const doc = JSON.parse(policy.input.Attributes?.Policy ?? "{}") as {
      Statement: Array<{ Principal: Record<string, string> }>;
    };
    expect(doc.Statement[0]?.Principal).toEqual({ Service: "sns.amazonaws.com" });
    expect(doc.Statement[1]?.Principal).toEqual({
      AWS: "arn:aws:iam::123456789012:user/millionsend",
    });
  });

  it("runEventsSetup provisions events without touching IAM", async () => {
    const { clients, calls } = fakeClients();
    const result = await runEventsSetup(clients, { ...input, appBaseUrl: null });
    expect(result).toEqual({
      topicArn: "arn:aws:sns:us-east-1:123456789012:millionsend-events",
      queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/millionsend-events",
    });
    expect(calls.some((c) => c instanceof CreatePolicyCommand)).toBe(false);
    expect(calls.some((c) => c instanceof CreateAccessKeyCommand)).toBe(false);
    expect(calls.some((c) => c instanceof CreateConfigurationSetCommand)).toBe(true);
  });

  it("adopts an existing queue when CreateQueue reports a name conflict", async () => {
    const { clients, calls } = fakeClients({
      errors: { CreateQueueCommand: namedError("QueueNameExists") },
    });
    const result = await runSetup(clients, { ...input, appBaseUrl: null });
    expect(result.queueUrl).toBe(
      "https://sqs.us-east-1.amazonaws.com/123456789012/millionsend-events",
    );
    expect(calls.some((c) => c instanceof GetQueueUrlCommand)).toBe(true);
  });

  it("tolerates already-existing resources on a rerun", async () => {
    const { clients } = fakeClients({
      errors: {
        CreatePolicyCommand: namedError("EntityAlreadyExistsException"),
        CreateUserCommand: namedError("EntityAlreadyExistsException"),
        CreateConfigurationSetCommand: namedError("AlreadyExistsException"),
        CreateConfigurationSetEventDestinationCommand: namedError("AlreadyExistsException"),
      },
    });
    const result = await runSetup(clients, input);
    expect(result.accessKeyId).toBe("AKIATEST");
  });

  it("maps the 2-key IAM limit to an actionable error", async () => {
    const { clients } = fakeClients({
      errors: { CreateAccessKeyCommand: namedError("LimitExceededException") },
    });
    await expect(runSetup(clients, input)).rejects.toThrow(/2 access keys/);
  });

  it("propagates unexpected errors", async () => {
    const { clients } = fakeClients({
      errors: { CreatePolicyCommand: namedError("AccessDeniedException") },
    });
    await expect(runSetup(clients, input)).rejects.toThrow("AccessDeniedException");
  });
});

describe("runTeardown", () => {
  it("deletes the configuration set, topic, keys, user, and policy", async () => {
    const { clients, calls } = fakeClients({ accessKeys: ["AKIAOLD", "AKIANEW"] });
    await runTeardown(clients, { region: "us-east-1", accountId: "123456789012" });
    expect(calls.map((c) => c.constructor)).toEqual([
      DeleteConfigurationSetCommand,
      DeleteTopicCommand,
      GetQueueUrlCommand,
      DeleteQueueCommand,
      ListAccessKeysCommand,
      DeleteAccessKeyCommand,
      DeleteAccessKeyCommand,
      DetachUserPolicyCommand,
      DeleteUserCommand,
      DeletePolicyCommand,
    ]);
    const topic = calls.find((c) => c instanceof DeleteTopicCommand) as DeleteTopicCommand;
    expect(topic.input.TopicArn).toBe("arn:aws:sns:us-east-1:123456789012:millionsend-events");
  });

  it("tolerates resources that are already gone", async () => {
    const { clients, calls } = fakeClients({
      errors: {
        DeleteConfigurationSetCommand: namedError("NotFoundException"),
        GetQueueUrlCommand: namedError("QueueDoesNotExist"),
        ListAccessKeysCommand: namedError("NoSuchEntityException"),
        DetachUserPolicyCommand: namedError("NoSuchEntityException"),
        DeleteUserCommand: namedError("NoSuchEntityException"),
        DeletePolicyCommand: namedError("NoSuchEntityException"),
      },
    });
    await runTeardown(clients, { region: "us-east-1", accountId: "123456789012" });
    // A missing user skips key deletion instead of failing.
    expect(calls.some((c) => c instanceof DeleteAccessKeyCommand)).toBe(false);
  });
});

describe("setupEnvEntries / upsertEnv", () => {
  it("emits event keys only when a topic was created", () => {
    const base = { accessKeyId: "id", secretAccessKey: "secret", topicArn: null, queueUrl: null };
    expect(Object.keys(setupEnvEntries("us-east-1", base))).toEqual([
      "AWS_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ]);
    expect(setupEnvEntries("us-east-1", { ...base, topicArn: "arn:x" })).toMatchObject({
      SNS_TOPIC_ARNS: "arn:x",
      SES_CONFIGURATION_SET: "millionsend",
    });
    expect(
      setupEnvEntries("us-east-1", { ...base, topicArn: "arn:x", queueUrl: "https://sqs/q" }),
    ).toMatchObject({ SQS_QUEUE_URL: "https://sqs/q" });
  });

  it("replaces existing lines and appends missing ones", () => {
    const content = "DATABASE_URL=postgres://x\nAWS_REGION=eu-west-1\n";
    const next = upsertEnv(content, { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIA" });
    expect(next).toBe("DATABASE_URL=postgres://x\nAWS_REGION=us-east-1\nAWS_ACCESS_KEY_ID=AKIA\n");
  });

  it("does not touch commented or prefixed keys", () => {
    const content = "# AWS_REGION=old\nAWS_REGION_EXTRA=keep\n";
    const next = upsertEnv(content, { AWS_REGION: "us-east-1" });
    expect(next).toBe("# AWS_REGION=old\nAWS_REGION_EXTRA=keep\nAWS_REGION=us-east-1\n");
  });

  it("replaces an empty-value line in place instead of appending", () => {
    const content = "AWS_REGION=\nDATABASE_URL=postgres://x\n";
    const next = upsertEnv(content, { AWS_REGION: "us-east-1" });
    expect(next).toBe("AWS_REGION=us-east-1\nDATABASE_URL=postgres://x\n");
  });

  it("tolerates whitespace, export, and spaces around =", () => {
    const content = "  export AWS_REGION = eu-west-1\nOTHER=keep\n";
    const next = upsertEnv(content, { AWS_REGION: "us-east-1" });
    expect(next).toBe("AWS_REGION=us-east-1\nOTHER=keep\n");
  });

  it("replaces the first duplicate and removes the rest", () => {
    const content = "AWS_REGION=old\n# note\nAWS_REGION=older\nOTHER=keep\nAWS_REGION=\n";
    const next = upsertEnv(content, { AWS_REGION: "us-east-1" });
    expect(next).toBe("AWS_REGION=us-east-1\n# note\nOTHER=keep\n");
  });
});

function fakeStorageClient(options: { headError?: Error } = {}) {
  const calls: object[] = [];
  const client: StorageClient = {
    send: async (command: object): Promise<unknown> => {
      calls.push(command);
      if (command instanceof HeadBucketCommand && options.headError) throw options.headError;
      return {};
    },
  };
  return { client, calls };
}

describe("ensureBucket", () => {
  it("adopts an existing bucket without creating it", async () => {
    const { client, calls } = fakeStorageClient();
    expect(await ensureBucket(client, "millionsend-storage")).toBe("exists");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeInstanceOf(HeadBucketCommand);
  });

  it("creates the bucket when HeadBucket reports NotFound", async () => {
    const { client, calls } = fakeStorageClient({ headError: namedError("NotFound") });
    expect(await ensureBucket(client, "millionsend-backups")).toBe("created");
    expect(calls[1]).toBeInstanceOf(CreateBucketCommand);
    expect(calls[1]).toMatchObject({ input: { Bucket: "millionsend-backups" } });
  });

  it("creates on a bare 404 with no modeled error name", async () => {
    const error = new Error("404") as Error & { $metadata?: { httpStatusCode?: number } };
    error.$metadata = { httpStatusCode: 404 };
    const { client, calls } = fakeStorageClient({ headError: error });
    expect(await ensureBucket(client, "b")).toBe("created");
    expect(calls[1]).toBeInstanceOf(CreateBucketCommand);
  });

  it("propagates auth/endpoint errors instead of creating", async () => {
    const { client, calls } = fakeStorageClient({ headError: namedError("InvalidAccessKeyId") });
    await expect(ensureBucket(client, "b")).rejects.toThrow("InvalidAccessKeyId");
    expect(calls).toHaveLength(1);
  });
});

describe("storageEnvEntries", () => {
  const credentials = {
    endpoint: "https://acct.r2.cloudflarestorage.com",
    accessKeyId: "key",
    secretAccessKey: "secret",
  };

  it("writes the storage pair together when the public URL is known", () => {
    expect(
      storageEnvEntries({
        credentials,
        backupBucket: "millionsend-backups",
        storageBucket: "millionsend-storage",
        publicUrl: "https://pub.example.com",
      }),
    ).toEqual({
      S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
      S3_ACCESS_KEY_ID: "key",
      S3_SECRET_ACCESS_KEY: "secret",
      S3_BACKUP_BUCKET: "millionsend-backups",
      S3_STORAGE_BUCKET: "millionsend-storage",
      S3_STORAGE_PUBLIC_URL: "https://pub.example.com",
    });
  });

  it("omits the whole storage pair without a public URL — boot rejects a lone bucket", () => {
    expect(
      storageEnvEntries({
        credentials,
        backupBucket: "millionsend-backups",
        storageBucket: "millionsend-storage",
        publicUrl: "",
      }),
    ).toEqual({
      S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
      S3_ACCESS_KEY_ID: "key",
      S3_SECRET_ACCESS_KEY: "secret",
      S3_BACKUP_BUCKET: "millionsend-backups",
    });
  });
});
