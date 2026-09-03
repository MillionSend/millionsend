import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

/**
 * Dedupe ledger for account notifications: one row per (team, kind, period).
 * A notification is sent only by the writer that wins the insert, so every
 * surface that could detect the same condition converges on one message.
 */
export const teamNotifications = pgTable(
  "team_notifications",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    periodKey: text("period_key").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.kind, t.periodKey] })],
);
