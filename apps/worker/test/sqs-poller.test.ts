import {
  DeleteMessageBatchCommand,
  type Message,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import type { SerializedSesEvent } from "@millionsend/queue";
import { describe, expect, it } from "vitest";
import { pollSqsOnce, type SqsPollerDeps } from "../src/sqs-poller.js";

const TOPIC = "arn:aws:sns:us-east-1:123456789012:millionsend-events";

function envelope(overrides: Partial<Record<string, string>> = {}): string {
  return JSON.stringify({
    Type: "Notification",
    MessageId: "sns-msg-1",
    TopicArn: TOPIC,
    Message: JSON.stringify({
      eventType: "Delivery",
      mail: { messageId: "ses-1", timestamp: "2026-08-16T12:00:00.000Z" },
      delivery: { timestamp: "2026-08-16T12:00:01.000Z", smtpResponse: "250 ok" },
    }),
    Timestamp: "2026-08-16T12:00:01.100Z",
    SignatureVersion: "1",
    Signature: "sig",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    ...overrides,
  });
}

function fakeDeps(messages: Message[], options: { enqueueError?: Error } = {}) {
  const enqueued: Array<{ event: SerializedSesEvent; snsMessageId: string }> = [];
  const deleted: string[] = [];
  const deps: SqsPollerDeps = {
    sqs: {
      send: async (command) => {
        if (command instanceof ReceiveMessageCommand) return { Messages: messages };
        if (command instanceof DeleteMessageBatchCommand) {
          for (const entry of command.input.Entries ?? []) deleted.push(entry.Id as string);
        }
        return {};
      },
    },
    queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/millionsend-events",
    allowedTopicArns: [TOPIC],
    enqueueSesEvent: async (event, snsMessageId) => {
      if (options.enqueueError) throw options.enqueueError;
      enqueued.push({ event, snsMessageId });
    },
    log: () => {},
  };
  return { deps, enqueued, deleted };
}

describe("pollSqsOnce", () => {
  it("enqueues a valid SES event under its SNS MessageId and deletes the message", async () => {
    const { deps, enqueued, deleted } = fakeDeps([
      { MessageId: "sqs-1", ReceiptHandle: "rh-1", Body: envelope() },
    ]);
    expect(await pollSqsOnce(deps, 0)).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.snsMessageId).toBe("sns-msg-1");
    expect(enqueued[0]?.event.eventType).toBe("Delivery");
    expect(enqueued[0]?.event.occurredAt).toBe("2026-08-16T12:00:01.000Z");
    expect(deleted).toEqual(["sqs-1"]);
  });

  it("drops (and deletes) foreign-topic and malformed messages without enqueueing", async () => {
    const { deps, enqueued, deleted } = fakeDeps([
      {
        MessageId: "sqs-foreign",
        ReceiptHandle: "rh-1",
        Body: envelope({ TopicArn: "arn:aws:sns:us-east-1:999999999999:evil" }),
      },
      { MessageId: "sqs-garbage", ReceiptHandle: "rh-2", Body: "not json" },
      { MessageId: "sqs-inner", ReceiptHandle: "rh-3", Body: envelope({ Message: "not json" }) },
    ]);
    expect(await pollSqsOnce(deps, 0)).toBe(3);
    expect(enqueued).toHaveLength(0);
    expect(deleted).toEqual(["sqs-foreign", "sqs-garbage", "sqs-inner"]);
  });

  it("keeps the message on the queue when enqueueing fails", async () => {
    const { deps, enqueued, deleted } = fakeDeps(
      [{ MessageId: "sqs-1", ReceiptHandle: "rh-1", Body: envelope() }],
      { enqueueError: new Error("db down") },
    );
    expect(await pollSqsOnce(deps, 0)).toBe(1);
    expect(enqueued).toHaveLength(0);
    expect(deleted).toEqual([]);
  });

  it("returns 0 and deletes nothing on an empty receive", async () => {
    const { deps, deleted } = fakeDeps([]);
    expect(await pollSqsOnce(deps, 0)).toBe(0);
    expect(deleted).toEqual([]);
  });
});
