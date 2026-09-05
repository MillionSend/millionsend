import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { GCM_IV_LENGTH, GCM_TAG_LENGTH } from "./constants.js";
import type { DekContext, Keyring } from "./keyring.js";

export interface EmailBody {
  html: string | null;
  text: string | null;
}

export interface EncryptedBody {
  ciphertext: Buffer;
  iv: Buffer;
  wrappedDek: Buffer;
  keyVersion: number;
}

export type EnvelopeKind = "email_body" | "email_attachments" | "webhook_secret";

/** The row an envelope belongs to; the helpers below fix the kind. */
export interface EnvelopeOwner {
  teamId: string;
  rowId: string;
}

/**
 * Row identity authenticated into the ciphertext (AES-GCM AAD) and carried
 * to the keyring as the DEK context. A bound envelope opens only on the row
 * it was sealed for: copying its columns onto another row, another team, or
 * a column of a different kind fails authentication.
 */
export interface EnvelopeBinding extends EnvelopeOwner {
  kind: EnvelopeKind;
}

/**
 * Bound envelopes store keyVersion + this offset. Rows sealed before binding
 * existed carry the bare KEK version and still open without AAD; the offset
 * keeps both formats apart in the existing integer column, the way
 * KMS_KEY_VERSION splits KMS wraps from env KEK versions.
 */
export const BOUND_ENVELOPE_VERSION_OFFSET = 2_000_000;

function aad(binding: EnvelopeBinding): Buffer {
  return Buffer.from(`${binding.teamId}:${binding.kind}:${binding.rowId}`, "utf8");
}

function dekContext(binding: EnvelopeBinding): DekContext {
  return { teamId: binding.teamId, purpose: binding.kind };
}

/**
 * Envelope encryption: one DEK per payload wrapped by the keyring, ciphertext
 * layout payload || authTag. Keyrings with generateWrappedDek supply the DEK
 * so they can reuse a bounded cached pair (KMS pays a network round-trip per
 * wrap); otherwise a fresh random DEK per payload. Reuse is sound for GCM
 * because the IV below is fresh and random per payload either way. The
 * plaintext DEK is scrubbed on every path, including keyring failure. Email
 * bodies and webhook signing secrets both seal through here.
 */
export async function encryptPayload(
  plaintext: Buffer,
  keyring: Keyring,
  binding?: EnvelopeBinding,
): Promise<EncryptedBody> {
  const context = binding ? dekContext(binding) : undefined;
  const generated = keyring.generateWrappedDek
    ? await keyring.generateWrappedDek(context)
    : undefined;
  const dek = generated?.dek ?? randomBytes(32);
  try {
    const iv = randomBytes(GCM_IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    if (binding) cipher.setAAD(aad(binding));
    const encrypted = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const { wrapped, keyVersion } = generated ?? (await keyring.wrapDek(dek, context));
    return {
      ciphertext: encrypted,
      iv,
      wrappedDek: wrapped,
      keyVersion: binding ? keyVersion + BOUND_ENVELOPE_VERSION_OFFSET : keyVersion,
    };
  } finally {
    dek.fill(0);
  }
}

export async function decryptPayload(
  encrypted: EncryptedBody,
  keyring: Keyring,
  binding?: EnvelopeBinding,
): Promise<Buffer> {
  if (encrypted.ciphertext.length < GCM_TAG_LENGTH) {
    throw new Error(`ciphertext too short: ${encrypted.ciphertext.length} bytes`);
  }
  const isBound = encrypted.keyVersion >= BOUND_ENVELOPE_VERSION_OFFSET;
  if (isBound && !binding) throw new Error("bound envelope opened without its row binding");
  // A legacy row ignores the binding: it was sealed without one.
  const bound = isBound ? binding : undefined;
  const keyVersion = isBound
    ? encrypted.keyVersion - BOUND_ENVELOPE_VERSION_OFFSET
    : encrypted.keyVersion;
  const dek = await keyring.unwrapDek(
    encrypted.wrappedDek,
    keyVersion,
    bound ? dekContext(bound) : undefined,
  );
  try {
    const tag = encrypted.ciphertext.subarray(encrypted.ciphertext.length - GCM_TAG_LENGTH);
    const body = encrypted.ciphertext.subarray(0, encrypted.ciphertext.length - GCM_TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", dek, encrypted.iv);
    if (bound) decipher.setAAD(aad(bound));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } finally {
    dek.fill(0);
  }
}

/**
 * Bodies are gzipped before sealing: ciphertext is indistinguishable from
 * random and does not compress, so the only place to shrink the per-recipient
 * copy is the plaintext. The sender authors the whole body, so the classic
 * compression side channel (an attacker injecting chosen text beside a secret
 * and watching ciphertext lengths) has no foothold here.
 *
 * Decrypt sniffs the format: gzip output starts with 0x1f 0x8b, while the
 * JSON of a legacy row starts with '{' (0x7b) — no key-version bump needed.
 */
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

export async function encryptEmailBody(
  body: EmailBody,
  keyring: Keyring,
  owner?: EnvelopeOwner,
): Promise<EncryptedBody> {
  return encryptPayload(
    gzipSync(Buffer.from(JSON.stringify(body), "utf8")),
    keyring,
    owner && { ...owner, kind: "email_body" },
  );
}

export interface EmailAttachment {
  filename: string;
  /** File bytes, base64-encoded (validated at the accept surface). */
  content: string;
  contentType?: string | undefined;
}

/**
 * Attachments seal through the same envelope primitive as email bodies, but
 * the emails table gives them a single text column instead of four dedicated
 * ones — so the envelope parts travel inside the blob as base64 JSON.
 */
export async function sealAttachments(
  attachments: EmailAttachment[],
  keyring: Keyring,
  owner?: EnvelopeOwner,
): Promise<string> {
  const encrypted = await encryptPayload(
    Buffer.from(JSON.stringify(attachments), "utf8"),
    keyring,
    owner && { ...owner, kind: "email_attachments" },
  );
  return JSON.stringify({
    keyVersion: encrypted.keyVersion,
    iv: encrypted.iv.toString("base64"),
    wrappedDek: encrypted.wrappedDek.toString("base64"),
    ciphertext: encrypted.ciphertext.toString("base64"),
  });
}

export async function openAttachments(
  sealed: string,
  keyring: Keyring,
  owner?: EnvelopeOwner,
): Promise<EmailAttachment[]> {
  const parts = JSON.parse(sealed) as {
    keyVersion: number;
    iv: string;
    wrappedDek: string;
    ciphertext: string;
  };
  const plaintext = await decryptPayload(
    {
      ciphertext: Buffer.from(parts.ciphertext, "base64"),
      iv: Buffer.from(parts.iv, "base64"),
      wrappedDek: Buffer.from(parts.wrappedDek, "base64"),
      keyVersion: parts.keyVersion,
    },
    keyring,
    owner && { ...owner, kind: "email_attachments" },
  );
  return JSON.parse(plaintext.toString("utf8")) as EmailAttachment[];
}

export async function decryptEmailBody(
  encrypted: EncryptedBody,
  keyring: Keyring,
  owner?: EnvelopeOwner,
): Promise<EmailBody> {
  const plaintext = await decryptPayload(
    encrypted,
    keyring,
    owner && { ...owner, kind: "email_body" },
  );
  const json = plaintext.subarray(0, 2).equals(GZIP_MAGIC) ? gunzipSync(plaintext) : plaintext;
  return JSON.parse(json.toString("utf8")) as EmailBody;
}
