import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull } from "drizzle-orm";
import { extractTokenPrefix, verifyApiKey } from "./api-keys.js";
import { effectivePlan, type Plan } from "./plans.js";

/** SECURITY: the only source of teamId for API-key-authenticated requests. */
export interface ApiKeyAuth {
  teamId: string;
  plan: Plan;
  /** Null when the caller authenticated with an OAuth access token (MCP) instead of a key. */
  apiKeyId: string | null;
  /**
   * SECURITY: the key's scope, enforced server-side. "sending_access" keys may
   * only reach the send surface; a non-null domainId restricts sends to that
   * one domain. Never trust the client to declare either.
   */
  permission: (typeof schema.apiKeys.permission.enumValues)[number];
  domainId: string | null;
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
      permission: schema.apiKeys.permission,
      domainId: schema.apiKeys.domainId,
      plan: schema.teams.plan,
      currentPeriodEnd: schema.teams.currentPeriodEnd,
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
  return {
    teamId: match.teamId,
    plan: effectivePlan(match.plan, match.currentPeriodEnd),
    apiKeyId: match.id,
    permission: match.permission,
    domainId: match.domainId,
  };
}
