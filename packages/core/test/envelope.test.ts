import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptEmailBody, encryptEmailBody } from "../src/crypto/envelope.js";
import { EnvKeyring } from "../src/crypto/keyring.js";

const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));

describe("envelope encryption", () => {
  it("round-trips html and text", async () => {
    const body = { html: "<p>Olá, 你好, مرحبا</p>", text: "plain" };
    const encrypted = await encryptEmailBody(body, keyring);
    expect(encrypted.ciphertext.equals(Buffer.from(JSON.stringify(body)))).toBe(false);
    await expect(decryptEmailBody(encrypted, keyring)).resolves.toEqual(body);
  });

  it("produces distinct ciphertexts for identical bodies (fresh DEK per email)", async () => {
    const body = { html: "<p>same</p>", text: null };
    const a = await encryptEmailBody(body, keyring);
    const b = await encryptEmailBody(body, keyring);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
  });

  it("rejects tampered ciphertext", async () => {
    const encrypted = await encryptEmailBody({ html: "<p>hi</p>", text: null }, keyring);
    const idx = 0;
    const byte = encrypted.ciphertext[idx];
    if (byte === undefined) throw new Error("empty ciphertext");
    encrypted.ciphertext[idx] = byte ^ 0xff;
    await expect(decryptEmailBody(encrypted, keyring)).rejects.toThrow();
  });

  it("rejects a wrapped DEK from a different KEK", async () => {
    const other = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
    const encrypted = await encryptEmailBody({ html: null, text: "x" }, keyring);
    await expect(decryptEmailBody(encrypted, other)).rejects.toThrow();
  });

  it("supports KEK rotation: old versions unwrap, new wraps use current", async () => {
    const v1 = randomBytes(32);
    const v2 = randomBytes(32);
    const oldRing = new EnvKeyring(new Map([[1, v1]]), 1);
    const sealedUnderV1 = await encryptEmailBody({ html: null, text: "old" }, oldRing);

    const rotated = new EnvKeyring(
      new Map([
        [1, v1],
        [2, v2],
      ]),
      2,
    );
    await expect(decryptEmailBody(sealedUnderV1, rotated)).resolves.toEqual({
      html: null,
      text: "old",
    });
    const sealedUnderV2 = await encryptEmailBody({ html: null, text: "new" }, rotated);
    expect(sealedUnderV2.keyVersion).toBe(2);
  });

  it("rejects unknown key versions", async () => {
    const encrypted = await encryptEmailBody({ html: null, text: "x" }, keyring);
    await expect(decryptEmailBody({ ...encrypted, keyVersion: 99 }, keyring)).rejects.toThrow(
      /unknown KEK version/,
    );
  });
});
