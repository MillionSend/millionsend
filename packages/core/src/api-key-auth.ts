import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull } from "drizzle-orm";
import { extractTokenPrefix, verifyApiKey } from "./api-keys.js";
import type { Plan } from "./plans.js";

/** SECURITY: the only source of teamId for API-key-authenticated requests. */
export interface ApiKeyAuth {
  teamId: string;
  plan: Plan;
  apiKeyId: string;
}

const LAST_USED_STAMP_INTERVAL_MS = 60_000;

/**
 * Verify a presented ms_ token against stored key hashes and resolve its
 * team + plan. The one verification path for every authenticated surface
 * (HTTP Authorization header, SMTP AUTH password). Stamps last_used_at at
 * most once per interval, fire-and-forget — a stamp failure must never fail
 * the request.
 */
export async function authenticateApiKey(db: Db, token: string): Promise<ApiKeyAuth | null> {
  const prefix = extractTokenPrefix(token);
  if (!prefix) return null;
  const candidates = await db
    .select({
      id: schema.apiKeys.id,
      keyHash: schema.apiKeys.keyHash,
      teamId: schema.apiKeys.teamId,
      lastUsedAt: schema.apiKeys.lastUsedAt,
      plan: schema.teams.plan,
    })
    .from(schema.apiKeys)
    .innerJoin(schema.teams, eq(schema.apiKeys.teamId, schema.teams.id))
    .where(and(eq(schema.apiKeys.tokenPrefix, prefix), isNull(schema.apiKeys.revokedAt)));
  const match = candidates.find((k) => verifyApiKey(token, k.keyHash));
  if (!match) return null;
  const now = Date.now();
  if (!match.lastUsedAt || now - match.lastUsedAt.getTime() > LAST_USED_STAMP_INTERVAL_MS) {
    db.update(schema.apiKeys)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(schema.apiKeys.id, match.id))
      .then(
        () => undefined,
        () => undefined,
      );
  }
  return { teamId: match.teamId, plan: match.plan, apiKeyId: match.id };
}
