/** Formats accepted for team logos. SVG is deliberately excluded: it can carry
 * scripts, and logos are served from the public storage bucket. */
export type LogoImageType = "png" | "jpeg" | "webp";

export const TEAM_LOGO_MAX_BYTES = 2 * 1024 * 1024;

export const TEAM_LOGO_ACCEPT = "image/png,image/jpeg,image/webp";

/**
 * Identifies the image format from magic bytes — the client-supplied
 * Content-Type is never trusted. Returns null for anything else.
 */
export function sniffImageType(bytes: Uint8Array): LogoImageType | null {
  const ascii = (start: number, text: string) =>
    [...text].every((ch, i) => bytes[start + i] === ch.charCodeAt(0));
  if (
    bytes[0] === 0x89 &&
    ascii(1, "PNG") &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
  return null;
}
