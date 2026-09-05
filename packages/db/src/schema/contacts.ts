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

/**
 * Team-global contacts (the Resend "new contacts experience" model): one row
 * per email address per team. Segments (saved filters) and topics reference
 * contacts directly — there is no audience container.
 */
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
    // Case-insensitive uniqueness: one contact per address per team.
    uniqueIndex("contacts_team_email_idx").on(t.teamId, sql`lower(${t.email})`),
    // Every list orders a team's contacts by creation, newest or oldest first.
    index("contacts_team_created_idx").on(t.teamId, t.createdAt, t.id),
    // The broadcast fan-out walks a team's contacts by id in keyset pages.
    index("contacts_team_id_idx").on(t.teamId, t.id),
  ],
);
