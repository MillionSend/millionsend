import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
    filter: jsonb("filter").$type<SegmentFilter>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("segments_team_idx").on(t.teamId)],
);
