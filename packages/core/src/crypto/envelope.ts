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

export async function decryptEmailBody(
  encrypted: EncryptedBody,
  keyring: Keyring,
): Promise<EmailBody> {
  const plaintext = await decryptPayload(encrypted, keyring);
  return JSON.parse(plaintext.toString("utf8")) as EmailBody;
}
