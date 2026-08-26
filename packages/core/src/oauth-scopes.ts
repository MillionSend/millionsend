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
  "broadcasts:write",
  "domains:read",
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

/** Path of the MCP endpoint on the public API host (RFC 8707 resource = API base + this). */
export const MCP_RESOURCE_PATH = "/mcp";

// ponytail: assumes the API listens on port 3001 of the dashboard host (the
// docker-compose default). Add a dedicated public-API-URL env when a reverse
// proxy serves the API elsewhere.
export function apiBaseUrl(appBaseUrl: string | undefined): string {
  const url = new URL(appBaseUrl ?? "http://localhost:3000");
  return `${url.protocol}//${url.hostname}:3001`;
}

/**
 * Canonical RFC 8707 resource identifier OAuth access tokens are bound to.
 * The authorization server stamps it as `aud`; the API verifies it — both
 * derive it from APP_BASE_URL through this one function so they can't drift.
 */
export function mcpResourceUrl(appBaseUrl: string | undefined): string {
  return `${apiBaseUrl(appBaseUrl)}${MCP_RESOURCE_PATH}`;
}
