import { date, integer, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

/**
 * Daily send counters (UTC day). Quota is reserved with an atomic
 * `UPDATE ... RETURNING` at accept time — never from cached aggregates —
 * so the plan limit cannot be overshot by concurrent requests.
 * Aggregate lifecycle: rows are kept forever (they feed Metrics and the
 * all-time counter).
 */
export const usageCounters = pgTable(
  "usage_counters",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    accepted: integer("accepted").notNull().default(0),
    sent: integer("sent").notNull().default(0),
    delivered: integer("delivered").notNull().default(0),
    bounced: integer("bounced").notNull().default(0),
    complained: integer("complained").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.day] })],
);
