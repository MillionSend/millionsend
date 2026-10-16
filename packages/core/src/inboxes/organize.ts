/**
 * Labels and folders, in the values the dashboard shows as well. Imports
 * nothing, so a client component reads the same numbers core enforces.
 */

/**
 * The colors a label made without one is given, at random: each legible on
 * light and dark. Keyed by the color's name, which the dashboard reads out.
 */
export const LABEL_COLORS = {
  cyan: "#00A2C7",
  teal: "#12A594",
  green: "#46A758",
  lime: "#BDEE63",
  yellow: "#FFE629",
  orange: "#F76B15",
  indigo: "#5B5BD6",
  purple: "#AB4ABA",
  pink: "#E93D82",
  brown: "#A18072",
  gray: "#8E8C99",
} as const;

export const INBOX_LABELS_MAX = 100;

/** Days a thread stays in Trash before it is deleted. */
export const TRASH_RETENTION_DAYS = 30;
