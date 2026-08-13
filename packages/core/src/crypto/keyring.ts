import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

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

const GCM_IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

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

  wrapDek(dek: Buffer): Promise<{ wrapped: Buffer; keyVersion: number }> {
    const kek = this.#keys.get(this.#currentVersion);
    if (!kek) throw new Error("unreachable: current KEK missing");
    const iv = randomBytes(GCM_IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", kek, iv);
    const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
    // wrapped layout: iv || ciphertext || authTag
    const wrapped = Buffer.concat([iv, encrypted, cipher.getAuthTag()]);
    return Promise.resolve({ wrapped, keyVersion: this.#currentVersion });
  }

  unwrapDek(wrapped: Buffer, keyVersion: number): Promise<Buffer> {
    const kek = this.#keys.get(keyVersion);
    if (!kek) return Promise.reject(new Error(`unknown KEK version ${keyVersion}`));
    const iv = wrapped.subarray(0, GCM_IV_LENGTH);
    const tag = wrapped.subarray(wrapped.length - GCM_TAG_LENGTH);
    const ciphertext = wrapped.subarray(GCM_IV_LENGTH, wrapped.length - GCM_TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", kek, iv);
    decipher.setAuthTag(tag);
    return Promise.resolve(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  }
}
