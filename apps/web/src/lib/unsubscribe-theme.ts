import type { CSSProperties } from "react";
import { contrastTextColor, isHexColor } from "./hex-color";

export interface UnsubscribeThemeColors {
  backgroundColor: string | null;
  textColor: string | null;
  accentColor: string | null;
}

/**
 * Inline-style theme for the public unsubscribe page. The values end up in
 * style attributes on an unauthenticated page, so this is the last validation
 * boundary: anything that is not a strict 6-digit hex is dropped, regardless
 * of what a caller passes. Surfaces and lines are derived by mixing the text
 * color into the background, so two colors retheme card, borders, and inputs.
 */
export function unsubscribeThemeStyle(colors: UnsubscribeThemeColors): CSSProperties {
  const bg =
    colors.backgroundColor && isHexColor(colors.backgroundColor) ? colors.backgroundColor : null;
  const text = colors.textColor && isHexColor(colors.textColor) ? colors.textColor : null;
  const style: Record<string, string> = {};
  if (bg) {
    style.background = bg;
    style["--ms-void"] = bg;
    style["--ms-ground"] = bg;
    style["--ms-panel"] = `color-mix(in srgb, var(--ms-bone) 5%, ${bg})`;
    style["--ms-panel-raised"] = `color-mix(in srgb, var(--ms-bone) 10%, ${bg})`;
    style["--ms-inset"] = `color-mix(in srgb, var(--ms-bone) 8%, ${bg})`;
    style["--ms-line"] = `color-mix(in srgb, var(--ms-bone) 14%, ${bg})`;
    style["--ms-line-strong"] = `color-mix(in srgb, var(--ms-bone) 22%, ${bg})`;
  }
  if (text) {
    style.color = text;
    style["--ms-bone"] = text;
    style["--ms-muted"] = `color-mix(in srgb, ${text} 62%, transparent)`;
    style["--ms-faint"] = `color-mix(in srgb, ${text} 38%, transparent)`;
  }
  return style as CSSProperties;
}

/** Style for the accent CTA button; undefined when no valid accent is set. */
export function unsubscribeAccentStyle(accentColor: string | null): CSSProperties | undefined {
  if (!accentColor || !isHexColor(accentColor)) return undefined;
  return { background: accentColor, color: contrastTextColor(accentColor) };
}
