import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";

export interface InstanceSettings {
  sesMaxSendRate: number | null;
  emailRetentionDays: number | null;
}

/**
 * Single-row operator overrides (Settings → Instance). null = unset: the
 * caller falls back to the env var, which already carries the built-in
 * default — precedence is db > env > default.
 */
export async function getInstanceSettings(db: Db): Promise<InstanceSettings> {
  const [row] = await db.select().from(schema.instanceSettings);
  return {
    sesMaxSendRate: row?.sesMaxSendRate ?? null,
    emailRetentionDays: row?.emailRetentionDays ?? null,
  };
}
