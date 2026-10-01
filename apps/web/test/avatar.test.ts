import { describe, expect, it } from "vitest";
import { initials } from "@/lib/avatar";

describe("initials", () => {
  it("takes the first and last word initials, uppercased", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("ada")).toBe("A");
    expect(initials("ada@example.com")).toBe("A");
    expect(initials("Ada King, Countess of Lovelace")).toBe("AL");
    expect(initials("  ")).toBe("");
  });
});
