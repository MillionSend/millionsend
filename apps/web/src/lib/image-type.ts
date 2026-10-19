import type { ImageType } from "@millionsend/core";

/** Formats accepted for team logos. SVG is deliberately excluded: it can carry
 * scripts, and logos are served from the public storage bucket. */
export type LogoImageType = "png" | "jpeg" | "webp";

const LOGO_IMAGE_TYPES: readonly ImageType[] = ["png", "jpeg", "webp"];

export const TEAM_LOGO_MAX_BYTES = 2 * 1024 * 1024;

export const TEAM_LOGO_ACCEPT = "image/png,image/jpeg,image/webp";

/** Whether a format sniffed from the upload's bytes (never its Content-Type) may be a logo. */
export function isLogoImageType(type: ImageType | null): type is LogoImageType {
  return type !== null && LOGO_IMAGE_TYPES.includes(type);
}
