import { expect, it } from "vitest";
import { secretsEqual, sha256Hex } from "../src/hash.js";

it("hashes strings as UTF-8 and bytes as given", () => {
  expect(sha256Hex("abc")).toBe(sha256Hex(Buffer.from("abc", "utf8")));
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

it("compares secrets of any lengths", () => {
  const secret = "s".repeat(40);
  expect(secretsEqual(secret, secret)).toBe(true);
  expect(secretsEqual(`${secret}x`, secret)).toBe(false);
  expect(secretsEqual("", secret)).toBe(false);
  expect(secretsEqual(secret.slice(1), secret)).toBe(false);
});
