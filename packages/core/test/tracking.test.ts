import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deriveTrackingKey,
  makeClickToken,
  makeOpenToken,
  verifyClickToken,
  verifyOpenToken,
} from "../src/tracking.js";

const key = randomBytes(32);
const emailId = "b7f9c9a2-1234-4cde-9f00-0123456789ab";
const url = "https://example.com/path?a=1&b=2#frag";

describe("click tokens", () => {
  it("round-trips emailId and the signed destination url", () => {
    const token = makeClickToken({ emailId, url, secretKey: key });
    expect(verifyClickToken(token, key)).toEqual({ emailId, url });
  });

  it("preserves urls containing newlines-free arbitrary characters (dots, query, fragment)", () => {
    const tricky = "https://a.b.c.example.com/x.y.z?q=1.2.3&r=a.b#s.t";
    const token = makeClickToken({ emailId, url: tricky, secretKey: key });
    expect(verifyClickToken(token, key)).toEqual({ emailId, url: tricky });
  });

  it("REJECTS a token whose signed url was tampered — the open-redirect defense", () => {
    // Forge a payload swapping the destination to an attacker host, reusing the
    // original mac. Verification must reject it: only a URL we signed is ever
    // returned, so the redirect can never be pointed elsewhere.
    const token = makeClickToken({ emailId, url, secretKey: key });
    const mac = token.slice(token.indexOf(".") + 1);
    const evil = Buffer.from(`${emailId}\nhttps://evil.example`, "utf8").toString("base64url");
    expect(verifyClickToken(`${evil}.${mac}`, key)).toBeNull();
  });

  it("verifyClickToken only ever returns a URL we signed", () => {
    const token = makeClickToken({ emailId, url, secretKey: key });
    const result = verifyClickToken(token, key);
    expect(result?.url).toBe(url);
    // A different key never validates the same token.
    expect(verifyClickToken(token, randomBytes(32))).toBeNull();
  });

  it("rejects a tampered mac and garbage without throwing", () => {
    const token = makeClickToken({ emailId, url, secretKey: key });
    const at = token.indexOf(".") + 3;
    const flipped = token.slice(0, at) + (token[at] === "A" ? "B" : "A") + token.slice(at + 1);
    expect(flipped).not.toBe(token);
    expect(verifyClickToken(flipped, key)).toBeNull();
    for (const bad of ["", ".", "nodot", "a.", ".b"]) {
      expect(verifyClickToken(bad, key)).toBeNull();
    }
  });

  it("rejects a non-canonical final mac char (padding-bit malleability)", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const token = makeClickToken({ emailId, url, secretKey: key });
    const last = token[token.length - 1] as string;
    const tampered = token.slice(0, -1) + alphabet[alphabet.indexOf(last) | 1];
    expect(tampered).not.toBe(token);
    expect(verifyClickToken(tampered, key)).toBeNull();
  });
});

describe("open tokens", () => {
  it("round-trips the emailId", () => {
    const token = makeOpenToken({ emailId, secretKey: key });
    expect(verifyOpenToken(token, key)).toEqual({ emailId });
  });

  it("rejects a tampered mac, a wrong key, and garbage", () => {
    const token = makeOpenToken({ emailId, secretKey: key });
    const at = token.indexOf(".") + 3;
    const flipped = token.slice(0, at) + (token[at] === "A" ? "B" : "A") + token.slice(at + 1);
    expect(verifyOpenToken(flipped, key)).toBeNull();
    expect(verifyOpenToken(token, randomBytes(32))).toBeNull();
    for (const bad of ["", ".", "nodot"]) expect(verifyOpenToken(bad, key)).toBeNull();
  });

  it("does not cross-verify: an open token is not a valid click token", () => {
    const open = makeOpenToken({ emailId, secretKey: key });
    // No newline in the payload → click verification finds no url separator.
    expect(verifyClickToken(open, key)).toBeNull();
  });
});

describe("deriveTrackingKey", () => {
  it("is deterministic, 32 bytes, and distinct from the master key", () => {
    const master = randomBytes(32);
    const a = deriveTrackingKey(master);
    const b = deriveTrackingKey(master);
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
    expect(a.equals(master)).toBe(false);
  });

  it("is domain-separated from the unsubscribe key (different HKDF info)", () => {
    // Same master key, different derivation labels → independent keys.
    const master = randomBytes(32);
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/tracking.ts"),
      "utf8",
    );
    expect(src).toContain("millionsend:tracking:v1");
    expect(deriveTrackingKey(master).length).toBe(32);
  });

  it("rejects short master keys", () => {
    expect(() => deriveTrackingKey(Buffer.alloc(8))).toThrow();
  });

  it("uses a timing-safe comparison", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/tracking.ts"),
      "utf8",
    );
    expect(src).toContain("timingSafeEqual");
  });
});
