import { describe, expect, it } from "vitest";
import { sniffImageType } from "@/lib/image-type";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
]);

describe("sniffImageType", () => {
  it("identifies png, jpeg, and webp by magic bytes", () => {
    expect(sniffImageType(PNG)).toBe("png");
    expect(sniffImageType(JPEG)).toBe("jpeg");
    expect(sniffImageType(WEBP)).toBe("webp");
  });

  it("rejects svg and other non-raster content regardless of claimed type", () => {
    expect(
      sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeNull();
    expect(sniffImageType(new TextEncoder().encode("GIF89a......"))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });

  it("rejects a truncated or corrupted png header", () => {
    expect(sniffImageType(PNG.slice(0, 4))).toBeNull();
    const corrupt = PNG.slice();
    corrupt[5] = 0x00;
    expect(sniffImageType(corrupt)).toBeNull();
  });

  it("requires both RIFF and WEBP markers for webp", () => {
    const riffOnly = WEBP.slice();
    riffOnly[8] = 0x41;
    expect(sniffImageType(riffOnly)).toBeNull();
  });
});
