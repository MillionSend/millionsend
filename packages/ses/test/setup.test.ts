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
import { describe, expect, it } from "vitest";
import {
  httpsOrigin,
  runSetup,
  runTeardown,
  type SetupClients,
  setupEnvEntries,
  setupPlan,
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
    if (command instanceof ListAccessKeysCommand) {
      return {
        AccessKeyMetadata: (options.accessKeys ?? []).map((id) => ({ AccessKeyId: id })),
      };
    }
    return {};
  };
  const clients: SetupClients = { iam: { send }, sns: { send }, ses: { send } };
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
  it("includes the events resources only for an https appBaseUrl", () => {
    expect(setupPlan(input).join("\n")).toContain("SNS topic millionsend-events");
    const withoutEvents = setupPlan({ region: "us-east-1", appBaseUrl: "http://x" }).join("\n");
    expect(withoutEvents).not.toContain("SNS topic");
    expect(withoutEvents).toContain("events skipped");
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

  it("skips the events part without an https appBaseUrl", async () => {
    const { clients, calls } = fakeClients();
    const result = await runSetup(clients, { ...input, appBaseUrl: null });
    expect(result.topicArn).toBeNull();
    expect(calls.some((c) => c instanceof CreateTopicCommand)).toBe(false);
    expect(calls.some((c) => c instanceof CreateConfigurationSetCommand)).toBe(false);
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
    const base = { accessKeyId: "id", secretAccessKey: "secret", topicArn: null };
    expect(Object.keys(setupEnvEntries("us-east-1", base))).toEqual([
      "AWS_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ]);
    expect(setupEnvEntries("us-east-1", { ...base, topicArn: "arn:x" })).toMatchObject({
      SNS_TOPIC_ARNS: "arn:x",
      SES_CONFIGURATION_SET: "millionsend",
    });
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
});
