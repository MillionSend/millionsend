import { LABEL_COLORS } from "@millionsend/core/inbox-organize";

const PALETTE: readonly string[] = Object.values(LABEL_COLORS);

/** A palette color at random: where a new label's color starts, as core picks one for a label made without. */
export function randomLabelColor(): string {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)] ?? LABEL_COLORS.gray;
}

/** Whether a #RRGGBB color is one of the palette's swatches rather than a custom pick. */
export function inLabelPalette(color: string): boolean {
  return PALETTE.includes(color.toUpperCase());
}
