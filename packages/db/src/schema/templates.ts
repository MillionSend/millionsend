import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

// Reusable email content only — broadcasts copy a template's content at
// compose time and keep no FK back, so editing a template never rewrites
// anything already sent or drafted.
export const templates = pgTable(
  "templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    subject: text("subject"),
    html: text("html").notNull(),
    text: text("text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("templates_team_idx").on(t.teamId)],
);
