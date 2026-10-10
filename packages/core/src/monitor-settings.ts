import { type Env, isCloudDeployment } from "@millionsend/config";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";

/**
 * The content monitor's sampling rates, caps and thresholds. Each is a
 * nullable instance_settings column (the console edits it), then a MONITOR_*
 * env value, then the built-in default: the same db > env > default
 * precedence the send rate and retention days follow. Rates are fractions of
 * accepted messages, counts are integers, scores are 0–100.
 */
export const MONITOR_SETTINGS = {
  firstSends: {
    column: "monitorFirstSends",
    env: "MONITOR_FIRST_SENDS",
    kind: "count",
    default: 1000,
  },
  firstHours: {
    column: "monitorFirstHours",
    env: "MONITOR_FIRST_HOURS",
    kind: "count",
    default: 72,
  },
  rampSends: {
    column: "monitorRampSends",
    env: "MONITOR_RAMP_SENDS",
    kind: "count",
    default: 10_000,
  },
  rampRate: { column: "monitorRampRate", env: "MONITOR_RAMP_RATE", kind: "rate", default: 0.25 },
  rampDays: { column: "monitorRampDays", env: "MONITOR_RAMP_DAYS", kind: "count", default: 7 },
  probationRate: {
    column: "monitorProbationRate",
    env: "MONITOR_PROBATION_RATE",
    kind: "rate",
    default: 0.05,
  },
  establishedRate: {
    column: "monitorEstablishedRate",
    env: "MONITOR_ESTABLISHED_RATE",
    kind: "rate",
    default: 0.02,
  },
  trustedRate: {
    column: "monitorTrustedRate",
    env: "MONITOR_TRUSTED_RATE",
    kind: "rate",
    default: 0.005,
  },
  broadcastCopies: {
    column: "monitorBroadcastCopies",
    env: "MONITOR_BROADCAST_COPIES",
    kind: "count",
    default: 3,
  },
  broadcastCopiesNew: {
    column: "monitorBroadcastCopiesNew",
    env: "MONITOR_BROADCAST_COPIES_NEW",
    kind: "count",
    default: 10,
  },
  anomalyMultiplier: {
    column: "monitorAnomalyMultiplier",
    env: "MONITOR_ANOMALY_MULTIPLIER",
    kind: "multiplier",
    default: 20,
  },
  teamDailyCap: {
    column: "monitorTeamDailyCap",
    env: "MONITOR_TEAM_DAILY_CAP",
    kind: "count",
    default: 600,
  },
  instanceDailyCap: {
    column: "monitorInstanceDailyCap",
    env: "MONITOR_INSTANCE_DAILY_CAP",
    kind: "count",
    default: 50_000,
  },
  flagRisk: { column: "monitorFlagRisk", env: "MONITOR_FLAG_RISK", kind: "rate", default: 0.5 },
  alertRisk: { column: "monitorAlertRisk", env: "MONITOR_ALERT_RISK", kind: "rate", default: 0.7 },
  pauseRisk: { column: "monitorPauseRisk", env: "MONITOR_PAUSE_RISK", kind: "rate", default: 0.85 },
  autoPause: { column: "monitorAutoPause", env: "MONITOR_AUTO_PAUSE", kind: "bool", default: true },
  flagScore: { column: "monitorFlagScore", env: "MONITOR_FLAG_SCORE", kind: "score", default: 70 },
  autoHold: { column: "monitorAutoHold", env: "MONITOR_AUTO_HOLD", kind: "bool", default: true },
  holdScore: { column: "monitorHoldScore", env: "MONITOR_HOLD_SCORE", kind: "score", default: 90 },
  holdRepeatCount: {
    column: "monitorHoldRepeatCount",
    env: "MONITOR_HOLD_REPEAT_COUNT",
    kind: "count",
    default: 5,
  },
  holdRepeatScore: {
    column: "monitorHoldRepeatScore",
    env: "MONITOR_HOLD_REPEAT_SCORE",
    kind: "score",
    default: 80,
  },
  // The new-domain warm-up: on for the cloud, off for self-host, and the
  // daily cap of each age tier (see domain-warmup.ts).
  warmupEnabled: {
    column: "warmupEnabled",
    env: "WARMUP_ENABLED",
    kind: "bool",
    default: false,
    cloudDefault: true,
  },
  warmupCapFirstDay: {
    column: "warmupCapFirstDay",
    env: "WARMUP_CAP_FIRST_DAY",
    kind: "count",
    default: 100,
  },
  warmupCapFirstWeek: {
    column: "warmupCapFirstWeek",
    env: "WARMUP_CAP_FIRST_WEEK",
    kind: "count",
    default: 300,
  },
  warmupCapFirstMonth: {
    column: "warmupCapFirstMonth",
    env: "WARMUP_CAP_FIRST_MONTH",
    kind: "count",
    default: 2000,
  },
} as const satisfies Record<
  string,
  {
    column: keyof typeof schema.monitorSettingColumns;
    env: string;
    kind: "count" | "rate" | "multiplier" | "bool" | "score";
    default: number | boolean;
    /** The built-in default on the cloud, where it differs from self-host's. */
    cloudDefault?: boolean;
  }
>;

export type MonitorSettingKey = keyof typeof MONITOR_SETTINGS;
export const MONITOR_SETTING_KEYS = Object.keys(MONITOR_SETTINGS) as MonitorSettingKey[];

export type MonitorSettings = {
  [K in MonitorSettingKey]: (typeof MONITOR_SETTINGS)[K]["default"] extends boolean
    ? boolean
    : number;
};

export const MONITOR_SETTING_DEFAULTS = Object.fromEntries(
  MONITOR_SETTING_KEYS.map((key) => [key, MONITOR_SETTINGS[key].default]),
) as MonitorSettings;

/** The stored overrides: every monitor column of the instance_settings row, null when unset. */
export type MonitorSettingsRow = {
  [K in keyof typeof schema.monitorSettingColumns]: number | boolean | null;
};

type Kind = (typeof MONITOR_SETTINGS)[MonitorSettingKey]["kind"];

/** A value is valid for its kind: rates within [0, 1], counts whole and non-negative, scores 0–100. */
export function isValidMonitorSetting(key: MonitorSettingKey, value: number | boolean): boolean {
  const kind: Kind = MONITOR_SETTINGS[key].kind;
  if (kind === "bool") return typeof value === "boolean";
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  switch (kind) {
    case "rate":
      return value >= 0 && value <= 1;
    case "multiplier":
      return value >= 1;
    case "score":
      return Number.isInteger(value) && value >= 0 && value <= 100;
    default:
      return Number.isInteger(value) && value >= 0;
  }
}

function parseEnv(kind: Kind, raw: unknown): number | boolean | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (kind === "bool") {
    if (typeof raw === "boolean") return raw;
    return raw === "true" || raw === "1"
      ? true
      : raw === "false" || raw === "0"
        ? false
        : undefined;
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export type MonitorSettingSource = "db" | "env" | "default";

/** A key's built-in default for this deployment (`env` as resolveMonitorSettings takes it). */
export function monitorSettingDefault(
  key: MonitorSettingKey,
  env: Record<string, unknown>,
): number | boolean {
  const meta: (typeof MONITOR_SETTINGS)[MonitorSettingKey] = MONITOR_SETTINGS[key];
  return "cloudDefault" in meta && isCloudDeployment(env as Env) ? meta.cloudDefault : meta.default;
}

/**
 * The effective settings and where each came from. `env` may be the
 * validated config or a raw process.env-like object: both forms parse.
 */
export function resolveMonitorSettings(
  row: Partial<MonitorSettingsRow> | null | undefined,
  env: Record<string, unknown>,
): { settings: MonitorSettings; sources: Record<MonitorSettingKey, MonitorSettingSource> } {
  const settings = {} as Record<MonitorSettingKey, number | boolean>;
  const sources = {} as Record<MonitorSettingKey, MonitorSettingSource>;
  for (const key of MONITOR_SETTING_KEYS) {
    const meta = MONITOR_SETTINGS[key];
    const stored = row?.[meta.column];
    const fromEnv = parseEnv(meta.kind, env[meta.env]);
    if (stored !== null && stored !== undefined && isValidMonitorSetting(key, stored)) {
      settings[key] = stored;
      sources[key] = "db";
    } else if (fromEnv !== undefined && isValidMonitorSetting(key, fromEnv)) {
      settings[key] = fromEnv;
      sources[key] = "env";
    } else {
      settings[key] = monitorSettingDefault(key, env);
      sources[key] = "default";
    }
  }
  return { settings: settings as MonitorSettings, sources };
}

/** The flag, alert and pause lines must climb in that order or the policy contradicts itself. */
export function monitorThresholdsOrdered(
  s: Pick<MonitorSettings, "flagRisk" | "alertRisk" | "pauseRisk">,
): boolean {
  return s.flagRisk < s.alertRisk && s.alertRisk < s.pauseRisk;
}

/** The stored monitor overrides, or null when the settings row does not exist. */
export async function getMonitorSettingsRow(db: Db): Promise<MonitorSettingsRow | null> {
  const [row] = await db.select().from(schema.instanceSettings);
  if (!row) return null;
  return Object.fromEntries(
    Object.keys(schema.monitorSettingColumns).map((k) => [
      k,
      row[k as keyof typeof schema.monitorSettingColumns],
    ]),
  ) as MonitorSettingsRow;
}

export const MONITOR_SETTINGS_TTL_MS = 60_000;

/**
 * A reader the worker calls per send: the row is re-read once a minute so a
 * console edit applies without a restart, and a failed read keeps the last
 * answer. `env` is the config proxy (raw strings under SKIP_ENV_VALIDATION).
 */
export function monitorSettingsReader(
  db: Db,
  env: Record<string, unknown>,
  opts: { ttlMs?: number; now?: () => number } = {},
): () => Promise<MonitorSettings> {
  const ttl = opts.ttlMs ?? MONITOR_SETTINGS_TTL_MS;
  const clock = opts.now ?? Date.now;
  let cached: { at: number; value: MonitorSettings } | null = null;
  return async () => {
    const at = clock();
    if (cached && at - cached.at < ttl) return cached.value;
    try {
      const value = resolveMonitorSettings(await getMonitorSettingsRow(db), env).settings;
      cached = { at, value };
    } catch (err) {
      if (!cached) throw err;
      console.warn("monitor settings refresh failed; keeping the last read", err);
      cached = { at, value: cached.value };
    }
    return cached.value;
  };
}
