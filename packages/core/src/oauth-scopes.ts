/**
 * OAuth scopes MCP clients can be granted. The authorization server
 * (apps/web) advertises them and the MCP resource server (apps/api) gates
 * tools on them, so the list lives here where both can import it.
 */
export const MCP_SCOPES = [
  "emails:send",
  "emails:read",
  "audience:read",
  "audience:write",
  "broadcasts:read",
  "broadcasts:write",
  "domains:read",
  "domains:write",
  "templates:read",
  "templates:write",
  // One scope for the whole webhook surface: even reads return signing
  // secrets (the SDK wire retrieves them by design), so a read/write split
  // would imply a safety boundary that does not exist.
  "webhooks:write",
  // One scope for API keys as well: listing never returns a token, but the
  // surface exists to mint credentials, so it is granted as a whole.
  "api-keys:write",
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

/**
 * Scopes whose tools are owner/admin only (the dashboard's adminProcedure
 * line): the consent page withholds them from members and the MCP server
 * refuses their tools for a member's token regardless of what it carries.
 */
export const ADMIN_MCP_SCOPES = [
  "domains:write",
  "webhooks:write",
  "api-keys:write",
] as const satisfies McpScope[];

/**
 * Grant referenceId / token team_id meaning "every team the user belongs
 * to", resolved per call. Not a uuid, so it can never collide with a team id.
 */
export const ALL_TEAMS_GRANT = "*";

/** Path of the MCP endpoint on the public API host (RFC 8707 resource = API base + this). */
export const MCP_RESOURCE_PATH = "/mcp";

/**
 * Public origin of the API. Without an explicit value this assumes the API
 * listens on port 3001 of the dashboard host, which is the docker-compose
 * shape every self-host starts from. A deployment whose reverse proxy serves
 * the API on its own hostname (PUBLIC_API_URL) gets that instead — the
 * derived host:port is unroutable there, and it is what the dashboard prints
 * as the API base and what MCP tokens are bound to.
 *
 * The trailing slash is stripped because callers concatenate a path onto the
 * result, and a doubled slash is a different RFC 8707 resource identifier.
 */
export function apiBaseUrl(
  appBaseUrl: string | undefined,
  publicApiUrl?: string | undefined,
): string {
  if (publicApiUrl) return publicApiUrl.replace(/\/+$/, "");
  const url = new URL(appBaseUrl ?? "http://localhost:3000");
  return `${url.protocol}//${url.hostname}:3001`;
}

/**
 * Canonical RFC 8707 resource identifier OAuth access tokens are bound to.
 * The authorization server stamps it as `aud`; the API verifies it — both
 * derive it through this one function so they can't drift.
 */
export function mcpResourceUrl(
  appBaseUrl: string | undefined,
  publicApiUrl?: string | undefined,
): string {
  return `${apiBaseUrl(appBaseUrl, publicApiUrl)}${MCP_RESOURCE_PATH}`;
}
