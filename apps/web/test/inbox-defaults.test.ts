import { describe, expect, it } from "vitest";
import { fromNameFromName, localPartFromName } from "@/lib/inbox-defaults";

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

describe("fromNameFromName", () => {
  it("keeps a plain name within from_name's length, and none that from_name would refuse", () => {
    expect(fromNameFromName("Orders agent")).toBe("Orders agent");
    expect(fromNameFromName("x".repeat(80))).toBe("x".repeat(78));
    expect(fromNameFromName("orders@acme.example")).toBe("");
    expect(fromNameFromName("Support: billing")).toBe("");
  });
});
