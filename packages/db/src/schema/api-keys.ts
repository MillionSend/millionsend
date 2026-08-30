import {
  type AnyPgColumn,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { domains } from "./domains.js";
import { teams } from "./teams.js";

export const apiKeyPermissionEnum = pgEnum("api_key_permission", ["full_access", "sending_access"]);

/**
 * The secret is never stored: only its SHA-256. `tokenPrefix` (e.g. "ms_live_a1b2c3")
 * is the indexed lookup handle; verification re-hashes the presented key and
 * compares in constant time. High-entropy machine secrets use a fast hash by design —
 * bcrypt/argon2 are for low-entropy passwords.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    last4: text("last4").notNull(),
    permission: apiKeyPermissionEnum("permission").notNull().default("full_access"),
    // Null = all domains; set = key restricted to one sending domain.
    // restrict, never set-null: deleting a domain must not silently widen a
    // scoped key into an all-domains key — the delete flow revokes such keys first.
    domainId: uuid("domain_id").references(() => domains.id, { onDelete: "restrict" }),
    // Which API key minted this one (null for dashboard-created keys): a
    // leaked key can mint descendants, and this is the trail to revoke them.
    createdByApiKeyId: uuid("created_by_api_key_id").references((): AnyPgColumn => apiKeys.id, {
      onDelete: "set null",
    }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("api_keys_token_prefix_idx").on(t.tokenPrefix)],
);
