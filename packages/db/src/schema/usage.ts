import { date, index, integer, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

/**
 * Daily send counters (UTC day). Quota is reserved with an atomic
 * `UPDATE ... RETURNING` at accept time — never from cached aggregates —
 * so the plan limit cannot be overshot by concurrent requests.
 * Aggregate lifecycle: rows are kept forever (they feed Metrics and the
 * all-time counter).
 */
export const usageCounters = pgTable(
  "usage_counters",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    accepted: integer("accepted").notNull().default(0),
    sent: integer("sent").notNull().default(0),
    delivered: integer("delivered").notNull().default(0),
    bounced: integer("bounced").notNull().default(0),
    // bounced counts ALL bounce events including Transient; hardBounced counts
    // only Permanent — the deliverability score's bounce-rate input (transient
    // greylisting must not read as a hard-bounce crisis).
    hardBounced: integer("hard_bounced").notNull().default(0),
    complained: integer("complained").notNull().default(0),
    // Unique engagement per day: one recipient opening/clicking many times
    // counts once, so rates against `delivered` stay <= 100%.
    opened: integer("opened").notNull().default(0),
    clicked: integer("clicked").notNull().default(0),
    // Tracking-image fetches a machine made before anyone opened, unique per
    // email like `opened`, kept apart so open rates count people only.
    prefetched: integer("prefetched").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.day] }),
    // Cross-team reads by day alone: the notification sweep and the platform
    // breaker's weekly window.
    index("usage_counters_day_idx").on(t.day),
  ],
);

/**
 * The same counters per UTC hour, for the Metrics chart only: hours sum into
 * days in whichever timezone the viewer is in, so two teammates each see
 * their own calendar days from one set of rows. Every writer of a daily
 * counter bumps the hour as well; quota, the deliverability guardrail and the
 * account score keep reading the daily table. Rows before the table existed
 * were backfilled at noon UTC of their day, which is the same calendar date
 * in every timezone between UTC-11 and UTC+11.
 */
export const usageCountersHourly = pgTable(
  "usage_counters_hourly",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    accepted: integer("accepted").notNull().default(0),
    sent: integer("sent").notNull().default(0),
    delivered: integer("delivered").notNull().default(0),
    bounced: integer("bounced").notNull().default(0),
    hardBounced: integer("hard_bounced").notNull().default(0),
    complained: integer("complained").notNull().default(0),
    opened: integer("opened").notNull().default(0),
    clicked: integer("clicked").notNull().default(0),
    prefetched: integer("prefetched").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.hour] }),
    // The retention purge deletes by hour across every team.
    index("usage_counters_hourly_hour_idx").on(t.hour),
  ],
);

/**
 * Monthly-plan counters, one row per team and Stripe billing period. The
 * accept paths reserve against `accepted` with the same atomic upsert the
 * daily table uses; `reportedOverage` is how much past the included volume
 * has already been sent to the Stripe meter, so a report retry never bills
 * twice. Kept forever like the daily rows.
 */
export const usagePeriods = pgTable(
  "usage_periods",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    accepted: integer("accepted").notNull().default(0),
    reportedOverage: integer("reported_overage").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.periodStart] })],
);
