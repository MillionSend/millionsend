import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { sql } from "drizzle-orm";

const RATE_WINDOW_MS = 60_000;
const RATE_COUNTER_SWEEP_SIZE = 10_000;

export const TEAM_RATE_LIMIT_PER_MINUTE_DEFAULT = 3000;

export interface WindowCount {
  count: number;
  retryAfterSec: number;
}

/**
 * Fixed-window hit counter. Returns the count for `key` in the current
 * window after this hit, plus the seconds until the window rolls over.
 * ponytail: per-process; the DB bucket table is keyed by api_key uuid, so
 * move these there (text key) if the API ever runs more than one replica.
 */
export function fixedWindowCounter() {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return (key: string, now = Date.now()): WindowCount => {
    const windowStart = now - (now % RATE_WINDOW_MS);
    if (hits.size > RATE_COUNTER_SWEEP_SIZE) {
      for (const [k, v] of hits) if (v.windowStart !== windowStart) hits.delete(k);
    }
    const current = hits.get(key);
    const count = current?.windowStart === windowStart ? current.count + 1 : 1;
    hits.set(key, { windowStart, count });
    return {
      count,
      retryAfterSec: Math.max(1, Math.ceil((windowStart + RATE_WINDOW_MS - now) / 1000)),
    };
  };
}

/**
 * The same as fixedWindowCounter for one API key's minute in
 * api_rate_limits. The upsert is atomic and the window follows the database
 * clock, so every process that spends a key (each API replica, the SMTP
 * relay) draws on one budget.
 */
export async function countApiKeyRequest(db: Db, apiKeyId: string): Promise<WindowCount> {
  const bucket = schema.apiRateLimits;
  const windowStart = sql<Date>`date_trunc('minute', now())`;
  const [row] = await db
    .insert(bucket)
    .values({ apiKeyId, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: bucket.apiKeyId,
      set: {
        windowStart,
        count: sql`case when ${bucket.windowStart} = ${windowStart} then ${bucket.count} + 1 else 1 end`,
      },
    })
    .returning({
      count: bucket.count,
      retryAfter: sql<number>`greatest(1, ceil(extract(epoch from (${bucket.windowStart} + interval '1 minute' - now()))))::int`,
    });
  return { count: row?.count ?? 0, retryAfterSec: row?.retryAfter ?? 60 };
}
