import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

const THREAD_TOKEN_INFO = "millionsend:thread-token:v1";
const RECEIVED_SECRET_INFO = "millionsend:received-secret:v1";
const FORWARD_MARKER_INFO = "millionsend:forward-marker:v1";

/**
 * Inbox keys, each an HKDF derivation of the master key with its own info,
 * like the download and tracking keys: the KEK never signs anything itself.
 */
export interface InboxKeys {
  /** Signs the thread tokens our outbound References carry. */
  threadToken: Buffer;
  /** Keys the MACs of received codes and links (received_secrets). */
  receivedSecret: Buffer;
  /** Signs the X-MillionSend-Forwarded marker, so a sender cannot fake one to dodge forward_to. */
  forwardMarker: Buffer;
}

export function deriveInboxKeys(masterKey: Buffer): InboxKeys {
  if (masterKey.length < 16) throw new Error("master key too short to derive from");
  const derive = (info: string) =>
    Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), info, 32));
  return {
    threadToken: derive(THREAD_TOKEN_INFO),
    receivedSecret: derive(RECEIVED_SECRET_INFO),
    forwardMarker: derive(FORWARD_MARKER_INFO),
  };
}

const uuidBytes = (id: string): Buffer => Buffer.from(id.replace(/-/g, ""), "hex");

function uuidOf(bytes: Buffer): string {
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function threadMac(key: Buffer, teamId: string, inboxId: string, threadId: string): string {
  return createHmac("sha256", key)
    .update(`${teamId}\n${inboxId}\n${threadId}`)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

/**
 * `<ms1.{thread}.{mac}@{domain}>`, a msg-id every client copies into the
 * References of a reply. SES replaces our Message-ID, so the token rides in
 * References instead; every character is RFC 5322 atext.
 */
export function threadTokenId(
  keys: InboxKeys,
  p: { teamId: string; inboxId: string; threadId: string; domain: string },
): string {
  const thread = uuidBytes(p.threadId).toString("base64url");
  return `<ms1.${thread}.${threadMac(keys.threadToken, p.teamId, p.inboxId, p.threadId)}@${p.domain}>`;
}

const TOKEN_RE = /^ms1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})@[^<>\s]{1,253}$/;

/**
 * The thread a References or In-Reply-To entry proves for this team and
 * inbox, or null. Takes the msg-id with or without its angle brackets: some
 * clients write References bare.
 */
export function verifyThreadTokenRef(
  keys: InboxKeys,
  p: { teamId: string; inboxId: string; ref: string },
): string | null {
  const ref = p.ref.startsWith("<") && p.ref.endsWith(">") ? p.ref.slice(1, -1) : p.ref;
  const m = TOKEN_RE.exec(ref);
  if (!m?.[1] || !m[2]) return null;
  const threadId = uuidOf(Buffer.from(m[1], "base64url"));
  // Canonical encodings only, so a token that changed in any character fails.
  if (uuidBytes(threadId).toString("base64url") !== m[1]) return null;
  // Compared in encoded space, as the download tokens are.
  const given = Buffer.from(m[2], "utf8");
  const expected = Buffer.from(threadMac(keys.threadToken, p.teamId, p.inboxId, threadId), "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected) ? threadId : null;
}

/**
 * The MAC received_secrets stores for one received code, link or token-like
 * value, bound to the team. `value` is normalized by the caller the same way
 * at ingest and at send: codes uppercase without separators, links without
 * their fragment.
 */
export function secretMac(keys: InboxKeys, teamId: string, value: string): Buffer {
  return createHmac("sha256", keys.receivedSecret).update(`${teamId}\n${value}`).digest();
}

const markerMac = (keys: InboxKeys, inboxId: string): string =>
  createHmac("sha256", keys.forwardMarker)
    .update(inboxId)
    .digest()
    .subarray(0, 16)
    .toString("base64url");

/** The X-MillionSend-Forwarded value a forward from this inbox carries: `<inbox id>.<mac>`. */
export function forwardMarker(keys: InboxKeys, inboxId: string): string {
  return `${inboxId}.${markerMac(keys, inboxId)}`;
}

/** Whether a marker is one this instance wrote, for any of its inboxes. */
export function verifyForwardMarker(keys: InboxKeys, value: string): boolean {
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{22})$/.exec(value.trim());
  if (!m?.[1] || !m[2]) return false;
  const given = Buffer.from(m[2], "utf8");
  const expected = Buffer.from(markerMac(keys, m[1]), "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
