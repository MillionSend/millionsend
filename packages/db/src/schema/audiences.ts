import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

// No unique(teamId, name): Resend allows duplicate audience names.
export const audiences = pgTable(
  "audiences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audiences_team_idx").on(t.teamId)],
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    audienceId: uuid("audience_id")
      .notNull()
      .references(() => audiences.id, { onDelete: "cascade" }),
    // Denormalized from the audience so tenant-scoped scans and the API's
    // teamId guard never need a join.
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    // Flat string→string custom properties, Resend-style; usable as broadcast
    // merge tokens. Non-string inputs are coerced/rejected at the API boundary.
    properties: jsonb("properties").$type<Record<string, string>>().notNull().default({}),
    unsubscribed: boolean("unsubscribed").notNull().default(false),
    // When the contact unsubscribed (null while subscribed) — feeds the
    // audience growth chart alongside createdAt.
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Case-insensitive uniqueness: one contact per address per audience.
    uniqueIndex("contacts_audience_email_idx").on(t.audienceId, sql`lower(${t.email})`),
    index("contacts_team_idx").on(t.teamId),
  ],
);
