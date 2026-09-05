import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BOUND_ENVELOPE_VERSION_OFFSET,
  decryptEmailBody,
  decryptPayload,
  encryptEmailBody,
  encryptPayload,
  openAttachments,
  sealAttachments,
} from "../src/crypto/envelope.js";
import { EnvKeyring } from "../src/crypto/keyring.js";

const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));

describe("envelope encryption", () => {
  it("round-trips html and text", async () => {
    const body = { html: "<p>Olá, 你好, مرحبا</p>", text: "plain" };
    const encrypted = await encryptEmailBody(body, keyring);
    expect(encrypted.ciphertext.equals(Buffer.from(JSON.stringify(body)))).toBe(false);
    await expect(decryptEmailBody(encrypted, keyring)).resolves.toEqual(body);
  });

  it("still opens a legacy body sealed without compression", async () => {
    const body = { html: "<p>legacy</p>", text: "old" };
    const legacy = await encryptPayload(Buffer.from(JSON.stringify(body), "utf8"), keyring);
    await expect(decryptEmailBody(legacy, keyring)).resolves.toEqual(body);
  });

  it("compresses a repetitive body several times over", async () => {
    const html = "<tr><td>Item</td><td>R$ 10,00</td></tr>\n".repeat(500);
    expect(html.length).toBeGreaterThanOrEqual(20_000);
    const body = { html, text: null };
    const compressed = await encryptEmailBody(body, keyring);
    const plain = await encryptPayload(Buffer.from(JSON.stringify(body), "utf8"), keyring);
    expect(compressed.ciphertext.length * 5).toBeLessThan(plain.ciphertext.length);
    await expect(decryptEmailBody(compressed, keyring)).resolves.toEqual(body);
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

  describe("row binding", () => {
    const owner = { teamId: "team-a", rowId: "row-1" };

    it("opens only on the row it was sealed for", async () => {
      const body = { html: "<p>bound</p>", text: null };
      const encrypted = await encryptEmailBody(body, keyring, owner);
      expect(encrypted.keyVersion).toBe(1 + BOUND_ENVELOPE_VERSION_OFFSET);
      await expect(decryptEmailBody(encrypted, keyring, owner)).resolves.toEqual(body);
      // Columns copied onto another row of the same team.
      await expect(
        decryptEmailBody(encrypted, keyring, { ...owner, rowId: "row-2" }),
      ).rejects.toThrow();
      // Columns copied onto another team's row.
      await expect(
        decryptEmailBody(encrypted, keyring, { ...owner, teamId: "team-b" }),
      ).rejects.toThrow();
      // Same row, replayed as a different kind of payload.
      await expect(
        decryptPayload(encrypted, keyring, { ...owner, kind: "webhook_secret" }),
      ).rejects.toThrow();
      // Bound rows never open unbound.
      await expect(decryptEmailBody(encrypted, keyring)).rejects.toThrow(/row binding/);
    });

    it("still opens legacy envelopes sealed without a binding", async () => {
      const legacy = await encryptEmailBody({ html: null, text: "old" }, keyring);
      expect(legacy.keyVersion).toBe(1);
      await expect(decryptEmailBody(legacy, keyring, owner)).resolves.toEqual({
        html: null,
        text: "old",
      });
    });

    it("binds attachments to their email row", async () => {
      const attachments = [{ filename: "a.txt", content: Buffer.from("hi").toString("base64") }];
      const sealed = await sealAttachments(attachments, keyring, owner);
      await expect(openAttachments(sealed, keyring, owner)).resolves.toEqual(attachments);
      await expect(
        openAttachments(sealed, keyring, { ...owner, rowId: "row-2" }),
      ).rejects.toThrow();
    });

    it("keeps the raw payload primitive bound by kind", async () => {
      const binding = { ...owner, kind: "webhook_secret" as const };
      const encrypted = await encryptPayload(Buffer.from("whsec"), keyring, binding);
      await expect(decryptPayload(encrypted, keyring, binding)).resolves.toEqual(
        Buffer.from("whsec"),
      );
    });
  });
});

describe("EnvKeyring.fromBase64", () => {
  it("rejects non-canonical or wrong-length keys", () => {
    const key = randomBytes(32).toString("base64");
    expect(() => EnvKeyring.fromBase64(key)).not.toThrow();
    // Buffer.from would silently drop the foreign character.
    expect(() => EnvKeyring.fromBase64(`${key.slice(0, 10)}!${key.slice(10)}`)).toThrow(
      /canonical base64/,
    );
    expect(() => EnvKeyring.fromBase64(randomBytes(31).toString("base64"))).toThrow(
      /canonical base64/,
    );
    expect(() => EnvKeyring.fromBase64(key.replace(/=+$/, ""))).toThrow(/canonical base64/);
  });
});
