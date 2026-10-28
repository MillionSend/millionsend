import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull } from "drizzle-orm";
import { extractTokenPrefix, verifyApiKey } from "./api-keys.js";
import { effectivePlan, type Plan, type QuotaTeamRow } from "./plans.js";
import { QUOTA_COLUMNS } from "./team-plan.js";
import type { TeamRole } from "./team-roles.js";

/** SECURITY: the only source of teamId for API-key-authenticated requests. */
export interface ApiKeyAuth {
  teamId: string;
  plan: Plan;
  /** The team's billing columns, from which each send surface derives its cap (teamQuota). */
  billing: QuotaTeamRow;
  /** Null when the caller authenticated with an OAuth access token (MCP) instead of a key. */
  apiKeyId: string | null;
  /** The OAuth token's holder, so audit rows name the person behind an MCP call. */
  userId?: string;
  /** The OAuth client (connected app) behind an MCP call, so the request log can name it. */
  oauthClientId?: string;
  /**
   * SECURITY: the key's scope, enforced server-side. "sending_access" keys may
   * only reach the send surface; a non-null domainId restricts sends to that
   * one domain. Never trust the client to declare either.
   */
  permission: (typeof schema.apiKeys.permission.enumValues)[number];
  domainId: string | null;
  /**
   * SECURITY: a non-null inboxId confines the key to that inbox's routes
   * (an allow-list in the API) and to sending from its address. Null for
   * every OAuth (MCP) call.
   */
  inboxId: string | null;
  /**
   * SECURITY: the OAuth token holder's live team role, set on MCP calls only.
   * Owner/admin-only routes refuse any other role. An API key carries none:
   * only owners and admins can create a full-access key.
   */
  role?: TeamRole;
}

export { isAdminRole, type TeamRole } from "./team-roles.js";

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
      inboxId: schema.apiKeys.inboxId,
      inboxExpiresAt: schema.inboxes.expiresAt,
      ...QUOTA_COLUMNS,
    })
    .from(schema.apiKeys)
    .innerJoin(schema.teams, eq(schema.apiKeys.teamId, schema.teams.id))
    .leftJoin(schema.inboxes, eq(schema.inboxes.id, schema.apiKeys.inboxId))
    .where(and(eq(schema.apiKeys.tokenPrefix, prefix), isNull(schema.apiKeys.revokedAt)));
  const match = candidates.find((k) => verifyApiKey(token, k.keyHash));
  if (!match) return null;
  const {
    id,
    keyHash,
    teamId,
    lastUsedAt,
    permission,
    domainId,
    inboxId,
    inboxExpiresAt,
    ...billing
  } = match;
  const now = Date.now();
  // An inbox key dies with its inbox's lifetime, before the sweep revokes it.
  if (inboxExpiresAt && inboxExpiresAt.getTime() <= now) return null;
  if (!lastUsedAt || now - lastUsedAt.getTime() > LAST_USED_STAMP_INTERVAL_MS) {
    db.update(schema.apiKeys)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(schema.apiKeys.id, id))
      .then(
        () => undefined,
        () => undefined,
      );
  }
  return {
    teamId,
    plan: effectivePlan(billing.plan, billing.currentPeriodEnd),
    billing,
    apiKeyId: id,
    permission,
    domainId,
    inboxId,
  };
}
