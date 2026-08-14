import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalString, type SnsMessage } from "@millionsend/ses";

// The committed TEST-ONLY keypair lives with the ses package's own suite.
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../ses/test/fixtures");

export const SNS_TEST_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:millionsend-events";
export const SNS_TEST_CERT_URL =
  "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem";

export function snsTestCertPem(): string {
  return readFileSync(join(fixturesDir, "sns-test-cert.pem"), "utf8");
}

export type UnsignedSnsMessage = Omit<SnsMessage, "Signature">;

/**
 * Signs with the fixture private key over the SAME canonicalString the
 * verifier uses — the signer cannot drift from the verification code.
 */
export function signSnsMessage<T extends UnsignedSnsMessage>(msg: T): T & { Signature: string } {
  const signer = createSign(msg.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1");
  signer.update(canonicalString(msg), "utf8");
  const key = readFileSync(join(fixturesDir, "sns-test-key.pem"), "utf8");
  return { ...msg, Signature: signer.sign(key, "base64") };
}
