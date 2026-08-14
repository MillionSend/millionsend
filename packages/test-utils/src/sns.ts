import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The committed TEST-ONLY keypair lives with the ses package's own suite.
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../ses/test/fixtures");

export const SNS_TEST_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:millionsend-events";
export const SNS_TEST_CERT_URL =
  "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem";

export function snsTestCertPem(): string {
  return readFileSync(join(fixturesDir, "sns-test-cert.pem"), "utf8");
}

/** Structural twin of @millionsend/ses's SnsMessage minus the Signature. */
export interface UnsignedSnsMessage {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  SigningCertURL: string;
  Subject?: string | undefined;
  Token?: string | undefined;
  SubscribeURL?: string | undefined;
}

/**
 * Signs over the same canonical string SNS uses (field set depends on Type),
 * with the fixture private key — verifiable against snsTestCertPem().
 */
export function signSnsMessage<T extends UnsignedSnsMessage>(msg: T): T & { Signature: string } {
  const fields =
    msg.Type === "Notification"
      ? (["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const)
      : ([
          "Message",
          "MessageId",
          "SubscribeURL",
          "Timestamp",
          "Token",
          "TopicArn",
          "Type",
        ] as const);
  let canonical = "";
  for (const field of fields) {
    const value = msg[field as keyof UnsignedSnsMessage];
    if (value !== undefined) canonical += `${field}\n${value}\n`;
  }
  const signer = createSign(msg.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1");
  signer.update(canonical, "utf8");
  const key = readFileSync(join(fixturesDir, "sns-test-key.pem"), "utf8");
  return { ...msg, Signature: signer.sign(key, "base64") };
}
