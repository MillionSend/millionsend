import { describe, expect, it } from "vitest";
import { extractTokenPrefix, generateApiKey, hashApiKey, verifyApiKey } from "../src/api-keys.js";

describe("api keys", () => {
  it("generates the documented shape", () => {
    const key = generateApiKey();
    expect(key.token).toMatch(/^ms_[A-Za-z0-9_-]{32}$/);
    expect(key.tokenPrefix).toBe(key.token.slice(0, "ms_".length + 6));
    expect(key.last4).toBe(key.token.slice(-4));
    expect(key.keyHash).toBe(hashApiKey(key.token));
  });

  it("verifies the original token and rejects others", () => {
    const key = generateApiKey();
    expect(verifyApiKey(key.token, key.keyHash)).toBe(true);
    // Flip the last char to one guaranteed different — a fixed "x" collides
    // with tokens that already end in "x".
    const flipped = key.token.endsWith("x") ? "y" : "x";
    expect(verifyApiKey(`${key.token.slice(0, -1)}${flipped}`, key.keyHash)).toBe(false);
    expect(verifyApiKey(generateApiKey().token, key.keyHash)).toBe(false);
  });

  it("rejects malformed stored hashes without throwing", () => {
    expect(verifyApiKey("ms_whatever", "notahex")).toBe(false);
  });

  it("extracts lookup prefixes only from well-formed tokens", () => {
    const key = generateApiKey();
    expect(extractTokenPrefix(key.token)).toBe(key.tokenPrefix);
    expect(extractTokenPrefix("sk_live_abcdef123")).toBeNull();
    expect(extractTokenPrefix("ms_ab")).toBeNull();
  });
});
