import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { contacts } from "./audiences.js";
import { teams } from "./teams.js";

export const topics = pgTable(
  "topics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    // opt-in (true): a contact is subscribed unless it explicitly opts out.
    // Immutable after creation — flipping it would silently reinterpret every
    // absent subscription row, so the default is fixed at creation time.
    defaultSubscribed: boolean("default_subscribed").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("topics_team_idx").on(t.teamId)],
);

// Absence of a row = the topic's defaultSubscribed; a row is the explicit
// per-contact override.
export const contactTopicSubscriptions = pgTable(
  "contact_topic_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    subscribed: boolean("subscribed").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("contact_topic_unique").on(t.contactId, t.topicId)],
);
