import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

/**
 * Postgres-backed Idempotency-Key store (no Redis in v1). Same key + same
 * canonical body hash replays the stored response; same key + different hash
 * is a 409 conflict. Rows expire via the cleanup job after 24h.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    bodyHash: text("body_hash").notNull(),
    responseEmailIds: jsonb("response_email_ids").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.key] }),
    index("idempotency_expiry_idx").on(t.expiresAt),
  ],
);
