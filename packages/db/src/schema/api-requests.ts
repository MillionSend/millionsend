import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { apiKeys } from "./api-keys.js";
import { teams } from "./teams.js";

/**
 * Per-request API log. Both bodies are stored REDACTED at the API boundary
 * (content fields such as html/text/attachment content replaced by size
 * markers, secrets such as tokens and signing secrets by "[redacted]", 64KB
 * cap, never headers) — the emails table encrypts content at rest and this
 * table must not become its plaintext copy. Bodies are admin-only in the
 * dashboard, deleted by the recipient erase job when they mention the erased
 * address, and rows age out with the email-body retention purge.
 */
export const apiRequests = pgTable(
  "api_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // Null for OAuth (MCP) callers, which authenticate without a key.
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    // The connected app behind an OAuth (MCP) call; null for API-key callers.
    // No FK: the OAuth tables are managed by the auth library.
    oauthClientId: text("oauth_client_id"),
    method: text("method").notNull(),
    path: text("path").notNull(),
    statusCode: integer("status_code").notNull(),
    durationMs: integer("duration_ms"),
    // From the Content-Length headers; null when a side was streamed without one.
    requestBytes: integer("request_bytes"),
    responseBytes: integer("response_bytes"),
    requestBody: jsonb("request_body").$type<unknown>(),
    responseBody: jsonb("response_body").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("api_requests_team_created_idx").on(t.teamId, t.createdAt),
    // Drives the retention purge scan.
    index("api_requests_created_idx").on(t.createdAt),
    // The logs filter lists the distinct apps seen in a team's log.
    index("api_requests_team_oauth_client_idx")
      .on(t.teamId, t.oauthClientId)
      .where(sql`${t.oauthClientId} is not null`),
  ],
);
