import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

// Typed definitions layered over the free-form contacts.properties map: they
// declare which keys exist, their type, and an optional fallback, independent
// of whether any contact currently carries a value.
export const contactProperties = pgTable(
  "contact_properties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    // MVP defines only 'string'; the column stays so richer types can land
    // later without a migration.
    type: text("type").notNull().default("string"),
    fallbackValue: text("fallback_value"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // One definition per key per team, case-insensitive to match how property
  // keys are compared everywhere else.
  (t) => [uniqueIndex("contact_properties_team_key_idx").on(t.teamId, sql`lower(${t.key})`)],
);
