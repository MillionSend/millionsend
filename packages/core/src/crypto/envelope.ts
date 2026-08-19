import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GCM_IV_LENGTH, GCM_TAG_LENGTH } from "./constants.js";
import type { Keyring } from "./keyring.js";

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

/**
 * Envelope encryption: a fresh random DEK per payload (sidesteps GCM nonce
 * budgets), wrapped by the keyring's KEK. ciphertext layout: payload ||
 * authTag. The plaintext DEK is scrubbed on every path, including keyring
 * failure. Email bodies and webhook signing secrets both seal through here.
 */
export async function encryptPayload(plaintext: Buffer, keyring: Keyring): Promise<EncryptedBody> {
  const dek = randomBytes(32);
  try {
    const iv = randomBytes(GCM_IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const { wrapped, keyVersion } = await keyring.wrapDek(dek);
    return { ciphertext: encrypted, iv, wrappedDek: wrapped, keyVersion };
  } finally {
    dek.fill(0);
  }
}

export async function decryptPayload(encrypted: EncryptedBody, keyring: Keyring): Promise<Buffer> {
  if (encrypted.ciphertext.length < GCM_TAG_LENGTH) {
    throw new Error(`ciphertext too short: ${encrypted.ciphertext.length} bytes`);
  }
  const dek = await keyring.unwrapDek(encrypted.wrappedDek, encrypted.keyVersion);
  try {
    const tag = encrypted.ciphertext.subarray(encrypted.ciphertext.length - GCM_TAG_LENGTH);
    const body = encrypted.ciphertext.subarray(0, encrypted.ciphertext.length - GCM_TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", dek, encrypted.iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } finally {
    dek.fill(0);
  }
}

export async function encryptEmailBody(body: EmailBody, keyring: Keyring): Promise<EncryptedBody> {
  return encryptPayload(Buffer.from(JSON.stringify(body), "utf8"), keyring);
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
): Promise<string> {
  const encrypted = await encryptPayload(Buffer.from(JSON.stringify(attachments), "utf8"), keyring);
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
  );
  return JSON.parse(plaintext.toString("utf8")) as EmailAttachment[];
}

export async function decryptEmailBody(
  encrypted: EncryptedBody,
  keyring: Keyring,
): Promise<EmailBody> {
  const plaintext = await decryptPayload(encrypted, keyring);
  return JSON.parse(plaintext.toString("utf8")) as EmailBody;
}
