import { sql } from "drizzle-orm";
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

/** What put a team on the trust & safety list. */
export const teamFlagReasonEnum = pgEnum("team_flag_reason", [
  "monitor",
  "complaints",
  "guardrail",
  "score",
  "report",
  "manual",
]);

export const teamFlagStatusEnum = pgEnum("team_flag_status", ["open", "cleared"]);

/** The measurement behind an automatic flag, for the row's label. */
export interface TeamFlagDetail {
  metric?: "complaint" | "hard_bounce" | "score";
  rate?: number;
  scoreTenths?: number;
  guardrail?: "warning" | "paused";
}

/**
 * Trust & safety flags. A team holds at most one open flag; the worker's
 * safety cron opens and clears the automatic ones (opened_by null) so a
 * flag's `opened_at` stays put across runs, and an operator's manual flag or
 * clear is never touched by the cron.
 */
export const teamFlags = pgTable(
  "team_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    reason: teamFlagReasonEnum("reason").notNull(),
    status: teamFlagStatusEnum("status").notNull().default("open"),
    note: text("note"),
    detail: jsonb("detail").$type<TeamFlagDetail>(),
    // User id of the operator who flagged by hand; null for the cron.
    openedBy: text("opened_by"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    clearedBy: text("cleared_by"),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("team_flags_open_idx").on(t.teamId).where(sql`${t.status} = 'open'`),
    index("team_flags_team_idx").on(t.teamId, t.openedAt),
  ],
);

/**
 * Per-team standing the console lists and sorts on, refreshed by the safety
 * cron for every team that sent in the last 30 days: the account score, the
 * guardrail status and the 7-day rates the dashboard shows the team itself.
 * A cache of what core computes per team; the review page recomputes live.
 */
export const teamStandings = pgTable("team_standings", {
  teamId: uuid("team_id")
    .primaryKey()
    .references(() => teams.id, { onDelete: "cascade" }),
  scoreTenths: integer("score_tenths"),
  guardrail: text("guardrail").$type<"ok" | "warning" | "paused">().notNull(),
  // The metric that tripped the guardrail, when it is not "ok".
  guardrailMetric: text("guardrail_metric").$type<"complaint" | "hard_bounce">(),
  complaintRate7d: doublePrecision("complaint_rate_7d").notNull().default(0),
  hardBounceRate7d: doublePrecision("hard_bounce_rate_7d").notNull().default(0),
  sent7d: integer("sent_7d").notNull().default(0),
  sent30d: integer("sent_30d").notNull().default(0),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});
