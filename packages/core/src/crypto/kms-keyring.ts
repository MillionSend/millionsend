import { createHash, randomBytes } from "node:crypto";
import type { Keyring } from "./keyring.js";

/**
 * Structural subset of the aggregated `KMS` client from @aws-sdk/client-kms,
 * which satisfies it directly — no adapter. Tests inject fakes (mirrors the
 * SesIdentityClient pattern in @millionsend/ses).
 */
export interface KmsDekClient {
  encrypt(params: {
    KeyId: string;
    Plaintext: Uint8Array;
  }): Promise<{ CiphertextBlob?: Uint8Array | undefined }>;
  decrypt(params: {
    KeyId: string;
    CiphertextBlob: Uint8Array;
  }): Promise<{ Plaintext?: Uint8Array | undefined }>;
}

/**
 * keyVersion recorded on every KMS-wrapped DEK. Env KEK versions are small
 * hand-incremented integers (1, 2, …), so reserving one distant constant
 * splits the version space: CompositeKeyring routes unwraps by the stored
 * keyVersion alone, with no envelope-format change. A single constant covers
 * all KMS wraps because KMS rotates key material internally — the ciphertext
 * blob, not the version, identifies the backing material.
 */
export const KMS_KEY_VERSION = 1_000_000;

// Wrap-side data-key reuse bounds (AWS Encryption SDK convention): without
// reuse every accepted email pays a KMS round-trip on the hot accept path.
// Reusing one DEK is sound for AES-256-GCM because each item gets its own
// fresh random 96-bit IV; these bounds cap the blast radius of a leaked
// process memory, not a nonce budget (500 random IVs is far below 2^32).
export const WRAP_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
export const WRAP_CACHE_MAX_USES = 500;

// Unwrap-side LRU: dashboard reads and webhook deliveries re-open the same
// wrapped DEKs in bursts. 256 × 32-byte keys is negligible memory; the TTL
// bounds how long decryption keeps working after KMS-side key revocation.
export const UNWRAP_CACHE_MAX_ENTRIES = 256;
export const UNWRAP_CACHE_TTL_MS = 10 * 60 * 1000;

interface DekPair {
  dek: Buffer;
  wrapped: Buffer;
}

interface WrapCacheEntry {
  promise: Promise<DekPair>;
  createdAt: number;
  uses: number;
}

interface UnwrapCacheEntry {
  dek: Buffer;
  expiresAt: number;
}

/**
 * Keyring backed by AWS KMS: wrapDek is KMS Encrypt under the configured
 * key; unwrapDek is KMS Decrypt with KeyId pinned to that same key, so a
 * wrappedDek substituted with a blob from a different KMS key fails instead
 * of silently decrypting under foreign key material.
 */
export class KmsKeyring implements Keyring {
  readonly #client: KmsDekClient;
  readonly #keyId: string;
  #wrapCache: WrapCacheEntry | null = null;
  // Map insertion order is the LRU order: hits are re-inserted, evictions
  // take the first key.
  readonly #unwrapCache = new Map<string, UnwrapCacheEntry>();

  constructor(client: KmsDekClient, keyId: string) {
    if (!keyId) throw new Error("KmsKeyring requires a KMS key id");
    this.#client = client;
    this.#keyId = keyId;
  }

  /**
   * Serves a cached (DEK, wrapped) pair, regenerating after
   * WRAP_CACHE_MAX_USES uses or WRAP_CACHE_MAX_AGE_MS. Returned buffers are
   * copies — callers (envelope.ts) scrub what they receive.
   */
  async generateWrappedDek(): Promise<{ dek: Buffer; wrapped: Buffer; keyVersion: number }> {
    const now = Date.now();
    let entry = this.#wrapCache;
    if (
      !entry ||
      entry.uses >= WRAP_CACHE_MAX_USES ||
      now - entry.createdAt >= WRAP_CACHE_MAX_AGE_MS
    ) {
      const stale = entry;
      const fresh: WrapCacheEntry = { promise: undefined as never, createdAt: now, uses: 0 };
      fresh.promise = (async () => {
        // Scrub the rotated-out DEK once its last in-flight copy resolved;
        // promise handlers run in attach order, so earlier awaiters copy first.
        stale?.promise.then(
          (pair) => pair.dek.fill(0),
          () => undefined,
        );
        const dek = randomBytes(32);
        try {
          return { dek, wrapped: await this.#kmsWrap(dek) };
        } catch (err) {
          dek.fill(0);
          // A rejected pair must not be re-served to later callers.
          if (this.#wrapCache === fresh) this.#wrapCache = null;
          throw err;
        }
      })();
      this.#wrapCache = fresh;
      entry = fresh;
    }
    entry.uses += 1;
    const pair = await entry.promise;
    return {
      dek: Buffer.from(pair.dek),
      wrapped: Buffer.from(pair.wrapped),
      keyVersion: KMS_KEY_VERSION,
    };
  }

  /** Caller-supplied DEKs cannot be cached — one KMS Encrypt per call. */
  async wrapDek(dek: Buffer): Promise<{ wrapped: Buffer; keyVersion: number }> {
    return { wrapped: await this.#kmsWrap(dek), keyVersion: KMS_KEY_VERSION };
  }

  async unwrapDek(wrapped: Buffer, keyVersion: number): Promise<Buffer> {
    if (keyVersion !== KMS_KEY_VERSION) {
      throw new Error(`unknown key version ${keyVersion} for the KMS keyring`);
    }
    const cacheKey = createHash("sha256").update(wrapped).digest("base64");
    const now = Date.now();
    const hit = this.#unwrapCache.get(cacheKey);
    if (hit) {
      this.#unwrapCache.delete(cacheKey);
      if (hit.expiresAt > now) {
        this.#unwrapCache.set(cacheKey, hit);
        return Buffer.from(hit.dek);
      }
      hit.dek.fill(0);
    }
    const result = await this.#client.decrypt({ KeyId: this.#keyId, CiphertextBlob: wrapped });
    if (!result.Plaintext) throw new Error("KMS Decrypt returned no plaintext");
    const dek = Buffer.from(result.Plaintext);
    if (dek.length !== 32) throw new Error(`KMS-unwrapped DEK must be 32 bytes, got ${dek.length}`);
    this.#unwrapCache.set(cacheKey, {
      dek: Buffer.from(dek),
      expiresAt: now + UNWRAP_CACHE_TTL_MS,
    });
    while (this.#unwrapCache.size > UNWRAP_CACHE_MAX_ENTRIES) {
      const oldestKey = this.#unwrapCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.#unwrapCache.get(oldestKey)?.dek.fill(0);
      this.#unwrapCache.delete(oldestKey);
    }
    return dek;
  }

  async #kmsWrap(dek: Buffer): Promise<Buffer> {
    const result = await this.#client.encrypt({ KeyId: this.#keyId, Plaintext: dek });
    if (!result.CiphertextBlob) throw new Error("KMS Encrypt returned no ciphertext");
    return Buffer.from(result.CiphertextBlob);
  }
}

/**
 * Migration keyring for self-host → cloud: new wraps go to KMS while
 * ciphertexts sealed under the old env KEK stay readable. Unwraps route by
 * the version-space split above — KMS_KEY_VERSION to KMS, everything else to
 * the env keyring.
 */
export class CompositeKeyring implements Keyring {
  readonly #kms: KmsKeyring;
  readonly #env: Keyring;

  constructor(kms: KmsKeyring, envKeyring: Keyring) {
    this.#kms = kms;
    this.#env = envKeyring;
  }

  generateWrappedDek(): Promise<{ dek: Buffer; wrapped: Buffer; keyVersion: number }> {
    return this.#kms.generateWrappedDek();
  }

  wrapDek(dek: Buffer): Promise<{ wrapped: Buffer; keyVersion: number }> {
    return this.#kms.wrapDek(dek);
  }

  unwrapDek(wrapped: Buffer, keyVersion: number): Promise<Buffer> {
    return keyVersion === KMS_KEY_VERSION
      ? this.#kms.unwrapDek(wrapped, keyVersion)
      : this.#env.unwrapDek(wrapped, keyVersion);
  }
}
