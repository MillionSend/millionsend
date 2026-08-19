import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { contacts } from "./contacts.js";
import { teams } from "./teams.js";

export type ContactActivityType =
  | "contact_created"
  | "topic_opt_in"
  | "topic_opt_out"
  | "unsubscribed"
  | "resubscribed"
  | "segment_added"
  | "segment_removed";

/**
 * Per-contact event timeline (contact-detail Activity card). Plain text type
 * (not a pg enum) so new activity kinds don't need a migration.
 */
export const contactActivities = pgTable(
  "contact_activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    type: text("type").$type<ContactActivityType>().notNull(),
    // Snapshot of the referenced resource (e.g. topic/segment id + name) so
    // the timeline stays readable after that resource is deleted.
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("contact_activities_contact_idx").on(t.contactId, t.createdAt.desc())],
);
