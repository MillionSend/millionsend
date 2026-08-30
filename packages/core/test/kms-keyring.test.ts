import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptEmailBody,
  decryptPayload,
  encryptEmailBody,
  encryptPayload,
} from "../src/crypto/envelope.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import {
  CompositeKeyring,
  KMS_KEY_VERSION,
  type KmsDekClient,
  KmsKeyring,
  UNWRAP_CACHE_MAX_ENTRIES,
  UNWRAP_CACHE_TTL_MS,
  WRAP_CACHE_MAX_AGE_MS,
  WRAP_CACHE_MAX_USES,
} from "../src/crypto/kms-keyring.js";

const KEY_ID = "arn:aws:kms:us-east-1:123456789012:key/test";
const OTHER_KEY_ID = "arn:aws:kms:us-east-1:123456789012:key/other";

// Fake KMS: "wraps" by prefixing the encrypting KeyId and encryption
// context, and like real KMS fails Decrypt when the pinned KeyId or the
// supplied context differs from what produced the blob.
function fakeKms(): { client: KmsDekClient; calls: { encrypt: number; decrypt: number } } {
  const calls = { encrypt: 0, decrypt: 0 };
  const header = (keyId: string, context: Record<string, string> | undefined) =>
    `${keyId}|${JSON.stringify(context ?? null)}|`;
  const client: KmsDekClient = {
    async encrypt({ KeyId, Plaintext, EncryptionContext }) {
      calls.encrypt += 1;
      return {
        CiphertextBlob: Buffer.concat([
          Buffer.from(header(KeyId, EncryptionContext)),
          Buffer.from(Plaintext),
        ]),
      };
    },
    async decrypt({ KeyId, CiphertextBlob, EncryptionContext }) {
      calls.decrypt += 1;
      const blob = Buffer.from(CiphertextBlob);
      const expected = Buffer.from(header(KeyId, EncryptionContext));
      if (!blob.subarray(0, expected.length).equals(expected)) {
        if (blob.subarray(0, KeyId.length + 1).toString() !== `${KeyId}|`) {
          throw new Error("IncorrectKeyException: blob was not encrypted under the requested key");
        }
        throw new Error("InvalidCiphertextException: encryption context mismatch");
      }
      return { Plaintext: blob.subarray(expected.length) };
    },
  };
  return { client, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("KmsKeyring", () => {
  it("round-trips an email body through the envelope", async () => {
    const { client } = fakeKms();
    const keyring = new KmsKeyring(client, KEY_ID);
    const body = { html: "<p>Olá</p>", text: "plain" };
    const encrypted = await encryptEmailBody(body, keyring);
    expect(encrypted.keyVersion).toBe(KMS_KEY_VERSION);
    await expect(decryptEmailBody(encrypted, keyring)).resolves.toEqual(body);
  });

  it("pins KeyId on unwrap: a blob wrapped under a different key is rejected", async () => {
    const { client } = fakeKms();
    const wrapping = new KmsKeyring(client, KEY_ID);
    const encrypted = await encryptEmailBody({ html: null, text: "x" }, wrapping);
    const pinnedElsewhere = new KmsKeyring(client, OTHER_KEY_ID);
    await expect(decryptEmailBody(encrypted, pinnedElsewhere)).rejects.toThrow(
      /IncorrectKeyException/,
    );
  });

  it("rejects env key versions instead of sending them to KMS", async () => {
    const { client, calls } = fakeKms();
    const keyring = new KmsKeyring(client, KEY_ID);
    await expect(keyring.unwrapDek(Buffer.from("junk"), 1)).rejects.toThrow(
      /unknown key version 1/,
    );
    expect(calls.decrypt).toBe(0);
  });

  it("wrap cache: items reuse one wrapped DEK but get fresh IVs and ciphertexts", async () => {
    const { client, calls } = fakeKms();
    const keyring = new KmsKeyring(client, KEY_ID);
    const a = await encryptPayload(Buffer.from("one"), keyring);
    const b = await encryptPayload(Buffer.from("two"), keyring);
    expect(calls.encrypt).toBe(1);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(true);
    expect(a.iv.equals(b.iv)).toBe(false);
    await expect(decryptPayload(a, keyring)).resolves.toEqual(Buffer.from("one"));
    await expect(decryptPayload(b, keyring)).resolves.toEqual(Buffer.from("two"));
  });

  it("wrap cache rotates after maxUses", async () => {
    const { client, calls } = fakeKms();
    const keyring = new KmsKeyring(client, KEY_ID);
    const first = await keyring.generateWrappedDek();
    for (let i = 1; i < WRAP_CACHE_MAX_USES; i += 1) {
      await keyring.generateWrappedDek();
    }
    expect(calls.encrypt).toBe(1);
    const rotated = await keyring.generateWrappedDek();
    expect(calls.encrypt).toBe(2);
    expect(rotated.wrapped.equals(first.wrapped)).toBe(false);
  });

  it("wrap cache rotates after maxAge", async () => {
    vi.useFakeTimers();
    const { client, calls } = fakeKms();
    const keyring = new KmsKeyring(client, KEY_ID);
    await keyring.generateWrappedDek();
    vi.advanceTimersByTime(WRAP_CACHE_MAX_AGE_MS - 1);
    await keyring.generateWrappedDek();
    expect(calls.encrypt).toBe(1);
    vi.advanceTimersByTime(1);
    await keyring.generateWrappedDek();
    expect(calls.encrypt).toBe(2);
  });

  it("wrap cache does not re-serve a failed KMS call", async () => {
    let fail = true;
    const client: KmsDekClient = {
      async encrypt({ KeyId, Plaintext }) {
        if (fail) throw new Error("KMS unavailable");
        return {
          CiphertextBlob: Buffer.concat([Buffer.from(`${KeyId}|`), Buffer.from(Plaintext)]),
        };
      },
      async decrypt() {
        throw new Error("unused");
      },
    };
    const keyring = new KmsKeyring(client, KEY_ID);
    await expect(keyring.generateWrappedDek()).rejects.toThrow("KMS unavailable");
    fail = false;
    await expect(keyring.generateWrappedDek()).resolves.toMatchObject({
      keyVersion: KMS_KEY_VERSION,
    });
  });

  it("binds wraps to the team and purpose, caching one DEK per context", async () => {
    const { client, calls } = fakeKms();
    const keyring = new KmsKeyring(client, KEY_ID);
    const a = await encryptPayload(Buffer.from("a1"), keyring, {
      teamId: "team-a",
      rowId: "r1",
      kind: "email_body",
    });
    const a2 = await encryptPayload(Buffer.from("a2"), keyring, {
      teamId: "team-a",
      rowId: "r2",
      kind: "email_body",
    });
    const b = await encryptPayload(Buffer.from("b1"), keyring, {
      teamId: "team-b",
      rowId: "r1",
      kind: "email_body",
    });
    expect(calls.encrypt).toBe(2);
    expect(a.wrappedDek.equals(a2.wrappedDek)).toBe(true);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
    // The DEK lifted from team A's row is refused for team B, before the
    // envelope's own AAD check ever runs.
    await expect(
      keyring.unwrapDek(a.wrappedDek, KMS_KEY_VERSION, { teamId: "team-b", purpose: "email_body" }),
    ).rejects.toThrow(/encryption context mismatch/);
    await expect(
      decryptPayload(a, keyring, { teamId: "team-b", rowId: "r1", kind: "email_body" }),
    ).rejects.toThrow(/encryption context mismatch/);
    await expect(
      decryptPayload(a, keyring, { teamId: "team-a", rowId: "r1", kind: "email_body" }),
    ).resolves.toEqual(Buffer.from("a1"));
  });

  it("unwrap cache: repeated unwraps of one item hit the LRU, TTL expiry refetches", async () => {
    vi.useFakeTimers();
    const { client, calls } = fakeKms();
    const keyring = new KmsKeyring(client, KEY_ID);
    const encrypted = await encryptPayload(Buffer.from("cached"), keyring);
    await decryptPayload(encrypted, keyring);
    await decryptPayload(encrypted, keyring);
    expect(calls.decrypt).toBe(1);
    vi.advanceTimersByTime(UNWRAP_CACHE_TTL_MS + 1);
    await decryptPayload(encrypted, keyring);
    expect(calls.decrypt).toBe(2);
  });

  it("unwrap cache evicts the least recently used entry at capacity", async () => {
    const { client, calls } = fakeKms();
    const keyring = new KmsKeyring(client, KEY_ID);
    const wraps: Buffer[] = [];
    for (let i = 0; i < UNWRAP_CACHE_MAX_ENTRIES + 1; i += 1) {
      const { wrapped } = await keyring.wrapDek(randomBytes(32));
      wraps.push(wrapped);
      await keyring.unwrapDek(wrapped, KMS_KEY_VERSION);
    }
    const filled = calls.decrypt;
    // The newest entry is still cached...
    const newest = wraps[wraps.length - 1];
    if (!newest) throw new Error("no wraps");
    await keyring.unwrapDek(newest, KMS_KEY_VERSION);
    expect(calls.decrypt).toBe(filled);
    // ...while the oldest was evicted and needs KMS again.
    const oldest = wraps[0];
    if (!oldest) throw new Error("no wraps");
    await keyring.unwrapDek(oldest, KMS_KEY_VERSION);
    expect(calls.decrypt).toBe(filled + 1);
  });
});

describe("CompositeKeyring", () => {
  it("routes env-version ciphertexts to the env keyring and KMS ones to KMS", async () => {
    const { client, calls } = fakeKms();
    const envKeyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
    const sealedUnderEnv = await encryptEmailBody({ html: null, text: "old" }, envKeyring);

    const composite = new CompositeKeyring(new KmsKeyring(client, KEY_ID), envKeyring);
    await expect(decryptEmailBody(sealedUnderEnv, composite)).resolves.toEqual({
      html: null,
      text: "old",
    });
    expect(calls.decrypt).toBe(0);

    const sealedUnderKms = await encryptEmailBody({ html: null, text: "new" }, composite);
    expect(sealedUnderKms.keyVersion).toBe(KMS_KEY_VERSION);
    await expect(decryptEmailBody(sealedUnderKms, composite)).resolves.toEqual({
      html: null,
      text: "new",
    });
    expect(calls.decrypt).toBe(1);
  });
});
