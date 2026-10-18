import { describe, expect, it } from "vitest";
import { localPartFromName } from "@/lib/inbox-defaults";

describe("localPartFromName", () => {
  it("slugs the name into a local part", () => {
    expect(localPartFromName("Orders agent")).toBe("orders-agent");
    expect(localPartFromName("Ação rápida")).toBe("acao-rapida");
    expect(localPartFromName("Sales -- & support!!")).toBe("sales-support");
    expect(localPartFromName("")).toBe("");
  });

  it("stays within an address's 64 characters, with no dash left at the end", () => {
    expect(localPartFromName(`${"a".repeat(63)} ${"b".repeat(10)}`)).toBe("a".repeat(63));
    expect(localPartFromName("x".repeat(80))).toBe("x".repeat(64));
  });
});
