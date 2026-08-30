import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GCM_IV_LENGTH, GCM_TAG_LENGTH } from "./constants.js";

/**
 * Wraps/unwraps per-email data-encryption keys. Implementations: EnvKeyring
 * (self-host, KEK from configuration) here; KmsKeyring and CompositeKeyring
 * (cloud) in kms-keyring.ts. keyVersion travels with every wrapped DEK so
 * KEK rotation re-wraps DEKs without re-encrypting bodies.
 */
export interface Keyring {
  wrapDek(dek: Buffer, context?: DekContext): Promise<{ wrapped: Buffer; keyVersion: number }>;
  unwrapDek(wrapped: Buffer, keyVersion: number, context?: DekContext): Promise<Buffer>;
  /**
   * Present when the keyring supplies the DEK itself so it can serve a
   * cached (DEK, wrapped) pair — wrapping through KMS costs a network
   * round-trip per call. envelope.ts prefers this over wrapDek when present;
   * the returned dek is the caller's copy to scrub.
   */
  generateWrappedDek?(
    context?: DekContext,
  ): Promise<{ dek: Buffer; wrapped: Buffer; keyVersion: number }>;
}

/**
 * What a wrapped DEK is for. Keyrings that can bind key material to it (KMS
 * encryption context) refuse to unwrap under a different context, so a DEK
 * lifted from one team's row cannot be unwrapped for another. Absent on
 * legacy envelopes sealed before binding existed.
 */
export interface DekContext {
  teamId: string;
  purpose: string;
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
    const kek = Buffer.from(kekBase64, "base64");
    // Buffer.from skips foreign characters, so a mangled key can decode to
    // 32 bytes that differ from what sealed existing rows; canonical only.
    if (kek.length !== 32 || kek.toString("base64") !== kekBase64) {
      throw new Error("KEK must be 32 bytes of canonical base64");
    }
    return new EnvKeyring(new Map([[1, kek]]), 1);
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
