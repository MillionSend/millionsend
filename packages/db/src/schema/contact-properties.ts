import { sql } from "drizzle-orm";
import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

// Resend's contact-property types plus 'date', a MillionSend extension.
// Mirrors CONTACT_PROPERTY_TYPES in packages/core/src/contact-properties.ts.
export const contactPropertyTypeEnum = pgEnum("contact_property_type", [
  "string",
  "number",
  "date",
]);

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
    type: contactPropertyTypeEnum("type").notNull().default("string"),
    // Stored as text even for 'number' and 'date' properties; callers coerce per `type`.
    fallbackValue: text("fallback_value"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // One definition per key per team, case-insensitive to match how property
  // keys are compared everywhere else.
  (t) => [uniqueIndex("contact_properties_team_key_idx").on(t.teamId, sql`lower(${t.key})`)],
);
