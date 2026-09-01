import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
    // Public-API handle (resend templates.alias): case-sensitive, unique per
    // team, null for dashboard-only templates.
    alias: text("alias"),
    subject: text("subject"),
    html: text("html").notNull(),
    text: text("text"),
    // Block-editor source of truth (BlockDoc). Null → legacy raw-HTML row whose
    // `html` was hand-authored; the app renders those in CODE mode.
    document: jsonb("document").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("templates_team_idx").on(t.teamId),
    uniqueIndex("templates_team_alias_idx").on(t.teamId, t.alias),
  ],
);
