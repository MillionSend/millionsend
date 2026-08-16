import { describe, expect, it } from "vitest";
import { composeFromAddress, splitFromAddress } from "@/lib/from-address";

describe("splitFromAddress", () => {
  it("splits a full mailbox into name, local, and domain", () => {
    expect(splitFromAddress("Ada <ada@acme.dev>")).toEqual({
      name: "Ada",
      local: "ada",
      domain: "acme.dev",
    });
  });

  it("unquotes and unescapes a quoted display name", () => {
    expect(splitFromAddress('"Acme, Inc." <news@acme.dev>')).toEqual({
      name: "Acme, Inc.",
      local: "news",
      domain: "acme.dev",
    });
    expect(splitFromAddress('"A \\"B\\"" <a@b.c>').name).toBe('A "B"');
  });

  it("handles a bare addr-spec and splits at the last @", () => {
    expect(splitFromAddress("a@b.c")).toEqual({ name: "", local: "a", domain: "b.c" });
    expect(splitFromAddress('"a@b"@c.d').local).toBe('"a@b"');
  });

  it("is forgiving with partial input instead of rejecting", () => {
    expect(splitFromAddress("")).toEqual({ name: "", local: "", domain: "" });
    expect(splitFromAddress("news@")).toEqual({ name: "", local: "news", domain: "" });
    expect(splitFromAddress("Ada <news")).toEqual({ name: "Ada", local: "news", domain: "" });
  });
});

describe("composeFromAddress", () => {
  it("composes only when the addr-spec is complete", () => {
    expect(composeFromAddress({ name: "Ada", local: "", domain: "acme.dev" })).toBe("");
    expect(composeFromAddress({ name: "", local: "a", domain: "" })).toBe("");
    expect(composeFromAddress({ name: "", local: "a", domain: "b.c" })).toBe("a@b.c");
  });

  it("quotes display names that need it, escaping quote/backslash", () => {
    expect(composeFromAddress({ name: "Ada", local: "a", domain: "b.c" })).toBe("Ada <a@b.c>");
    expect(composeFromAddress({ name: "Acme, Inc.", local: "a", domain: "b.c" })).toBe(
      '"Acme, Inc." <a@b.c>',
    );
    expect(composeFromAddress({ name: 'A "B"', local: "a", domain: "b.c" })).toBe(
      '"A \\"B\\"" <a@b.c>',
    );
  });

  it("round-trips through splitFromAddress", () => {
    for (const parts of [
      { name: "Ada", local: "ada", domain: "acme.dev" },
      { name: "Acme, Inc.", local: "news", domain: "acme.dev" },
      { name: "", local: "a", domain: "b.c" },
    ]) {
      expect(splitFromAddress(composeFromAddress(parts))).toEqual(parts);
    }
  });
});
