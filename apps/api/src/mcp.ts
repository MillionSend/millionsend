import { type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  type ApiKeyAuth,
  MCP_RESOURCE_PATH,
  MCP_SCOPES,
  type McpScope,
  mcpResourceUrl,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import {
  type AuthInfo,
  type CallToolResult,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
  requireBearerAuth,
  type StandardSchemaWithJSON,
  type ToolCallback,
} from "@modelcontextprotocol/server";
import { and, eq } from "drizzle-orm";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { type ApiDeps, type Env, errorBody } from "./app.js";
import {
  createBroadcastRequestSchema,
  createContactRequestSchema,
  listQuerySchema,
  sendBroadcastRequestSchema,
  sendEmailRequestSchema,
  updateContactRequestSchema,
} from "./schemas.js";

/**
 * SECURITY: the only way a request reaches the REST handlers without an API
 * key. MCP tools call the public API in-process so every rule it enforces
 * (verified sender, suppression, topic opt-outs, quotas, validation, request
 * logging) applies unchanged. Entries are keyed by Request identity, which
 * nothing outside this process can populate — no header or body forges one.
 */
export const INTERNAL_AUTH = new WeakMap<Request, ApiKeyAuth>();

interface McpAuthExtra {
  auth: ApiKeyAuth;
  userId: string;
}

const accessTokenClaims = z.object({
  sub: z.string().min(1),
  client_id: z.string().min(1),
  scope: z.string(),
  team_id: z.uuid(),
  exp: z.number(),
});

const isMcpScope = (s: string): s is McpScope => (MCP_SCOPES as readonly string[]).includes(s);

/**
 * Verifies an access token minted by the dashboard's authorization server:
 * signature via its JWKS, `iss`/`aud`/`exp` via jose, then the team binding
 * against the membership table so a member removed from the team is cut off
 * before the token's own expiry.
 */
function createTokenVerifier(
  db: Db,
  issuer: string,
  resource: string,
  getKey: JWTVerifyGetKey,
): OAuthTokenVerifier {
  const invalid = (message: string) => new OAuthError(OAuthErrorCode.InvalidToken, message);
  return {
    async verifyAccessToken(token): Promise<AuthInfo> {
      const verified = await jwtVerify(token, getKey, { issuer, audience: resource }).catch(
        () => null,
      );
      const claims = verified ? accessTokenClaims.safeParse(verified.payload) : null;
      if (!claims?.success) throw invalid("Access token is invalid or expired");
      const scopes = claims.data.scope.split(" ").filter(Boolean);
      if (!scopes.some(isMcpScope)) {
        throw new OAuthError(
          OAuthErrorCode.InsufficientScope,
          "Access token grants no MillionSend scope",
        );
      }
      const m = schema.teamMembers;
      const [membership] = await db
        .select({ plan: schema.teams.plan })
        .from(m)
        .innerJoin(schema.teams, eq(m.teamId, schema.teams.id))
        .where(and(eq(m.userId, claims.data.sub), eq(m.teamId, claims.data.team_id)));
      if (!membership) throw invalid("Token holder is no longer a member of the team");
      const extra: McpAuthExtra = {
        auth: {
          teamId: claims.data.team_id,
          plan: membership.plan,
          apiKeyId: null,
          permission: "full_access",
          domainId: null,
        },
        userId: claims.data.sub,
      };
      return {
        token,
        clientId: claims.data.client_id,
        scopes,
        expiresAt: claims.data.exp,
        resource: new URL(resource),
        extra: { ...extra },
      };
    },
  };
}

// ponytail: per-process fixed window keyed by user id; N instances allow N×
// the cap. Move to the api_rate_limits table if that ever matters.
const mcpWindows = new Map<string, number>();
let mcpWindowMinute = -1;
function mcpRateLimited(userId: string, limit: number): boolean {
  const minute = Math.floor(Date.now() / 60_000);
  if (minute !== mcpWindowMinute) {
    mcpWindowMinute = minute;
    mcpWindows.clear();
  }
  const count = (mcpWindows.get(userId) ?? 0) + 1;
  mcpWindows.set(userId, count);
  return count > limit;
}

function withQuery(path: string, query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** One REST call on behalf of the token's team; the JSON reply is the tool result, error or not. */
async function callApi(
  app: OpenAPIHono<Env>,
  auth: ApiKeyAuth,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<CallToolResult> {
  const req = new Request(`http://mcp.internal${path}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  INTERNAL_AUTH.set(req, auth);
  const res = await app.fetch(req);
  const json: unknown = await res
    .json()
    .catch(() => errorBody(res.status, "error", res.statusText));
  return {
    content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
    ...(res.ok ? {} : { isError: true }),
  };
}

const idOrEmail = z.string().min(1).describe("Contact id or email address");
const enc = encodeURIComponent;

/** Tools are registered read-only first and only for scopes the token carries. */
function buildServer(app: OpenAPIHono<Env>, deps: ApiDeps, authInfo: AuthInfo): McpServer {
  const server = new McpServer({ name: "millionsend", version: "1.0.0" });
  const { auth } = authInfo.extra as unknown as McpAuthExtra;
  const scopes = new Set(authInfo.scopes);
  const api = (method: "GET" | "POST" | "PATCH", path: string, body?: unknown) =>
    callApi(app, auth, method, path, body);
  const tool = <S extends z.ZodObject & StandardSchemaWithJSON>(
    name: string,
    scope: McpScope,
    cfg: { description: string; inputSchema: S; readOnly?: boolean },
    run: (args: z.output<S>) => Promise<CallToolResult>,
  ) => {
    if (!scopes.has(scope)) return;
    server.registerTool(
      name,
      {
        description: cfg.description,
        inputSchema: cfg.inputSchema,
        annotations: cfg.readOnly ? { readOnlyHint: true } : { destructiveHint: false },
      },
      // The conditional ToolCallback type cannot resolve for an unbound
      // generic; the cast is sound because args were validated against
      // cfg.inputSchema by the SDK before the callback runs.
      ((args: unknown) => run(args as z.output<S>)) as ToolCallback<S>,
    );
  };

  tool(
    "list_emails",
    "emails:read",
    {
      description:
        "List the team's transactional emails (sent, queued and scheduled), oldest first, with cursor pagination.",
      inputSchema: listQuerySchema,
      readOnly: true,
    },
    (q) => api("GET", withQuery("/emails", q)),
  );
  tool(
    "get_email",
    "emails:read",
    {
      description:
        "Get one email by id: sender, recipients, subject, body, schedule and delivery status (last_event: queued, sent, delivered, bounced, complained, ...).",
      inputSchema: z.object({ id: z.uuid().describe("Email id returned by send_email") }),
      readOnly: true,
    },
    ({ id }) => api("GET", `/emails/${enc(id)}`),
  );
  tool(
    "list_contacts",
    "audience:read",
    {
      description:
        "List contacts of the team, oldest first, with cursor pagination. Pass segment_id to list only that segment's members.",
      inputSchema: listQuerySchema.extend({
        segment_id: z.uuid().optional().describe("Only contacts in this segment"),
      }),
      readOnly: true,
    },
    ({ segment_id, ...q }) =>
      api("GET", withQuery(segment_id ? `/segments/${enc(segment_id)}/contacts` : "/contacts", q)),
  );
  tool(
    "get_contact",
    "audience:read",
    {
      description:
        "Get one contact by id or email, including custom properties and global unsubscribe state.",
      inputSchema: z.object({ id: idOrEmail }),
      readOnly: true,
    },
    ({ id }) => api("GET", `/contacts/${enc(id)}`),
  );
  tool(
    "list_segments",
    "audience:read",
    {
      description:
        "List segments (saved audience filters or manual contact lists) — the targets broadcasts are sent to.",
      inputSchema: listQuerySchema,
      readOnly: true,
    },
    (q) => api("GET", withQuery("/segments", q)),
  );
  tool(
    "list_topics",
    "audience:read",
    {
      description:
        "List subscription topics (newsletter, product updates, ...) contacts can opt in or out of; topic ids scope sends and broadcasts.",
      inputSchema: listQuerySchema,
      readOnly: true,
    },
    (q) => api("GET", withQuery("/topics", q)),
  );
  if (deps.ses) {
    tool(
      "list_domains",
      "domains:read",
      {
        description:
          "List sending domains with verification status. Emails can only be sent from a verified domain.",
        inputSchema: z.object({}),
        readOnly: true,
      },
      () => api("GET", "/domains"),
    );
  }

  tool(
    "send_email",
    "emails:send",
    {
      description:
        "Send a transactional email (or schedule it with scheduled_at). Suppressed and topic-opted-out recipients are skipped automatically. Returns the email id.",
      inputSchema: sendEmailRequestSchema,
    },
    (body) => api("POST", "/emails", body),
  );
  tool(
    "create_contact",
    "audience:write",
    {
      description:
        "Create a contact in the team audience, optionally placing it in segments and setting topic subscriptions. Fails with 409 if the email already exists.",
      inputSchema: createContactRequestSchema,
    },
    (body) => api("POST", "/contacts", body),
  );
  tool(
    "update_contact",
    "audience:write",
    {
      description:
        "Update a contact's name, custom properties or global unsubscribe flag. Omitted fields are left unchanged.",
      inputSchema: updateContactRequestSchema.extend({ id: idOrEmail }),
    },
    ({ id, ...body }) => api("PATCH", `/contacts/${enc(id)}`, body),
  );
  tool(
    "add_contact_to_segment",
    "audience:write",
    {
      description: "Add a contact to a manual segment. Idempotent: adding twice is not an error.",
      inputSchema: z.object({
        contact_id: idOrEmail,
        segment_id: z.uuid().describe("Segment id from list_segments"),
      }),
    },
    ({ contact_id, segment_id }) =>
      api("POST", `/contacts/${enc(contact_id)}/segments/${enc(segment_id)}`),
  );
  tool(
    "create_broadcast",
    "broadcasts:write",
    {
      description:
        "Create a broadcast (bulk email to a segment or the whole audience). Saved as a draft unless send is true; use send_broadcast to send a draft later.",
      inputSchema: createBroadcastRequestSchema,
    },
    (body) => api("POST", "/broadcasts", body),
  );
  tool(
    "send_broadcast",
    "broadcasts:write",
    {
      description:
        "Send a draft broadcast now, or schedule it with scheduled_at. Recipients are resolved at send time; unsubscribed and topic-opted-out contacts are skipped.",
      inputSchema: sendBroadcastRequestSchema.extend({
        id: z.uuid().describe("Broadcast id from create_broadcast"),
      }),
    },
    ({ id, ...body }) => api("POST", `/broadcasts/${enc(id)}/send`, body),
  );

  return server;
}

/**
 * MCP resource server (Streamable HTTP at /mcp) plus its RFC 9728 discovery
 * document. The dashboard (APP_BASE_URL) is the authorization server; tokens
 * are verified offline against its JWKS, so no cross-app import is needed.
 */
export function registerMcp(app: OpenAPIHono<Env>, deps: ApiDeps, appBaseUrl: string): void {
  const resource = mcpResourceUrl(appBaseUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(resource));
  const gate = requireBearerAuth({
    verifier: createTokenVerifier(
      deps.db,
      appBaseUrl,
      resource,
      createRemoteJWKSet(new URL(`${appBaseUrl}/api/auth/jwks`)),
    ),
    resourceMetadataUrl,
  });
  // One McpServer per request: nothing is kept between calls, so the
  // endpoint scales horizontally with no session affinity.
  const handler = createMcpHandler(
    ({ authInfo }) => {
      if (!authInfo) throw new Error("mcp handler invoked without authInfo");
      return buildServer(app, deps, authInfo);
    },
    { onerror: (err) => console.error("mcp error", err) },
  );
  const metadata = {
    resource,
    authorization_servers: [appBaseUrl],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ["header"],
  };
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(metadata));
  app.get(`/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`, (c) => c.json(metadata));
  // Origin is not validated: auth is an explicit bearer (never cookies), so a
  // DNS-rebound page holds no credential — the same reasoning behind the REST
  // API's wildcard CORS.
  app.all(MCP_RESOURCE_PATH, async (c) => {
    const gated = await gate(c.req.raw);
    // Not `instanceof Response`: @hono/node-server swaps the global Response
    // class, so the SDK-built challenge can be a different Response realm.
    if (!("scopes" in gated)) return gated;
    const authInfo = gated;
    const { userId } = authInfo.extra as unknown as McpAuthExtra;
    if (mcpRateLimited(userId, deps.rateLimitPerMinute ?? 600)) {
      c.header("retry-after", "60");
      return c.json(errorBody(429, "rate_limit_exceeded", "Too many requests"), 429);
    }
    return handler.fetch(c.req.raw, { authInfo });
  });
}
