import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Append-only, enforced in the database by a trigger that rejects
 * UPDATE/DELETE (see the baseline migration) — grants
 * alone can't enforce this until dedicated roles exist.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Deliberately no FK: audit rows must survive team deletion unchanged
    // (a SET NULL referential update would also trip the append-only trigger).
    teamId: uuid("team_id"),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    target: text("target"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_team_idx").on(t.teamId, t.createdAt)],
);
