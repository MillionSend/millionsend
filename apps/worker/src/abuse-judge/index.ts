import type { AbuseJudgeConfig } from "@millionsend/config";
import { type AbuseJudge, createTypesafeJudge } from "@millionsend/core";

/** The judge the env names, or null when the monitor is off. */
export function createAbuseJudge(config: AbuseJudgeConfig | null): AbuseJudge | null {
  if (!config) return null;
  return createTypesafeJudge(config);
}
