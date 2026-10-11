import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Self-authenticating download links for received mail: `raw.download_url`
 * and an attachment's `download_url`. Resend's SDK fetches the raw message
 * with a plain fetch() and no Authorization header (emails.receiving.forward),
 * so the URL itself is the credential, served outside the /emails/* API-key
 * routes. The signature covers team, email, attachment (or "raw") and expiry,
 * keyed by an HKDF derivation of the master key like the tracking tokens, so
 * the KEK never signs anything itself.
 */

const HKDF_INFO = "millionsend:receiving-download:v1";

export const RECEIVED_DOWNLOAD_TTL_MS = 60 * 60 * 1000;

/** GET {RECEIVED_RAW_PATH}/{emailId}?expires=&signature= on the API host. */
export const RECEIVED_RAW_PATH = "/receiving/raw";
/** GET {RECEIVED_ATTACHMENT_PATH}/{emailId}/{attachmentId}?expires=&signature= on the API host. */
export const RECEIVED_ATTACHMENT_PATH = "/receiving/attachments";

/** Clock skew tolerated between the signer and the verifier. */
const SKEW_MS = 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function deriveReceivedDownloadKey(masterKey: Buffer): Buffer {
  if (masterKey.length < 16) throw new Error("master key too short to derive from");
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), HKDF_INFO, 32));
}

/** Where a download is signed for: the key, and the API's public origin (no trailing slash). */
export interface DownloadSigning {
  key: Buffer;
  baseUrl: string;
  now?: Date | undefined;
}

export interface SignedDownload {
  url: string;
  expiresAt: Date;
}

interface DownloadTarget {
  teamId: string;
  emailId: string;
  /** Omitted for the raw message. */
  attachmentId?: string | undefined;
}

function mac(key: Buffer, target: DownloadTarget, expires: string): string {
  return createHmac("sha256", key)
    .update(`${target.teamId}\n${target.emailId}\n${target.attachmentId ?? "raw"}\n${expires}`)
    .digest("base64url");
}

export function signReceivedDownload(params: DownloadSigning & DownloadTarget): SignedDownload {
  const now = params.now ?? new Date();
  const expiresAt = new Date(Math.floor((now.getTime() + RECEIVED_DOWNLOAD_TTL_MS) / 1000) * 1000);
  const expires = String(expiresAt.getTime() / 1000);
  const path = params.attachmentId
    ? `${RECEIVED_ATTACHMENT_PATH}/${params.emailId}/${params.attachmentId}`
    : `${RECEIVED_RAW_PATH}/${params.emailId}`;
  const query = new URLSearchParams({ expires, signature: mac(params.key, params, expires) });
  return { url: `${params.baseUrl.replace(/\/+$/, "")}${path}?${query}`, expiresAt };
}

/**
 * Whether a download request is one this deployment signed, for this team,
 * email and attachment, and still inside its hour. The team comes from the
 * stored row, never from the request. Ids must be canonical lowercase uuids,
 * so nothing path-like ever reaches a lookup.
 */
export function verifyReceivedDownload(
  params: DownloadTarget & {
    key: Buffer;
    expires: string | null | undefined;
    signature: string | null | undefined;
    now?: Date | undefined;
  },
): boolean {
  const { expires, signature } = params;
  if (!expires || !signature || !/^\d{1,12}$/.test(expires)) return false;
  if (!UUID_RE.test(params.teamId) || !UUID_RE.test(params.emailId)) return false;
  if (params.attachmentId !== undefined && !UUID_RE.test(params.attachmentId)) return false;
  const now = (params.now ?? new Date()).getTime();
  const expiresMs = Number(expires) * 1000;
  if (expiresMs < now || expiresMs > now + RECEIVED_DOWNLOAD_TTL_MS + SKEW_MS) return false;
  // Compared in encoded space: base64url decoding ignores trailing padding
  // bits, so a byte-level comparison would accept non-canonical signatures.
  const given = Buffer.from(signature, "utf8");
  const expected = Buffer.from(mac(params.key, params, expires), "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
