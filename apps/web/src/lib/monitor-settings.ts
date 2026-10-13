// Pure helpers for the console's monitoring settings form; client-safe.

export type MonitorSettingKind = "count" | "rate" | "multiplier" | "bool" | "score";

/** The largest count an override can store: the columns are int4. */
export const MONITOR_COUNT_MAX = 2_147_483_647;

/** The same rule the router enforces per kind, so the form can refuse before it sends. */
export function validMonitorValue(kind: MonitorSettingKind, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  switch (kind) {
    case "rate":
      return value >= 0 && value <= 1;
    case "multiplier":
      return value >= 1;
    case "score":
      return Number.isInteger(value) && value >= 0 && value <= 100;
    case "count":
      return Number.isInteger(value) && value >= 0 && value <= MONITOR_COUNT_MAX;
    default:
      return false;
  }
}

/** The colour a monitor risk reads in: danger from the alert line, warn from the flag line. */
export function riskColor(risk: number, flagRisk = 0.5, alertRisk = 0.7): string | undefined {
  return risk >= alertRisk ? "var(--ms-danger)" : risk >= flagRisk ? "var(--ms-warn)" : undefined;
}

/** "0.54" for a risk; the internal number the operator reads, never a percentage. */
export function formatRisk(risk: number): string {
  return risk.toFixed(2);
}
