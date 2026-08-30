import { createVerify, X509Certificate } from "node:crypto";
import { z } from "zod";

/**
 * Cryptographic verification of SNS messages. Everything arriving at the
 * ingestion endpoint is untrusted input: without this, anyone who learns the
 * URL can inject fake delivery/bounce events (the vulnerability useSend
 * shipped with). Verification steps, all mandatory:
 *   1. SigningCertURL must be HTTPS on an sns.<region>.amazonaws.com host
 *      with a .pem path — never fetch an attacker-supplied cert location.
 *   2. TopicArn must be in the deployment's allowlist.
 *   3. Timestamp must be within 15 minutes of now: a valid signature never
 *      expires on its own, so without this a captured message replays
 *      forever (MessageId dedupe downstream is a backstop, not a gate).
 *   4. The RSA signature over the canonical string must validate against the
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
  Subject?: string | undefined;
  Token?: string | undefined;
  SubscribeURL?: string | undefined;
}

// SNS delivery paths are inconsistent about absent vs null for optional
// fields (SQS/Lambda records carry "Subject": null); both must parse, and
// null normalizes to undefined so canonicalString skips the field exactly
// as AWS did when signing.
const optionalSignedField = z
  .string()
  .nullish()
  .transform((v) => v ?? undefined);

/**
 * Wire shape of an SNS POST body. Lives NEXT TO canonicalString on purpose:
 * any field added to the signed set must change both together, or verified
 * messages would be silently stripped before verification.
 */
export const snsMessageSchema = z.object({
  Type: z.enum(["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"]),
  MessageId: z.string().min(1),
  TopicArn: z.string().min(1),
  Message: z.string(),
  Timestamp: z.string(),
  SignatureVersion: z.string(),
  Signature: z.string().min(1),
  SigningCertURL: z.string(),
  Subject: optionalSignedField,
  Token: optionalSignedField,
  SubscribeURL: optionalSignedField,
});

export type CertFetcher = (url: string) => Promise<string>;

const SNS_HOST_PATTERN = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

/**
 * HTTPS URL on a real sns.<region>.amazonaws.com host. Gate for every URL a
 * message asks us to fetch (SubscribeURL confirmation included) — otherwise a
 * forged message turns the server into an SSRF proxy.
 */
export function isAllowedSnsUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return url.protocol === "https:" && SNS_HOST_PATTERN.test(url.hostname);
}

export function isAllowedCertUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    SNS_HOST_PATTERN.test(url.hostname) &&
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

/** The exact string SNS signs; exported so test signers cannot drift from it. */
export function canonicalString(msg: Omit<SnsMessage, "Signature">): string {
  const fields = msg.Type === "Notification" ? NOTIFICATION_FIELDS : CONFIRMATION_FIELDS;
  let out = "";
  for (const field of fields) {
    const value = msg[field as keyof Omit<SnsMessage, "Signature">];
    if (value !== undefined) out += `${field}\n${value}\n`;
  }
  return out;
}

export interface VerifyOptions {
  fetchCert: CertFetcher;
  allowedTopicArns: readonly string[];
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

const MAX_TIMESTAMP_SKEW_MS = 15 * 60 * 1000;

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
  const sentAt = Date.parse(msg.Timestamp);
  if (Number.isNaN(sentAt) || Math.abs(Date.now() - sentAt) > MAX_TIMESTAMP_SKEW_MS) {
    return { ok: false, reason: "timestamp missing or outside the freshness window" };
  }
  if (!isAllowedCertUrl(msg.SigningCertURL)) {
    return { ok: false, reason: "signing cert URL rejected" };
  }
  if (msg.SignatureVersion !== "1" && msg.SignatureVersion !== "2") {
    return { ok: false, reason: `unsupported signature version ${msg.SignatureVersion}` };
  }
  let publicKey: string;
  try {
    const pem = await opts.fetchCert(msg.SigningCertURL);
    publicKey = new X509Certificate(pem).publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
  } catch {
    return { ok: false, reason: "signing cert unavailable or invalid" };
  }
  const algorithm = msg.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
  try {
    const verifier = createVerify(algorithm);
    verifier.update(canonicalString(msg), "utf8");
    const valid = verifier.verify(publicKey, msg.Signature, "base64");
    return valid ? { ok: true } : { ok: false, reason: "signature mismatch" };
  } catch {
    return { ok: false, reason: "signature verification failed" };
  }
}

/** Default HTTPS fetcher with an in-process cache (certs are immutable). */
export function createCachingCertFetcher(): CertFetcher {
  const cache = new Map<string, string>();
  return async (rawUrl: string) => {
    // isAllowedCertUrl gates callers before this runs; re-check defensively.
    if (!isAllowedCertUrl(rawUrl)) throw new Error("cert URL rejected");
    // Query/fragment dropped: the cert lives at the path, and a per-message
    // random query string would otherwise grow the cache without bound.
    const parsed = new URL(rawUrl);
    const url = `${parsed.origin}${parsed.pathname}`;
    const hit = cache.get(url);
    if (hit) return hit;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`cert fetch failed: ${res.status}`);
    const pem = await res.text();
    cache.set(url, pem);
    return pem;
  };
}
