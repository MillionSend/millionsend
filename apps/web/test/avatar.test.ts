import { describe, expect, it } from "vitest";
import { emailSha256, gravatarUrl, initials } from "@/lib/avatar";

describe("emailSha256", () => {
  it("hashes the normalized (trimmed, lowercased) address", async () => {
    // sha256("ada@example.com")
    const expected = "b5fc85e55755f9e0d030a10ab4429b6b2944855f9a0d60077fe832becbc41d72";
    expect(await emailSha256("ada@example.com")).toBe(expected);
    expect(await emailSha256("  Ada@Example.COM ")).toBe(expected);
  });
});

describe("gravatarUrl", () => {
  it("requests the 404 fallback so a missing avatar errors the img", () => {
    expect(gravatarUrl("abc123", 48)).toBe("https://gravatar.com/avatar/abc123?d=404&s=48");
  });
});

describe("initials", () => {
  it("takes the first and last word initials, uppercased", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("ada")).toBe("A");
    expect(initials("ada@example.com")).toBe("A");
    expect(initials("Ada King, Countess of Lovelace")).toBe("AL");
    expect(initials("  ")).toBe("");
  });
});
