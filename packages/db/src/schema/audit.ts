import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

/**
 * Append-only, enforced in the database by a trigger that rejects
 * UPDATE/DELETE (see the audit_log_append_only custom migration) — grants
 * alone can't enforce this until dedicated roles exist.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
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
