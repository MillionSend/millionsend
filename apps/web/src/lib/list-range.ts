/** "Last N" window options shared by the list filters; "all" means no lower bound. */
export const RANGE_HOURS = { h24: 24, d7: 168, d15: 360, d30: 720 } as const;
export type RangeKey = keyof typeof RANGE_HOURS | "all";

export function rangeSince(range: RangeKey): Date | undefined {
  return range === "all" ? undefined : new Date(Date.now() - RANGE_HOURS[range] * 3_600_000);
}
