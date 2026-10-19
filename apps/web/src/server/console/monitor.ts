import { abuseJudgeConfig, env } from "@millionsend/config";
import {
  getMonitorSettingsRow,
  type MonitorSettings,
  resolveMonitorSettings,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";

/** What the console says about the judge: off, or the TypeSafe model the env names. */
export type JudgeStatus =
  | { on: false }
  | {
      on: true;
      provider: "typesafe";
      model: string;
      region: string | null;
      baseUrl: string | null;
    };

export function judgeStatus(): JudgeStatus {
  const config = abuseJudgeConfig();
  if (!config) return { on: false };
  return {
    on: true,
    provider: config.provider,
    model: config.model,
    region: null,
    baseUrl: config.baseUrl,
  };
}

/** The monitor's settings as this instance resolves them: the console's row, then the env, then the defaults. */
export async function monitorSettingsNow(db: Db): Promise<MonitorSettings> {
  return resolveMonitorSettings(
    await getMonitorSettingsRow(db),
    env as unknown as Record<string, unknown>,
  ).settings;
}
