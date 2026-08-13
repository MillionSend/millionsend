import { describe, expect, it } from "vitest";
import { canonicalBodyHash, canonicalStringify } from "../src/canonical-json.js";

describe("canonical json", () => {
  it("is invariant to key order, recursively", () => {
    const a = { to: ["x@y.z"], from: "a@b.c", tags: { b: "2", a: "1" } };
    const b = { tags: { a: "1", b: "2" }, from: "a@b.c", to: ["x@y.z"] };
    expect(canonicalBodyHash(a)).toBe(canonicalBodyHash(b));
  });

  it("treats array order as significant", () => {
    expect(canonicalBodyHash({ to: ["a", "b"] })).not.toBe(canonicalBodyHash({ to: ["b", "a"] }));
  });

  it("drops undefined properties like JSON.stringify does", () => {
    expect(canonicalStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});
