import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalString,
  createCachingCertFetcher,
  isAllowedCertUrl,
  type SnsMessage,
  verifySnsMessage,
} from "../src/sns-verify.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const KEY = readFileSync(join(fixtures, "sns-test-key.pem"), "utf8");
const CERT = readFileSync(join(fixtures, "sns-test-cert.pem"), "utf8");

const TOPIC = "arn:aws:sns:us-east-1:123456789012:millionsend-events";
const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem";

function sign(msg: Omit<SnsMessage, "Signature">): SnsMessage {
  const signer = createSign(msg.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1");
  signer.update(canonicalString(msg), "utf8");
  return { ...msg, Signature: signer.sign(KEY, "base64") };
}

function baseNotification(): Omit<SnsMessage, "Signature"> {
  return {
    Type: "Notification",
    MessageId: "mid-1",
    TopicArn: TOPIC,
    Message: JSON.stringify({ eventType: "Delivery" }),
    Timestamp: new Date().toISOString(),
    SignatureVersion: "2",
    SigningCertURL: CERT_URL,
  };
}

const opts = { fetchCert: async () => CERT, allowedTopicArns: [TOPIC] };

describe("cert URL allowlist", () => {
  it("accepts only https sns.<region>.amazonaws.com .pem URLs", () => {
    expect(isAllowedCertUrl(CERT_URL)).toBe(true);
    expect(isAllowedCertUrl("http://sns.us-east-1.amazonaws.com/x.pem")).toBe(false);
    expect(isAllowedCertUrl("https://sns.us-east-1.amazonaws.com.evil.io/x.pem")).toBe(false);
    expect(isAllowedCertUrl("https://evil.io/sns.us-east-1.amazonaws.com/x.pem")).toBe(false);
    expect(isAllowedCertUrl("https://sns.us-east-1.amazonaws.com/x.txt")).toBe(false);
  });
});

describe("verifySnsMessage", () => {
  it("accepts a correctly signed notification (SHA256)", async () => {
    const result = await verifySnsMessage(sign(baseNotification()), opts);
    expect(result).toEqual({ ok: true });
  });

  it("accepts SignatureVersion 1 (SHA1) signatures", async () => {
    const result = await verifySnsMessage(
      sign({ ...baseNotification(), SignatureVersion: "1" }),
      opts,
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects any field tampered after signing", async () => {
    const signed = sign(baseNotification());
    const tampered = { ...signed, Message: JSON.stringify({ eventType: "Bounce" }) };
    const result = await verifySnsMessage(tampered, opts);
    expect(result).toMatchObject({ ok: false, reason: "signature mismatch" });
  });

  it("rejects unlisted topics even with a valid signature", async () => {
    const other = sign({ ...baseNotification(), TopicArn: "arn:aws:sns:us-east-1:1:evil" });
    const result = await verifySnsMessage(other, {
      ...opts,
      allowedTopicArns: [TOPIC],
    });
    expect(result).toMatchObject({ ok: false, reason: "topic not in allowlist" });
  });

  it("never fetches an attacker-controlled cert URL", async () => {
    let fetched = false;
    const msg = sign({ ...baseNotification(), SigningCertURL: "https://evil.io/cert.pem" });
    const result = await verifySnsMessage(msg, {
      allowedTopicArns: [TOPIC],
      fetchCert: async () => {
        fetched = true;
        return CERT;
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "signing cert URL rejected" });
    expect(fetched).toBe(false);
  });

  it("verifies subscription confirmations over their own canonical fields", async () => {
    const confirmation = sign({
      Type: "SubscriptionConfirmation",
      MessageId: "mid-2",
      TopicArn: TOPIC,
      Message: "You have chosen to subscribe...",
      Timestamp: new Date().toISOString(),
      SignatureVersion: "2",
      SigningCertURL: CERT_URL,
      Token: "tok-123",
      SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription",
    });
    expect(await verifySnsMessage(confirmation, opts)).toEqual({ ok: true });
    const tampered = { ...confirmation, Token: "tok-hijacked" };
    expect(await verifySnsMessage(tampered, opts)).toMatchObject({ ok: false });
  });

  it("rejects a Timestamp missing or more than 15 minutes from now", async () => {
    const stale = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 16 * 60 * 1000).toISOString();
    for (const Timestamp of [stale, future, "not-a-date"]) {
      const result = await verifySnsMessage(sign({ ...baseNotification(), Timestamp }), opts);
      expect(result).toMatchObject({ ok: false, reason: /freshness/ });
    }
    const recent = new Date(Date.now() - 14 * 60 * 1000).toISOString();
    expect(
      await verifySnsMessage(sign({ ...baseNotification(), Timestamp: recent }), opts),
    ).toEqual({ ok: true });
  });

  it("rejects unknown signature versions", async () => {
    const msg = sign(baseNotification());
    const result = await verifySnsMessage({ ...msg, SignatureVersion: "3" }, opts);
    expect(result).toMatchObject({ ok: false, reason: /unsupported signature version/ });
  });
});

describe("createCachingCertFetcher", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("caches by origin + path so a varying query string cannot grow the cache", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      return new Response(CERT, { status: 200 });
    });
    const fetchCert = createCachingCertFetcher();
    expect(await fetchCert(`${CERT_URL}?a=1`)).toBe(CERT);
    expect(await fetchCert(`${CERT_URL}?b=2`)).toBe(CERT);
    expect(fetched).toEqual([CERT_URL]);
  });
});
