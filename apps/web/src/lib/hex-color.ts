/** Strict 6-digit hex — the only color format the unsubscribe page theme accepts. */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value);
}

/**
 * Black or white, whichever holds more WCAG contrast on the given 6-digit
 * hex (YIQ perceived-brightness split). Used for text on accent buttons.
 */
export function contrastTextColor(hex: string): "#000000" | "#ffffff" {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 >= 128 ? "#000000" : "#ffffff";
}
