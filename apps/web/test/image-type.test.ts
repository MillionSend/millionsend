import { sniffImageType } from "@millionsend/core";
import { describe, expect, it } from "vitest";
import { isLogoImageType } from "@/lib/image-type";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
]);
const logo = (bytes: Uint8Array) => isLogoImageType(sniffImageType(bytes));

describe("isLogoImageType", () => {
  it("accepts png, jpeg, and webp by magic bytes", () => {
    expect([PNG, JPEG, WEBP].map(logo)).toEqual([true, true, true]);
  });

  it("rejects svg, gif and anything else regardless of claimed type", () => {
    expect(logo(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(false);
    expect(logo(new TextEncoder().encode("GIF89a......"))).toBe(false);
    expect(logo(new Uint8Array(0))).toBe(false);
  });
});
