import { describe, expect, it } from "vitest";
import { jsSingleQuote, shellSingleQuote } from "@/lib/escape";

describe("jsSingleQuote", () => {
  it("escapes apostrophes so an o'brien email stays one literal", () => {
    expect(jsSingleQuote("o'brien@example.com")).toBe("'o\\'brien@example.com'");
  });

  it("escapes backslashes before quotes", () => {
    expect(jsSingleQuote("a\\'b")).toBe("'a\\\\\\'b'");
  });
});

describe("shellSingleQuote", () => {
  it("uses the close-escape-reopen pattern for embedded quotes", () => {
    expect(shellSingleQuote("o'brien@example.com")).toBe("'o'\\''brien@example.com'");
  });

  it("wraps plain values unchanged", () => {
    expect(shellSingleQuote("plain")).toBe("'plain'");
  });
});
