import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { contacts } from "./contacts.js";
import { teams } from "./teams.js";

/**
 * A saved filter over the team's contacts. `all` = AND, `any` = OR; empty
 * `conditions` matches every contact. The shape lives here (the DB layer) so
 * `@millionsend/core`'s zod validator can annotate against it without a
 * core→db→core import cycle — core is the only place values are validated
 * before they reach SQL.
 */
export type SegmentCondition = { field: string; op: string; value: string | null };
export type SegmentFilter = { match: "all" | "any"; conditions: SegmentCondition[] };

export const segments = pgTable(
  "segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Null = manual-membership-only segment (rows in segment_members); a
    // null filter must never be read as "matches everyone".
    filter: jsonb("filter").$type<SegmentFilter>(),
    // Counting a segment scans the team's contacts, so the counts the
    // Segments page shows are cached here and refreshed on a schedule and
    // when the segment changes; the builder preview stays live.
    contactCount: integer("contact_count"),
    unsubscribedCount: integer("unsubscribed_count"),
    countedAt: timestamp("counted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("segments_team_idx").on(t.teamId)],
);

// Explicit membership (contacts.create segments / contacts.segments.add);
// coexists with `filter` on the same segment.
export const segmentMembers = pgTable(
  "segment_members",
  {
    segmentId: uuid("segment_id")
      .notNull()
      .references(() => segments.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.segmentId, t.contactId] }),
    // Reverse lookup: "which segments is this contact in" (contacts.segments.list).
    index("segment_members_contact_idx").on(t.contactId),
  ],
);
