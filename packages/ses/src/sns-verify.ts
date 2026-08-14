import { createVerify, X509Certificate } from "node:crypto";

/**
 * Cryptographic verification of SNS messages. Everything arriving at the
 * ingestion endpoint is untrusted input: without this, anyone who learns the
 * URL can inject fake delivery/bounce events (the vulnerability useSend
 * shipped with). Verification steps, all mandatory:
 *   1. SigningCertURL must be HTTPS on an sns.<region>.amazonaws.com host
 *      with a .pem path — never fetch an attacker-supplied cert location.
 *   2. TopicArn must be in the deployment's allowlist.
 *   3. The RSA signature over the canonical string must validate against the
 *      certificate's public key (SignatureVersion 1 = SHA1, 2 = SHA256).
 */

export interface SnsMessage {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
}

export type CertFetcher = (url: string) => Promise<string>;

const CERT_HOST_PATTERN = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

export function isAllowedCertUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    CERT_HOST_PATTERN.test(url.hostname) &&
    url.pathname.endsWith(".pem")
  );
}

const NOTIFICATION_FIELDS = [
  "Message",
  "MessageId",
  "Subject",
  "Timestamp",
  "TopicArn",
  "Type",
] as const;
const CONFIRMATION_FIELDS = [
  "Message",
  "MessageId",
  "SubscribeURL",
  "Timestamp",
  "Token",
  "TopicArn",
  "Type",
] as const;

function canonicalString(msg: SnsMessage): string {
  const fields = msg.Type === "Notification" ? NOTIFICATION_FIELDS : CONFIRMATION_FIELDS;
  let out = "";
  for (const field of fields) {
    const value = msg[field as keyof SnsMessage];
    if (value !== undefined) out += `${field}\n${value}\n`;
  }
  return out;
}

export interface VerifyOptions {
  fetchCert: CertFetcher;
  allowedTopicArns: readonly string[];
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export async function verifySnsMessage(
  msg: SnsMessage,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  if (!["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"].includes(msg.Type)) {
    return { ok: false, reason: "unsupported message type" };
  }
  if (!opts.allowedTopicArns.includes(msg.TopicArn)) {
    return { ok: false, reason: "topic not in allowlist" };
  }
  if (!isAllowedCertUrl(msg.SigningCertURL)) {
    return { ok: false, reason: "signing cert URL rejected" };
  }
  if (msg.SignatureVersion !== "1" && msg.SignatureVersion !== "2") {
    return { ok: false, reason: `unsupported signature version ${msg.SignatureVersion}` };
  }
  let publicKey: ReturnType<X509Certificate["publicKey"]["export"]> | string;
  try {
    const pem = await opts.fetchCert(msg.SigningCertURL);
    publicKey = new X509Certificate(pem).publicKey.export({ type: "spki", format: "pem" });
  } catch {
    return { ok: false, reason: "signing cert unavailable or invalid" };
  }
  const algorithm = msg.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
  try {
    const verifier = createVerify(algorithm);
    verifier.update(canonicalString(msg), "utf8");
    const valid = verifier.verify(publicKey.toString(), msg.Signature, "base64");
    return valid ? { ok: true } : { ok: false, reason: "signature mismatch" };
  } catch {
    return { ok: false, reason: "signature verification failed" };
  }
}

/** Default HTTPS fetcher with an in-process cache (certs are immutable). */
export function createCachingCertFetcher(): CertFetcher {
  const cache = new Map<string, string>();
  return async (url: string) => {
    const hit = cache.get(url);
    if (hit) return hit;
    // isAllowedCertUrl gates callers before this runs; re-check defensively.
    if (!isAllowedCertUrl(url)) throw new Error("cert URL rejected");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`cert fetch failed: ${res.status}`);
    const pem = await res.text();
    cache.set(url, pem);
    return pem;
  };
}
