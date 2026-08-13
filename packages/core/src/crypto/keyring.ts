import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GCM_IV_LENGTH, GCM_TAG_LENGTH } from "./constants.js";

/**
 * Wraps/unwraps per-email data-encryption keys. Implementations:
 * EnvKeyring (self-host, KEK from configuration) here; a KMS keyring ships
 * with the AWS package. keyVersion travels with every wrapped DEK so KEK
 * rotation re-wraps DEKs without re-encrypting bodies.
 */
export interface Keyring {
  wrapDek(dek: Buffer): Promise<{ wrapped: Buffer; keyVersion: number }>;
  unwrapDek(wrapped: Buffer, keyVersion: number): Promise<Buffer>;
}

export class EnvKeyring implements Keyring {
  readonly #keys: ReadonlyMap<number, Buffer>;
  readonly #currentVersion: number;

  /**
   * @param keys KEKs by version; `currentVersion` is used for new wraps,
   * older versions remain available for unwrapping.
   */
  constructor(keys: ReadonlyMap<number, Buffer>, currentVersion: number) {
    for (const [version, key] of keys) {
      if (key.length !== 32) {
        throw new Error(`KEK v${version} must be 32 bytes, got ${key.length}`);
      }
    }
    if (!keys.has(currentVersion)) {
      throw new Error(`current KEK version ${currentVersion} missing from key map`);
    }
    this.#keys = keys;
    this.#currentVersion = currentVersion;
  }

  static fromBase64(kekBase64: string): EnvKeyring {
    return new EnvKeyring(new Map([[1, Buffer.from(kekBase64, "base64")]]), 1);
  }

  // async so every failure path rejects — callers' .catch must never be
  // bypassed by a synchronous throw.
  async wrapDek(dek: Buffer): Promise<{ wrapped: Buffer; keyVersion: number }> {
    const kek = this.#keys.get(this.#currentVersion);
    if (!kek) throw new Error("unreachable: current KEK missing");
    const iv = randomBytes(GCM_IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", kek, iv);
    const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
    // wrapped layout: iv || ciphertext || authTag
    return {
      wrapped: Buffer.concat([iv, encrypted, cipher.getAuthTag()]),
      keyVersion: this.#currentVersion,
    };
  }

  async unwrapDek(wrapped: Buffer, keyVersion: number): Promise<Buffer> {
    const kek = this.#keys.get(keyVersion);
    if (!kek) throw new Error(`unknown KEK version ${keyVersion}`);
    if (wrapped.length < GCM_IV_LENGTH + GCM_TAG_LENGTH + 1) {
      throw new Error(`wrapped DEK too short: ${wrapped.length} bytes`);
    }
    const iv = wrapped.subarray(0, GCM_IV_LENGTH);
    const tag = wrapped.subarray(wrapped.length - GCM_TAG_LENGTH);
    const ciphertext = wrapped.subarray(GCM_IV_LENGTH, wrapped.length - GCM_TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", kek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
