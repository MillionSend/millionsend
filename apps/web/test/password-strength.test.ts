import { describe, expect, it } from "vitest";
import { passwordStrength } from "@/lib/password-strength";

describe("passwordStrength", () => {
  it("rates the empty string 0 and anything under 8 chars weak", () => {
    expect(passwordStrength("")).toBe(0);
    expect(passwordStrength("Ab1!x")).toBe(1);
    expect(passwordStrength("abcdefg")).toBe(1);
  });

  it("rates short low-variety passwords weak, mixed ones fair", () => {
    expect(passwordStrength("aaaaaaaa")).toBe(1);
    expect(passwordStrength("abcd1234")).toBe(2);
    expect(passwordStrength("abcdefghij")).toBe(2);
  });

  it("rates long or long-and-varied passwords strong", () => {
    // Length alone suffices: an all-lowercase passphrase is strong.
    expect(passwordStrength("correcthorsebattery")).toBe(3);
    expect(passwordStrength("Abc123!xxxxx")).toBe(3);
    expect(passwordStrength("Abc123xxxx")).toBe(2);
  });
});
