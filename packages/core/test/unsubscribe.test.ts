import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildUnsubscribeHeaders,
  deriveUnsubscribeKey,
  makeUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../src/unsubscribe.js";

const key = randomBytes(32);
const contactId = "b7f9c9a2-1234-4cde-9f00-0123456789ab";
const topicId = "1e2d3c4b-5a69-4788-9900-aabbccddeeff";

describe("unsubscribe tokens", () => {
  it("round-trips a contactId with no topic (null topicId)", () => {
    const token = makeUnsubscribeToken({ contactId, secretKey: key });
    expect(verifyUnsubscribeToken(token, key)).toEqual({ contactId, topicId: null });
  });

  it("round-trips a contactId and topicId when topic-scoped", () => {
    const token = makeUnsubscribeToken({ contactId, topicId, secretKey: key });
    expect(verifyUnsubscribeToken(token, key)).toEqual({ contactId, topicId });
  });

  it("treats a null/empty topicId as a global token", () => {
    const token = makeUnsubscribeToken({ contactId, topicId: null, secretKey: key });
    expect(verifyUnsubscribeToken(token, key)).toEqual({ contactId, topicId: null });
    // A topic-scoped token's mac must not verify against the global variant.
    const scoped = makeUnsubscribeToken({ contactId, topicId, secretKey: key });
    expect(scoped).not.toBe(token);
  });

  it("rejects a tampered payload", () => {
    const token = makeUnsubscribeToken({ contactId, secretKey: key });
    const [payload, mac] = token.split(".");
    const other = Buffer.from("someone-else", "utf8").toString("base64url");
    expect(verifyUnsubscribeToken(`${other}.${mac}`, key)).toBeNull();
    expect(payload).not.toBe(other);
  });

  it("rejects a tampered mac and a wrong key", () => {
    const token = makeUnsubscribeToken({ contactId, secretKey: key });
    const at = token.indexOf(".") + 3;
    const flipped = token.slice(0, at) + (token[at] === "A" ? "B" : "A") + token.slice(at + 1);
    expect(flipped).not.toBe(token);
    expect(verifyUnsubscribeToken(flipped, key)).toBeNull();
    expect(verifyUnsubscribeToken(token, randomBytes(32))).toBeNull();
  });

  it("rejects a non-canonical final mac char (padding-bit malleability)", () => {
    // The last base64url char of a 32-byte mac carries 2 ignored padding
    // bits: setting one yields a different char that decodes to the same
    // bytes. Verification compares in encoded space and must reject it.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const token = makeUnsubscribeToken({ contactId, secretKey: key });
    const last = token[token.length - 1] as string;
    const tampered = token.slice(0, -1) + alphabet[alphabet.indexOf(last) | 1];
    expect(tampered).not.toBe(token);
    expect(Buffer.from(tampered.split(".")[1] as string, "base64url")).toEqual(
      Buffer.from(token.split(".")[1] as string, "base64url"),
    );
    expect(verifyUnsubscribeToken(tampered, key)).toBeNull();
  });

  it("rejects garbage without throwing", () => {
    for (const bad of ["", ".", "nodot", "a.", ".b", "a.b.c"]) {
      expect(verifyUnsubscribeToken(bad, key)).toBeNull();
    }
  });

  it("uses a timing-safe comparison", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/unsubscribe.ts"),
      "utf8",
    );
    expect(src).toContain("timingSafeEqual");
    expect(src).not.toMatch(/mac\.equals|===\s*expected/);
  });
});

describe("deriveUnsubscribeKey", () => {
  it("is deterministic, 32 bytes, and distinct from the master key", () => {
    const master = randomBytes(32);
    const a = deriveUnsubscribeKey(master);
    const b = deriveUnsubscribeKey(master);
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
    expect(a.equals(master)).toBe(false);
  });

  it("rejects short master keys", () => {
    expect(() => deriveUnsubscribeKey(Buffer.alloc(8))).toThrow();
  });
});

describe("buildUnsubscribeHeaders", () => {
  it("emits RFC 8058 headers with the token in the URL", () => {
    const token = makeUnsubscribeToken({ contactId, secretKey: key });
    const headers = buildUnsubscribeHeaders("https://app.example.com", token);
    expect(headers["List-Unsubscribe"]).toBe(`<https://app.example.com/unsubscribe/${token}>`);
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    // Trailing slash on the base must not double up.
    expect(buildUnsubscribeHeaders("https://app.example.com/", token)["List-Unsubscribe"]).toBe(
      `<https://app.example.com/unsubscribe/${token}>`,
    );
  });
});
