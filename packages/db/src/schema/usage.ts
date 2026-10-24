import {
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
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
    // Sends no recipient can report as a complaint, every one at a provider
    // that never sends SES complaint feedback (core's
    // NO_COMPLAINT_FEEDBACK_DOMAINS). The complaint rate's denominator is
    // `sent` minus this. Filled in for the week before the column was added;
    // older days read 0, so they count all their sends.
    sentNoFeedback: integer("sent_no_feedback").notNull().default(0),
    delivered: integer("delivered").notNull().default(0),
    bounced: integer("bounced").notNull().default(0),
    // bounced counts ALL bounce events including Transient; hardBounced counts
    // only Permanent — the deliverability score's bounce-rate input (transient
    // greylisting must not read as a hard-bounce crisis). hardBounced and
    // complained leave out feedback about mail SES never attempted (core's
    // sesAttempted), which SES's own rates leave out too.
    hardBounced: integer("hard_bounced").notNull().default(0),
    complained: integer("complained").notNull().default(0),
    // Unique engagement per day: one recipient opening/clicking many times
    // counts once, so rates against `delivered` stay <= 100%.
    opened: integer("opened").notNull().default(0),
    clicked: integer("clicked").notNull().default(0),
    // Tracking-image fetches a machine made before anyone opened, unique per
    // email like `opened`, kept apart so open rates count people only.
    prefetched: integer("prefetched").notNull().default(0),
    // Inbound messages stored for the team, one per message whatever its
    // recipient count. On the Free plan they also count in `accepted`, the
    // daily cap sending and receiving share.
    received: integer("received").notNull().default(0),
    // Received mail the inbound judge read, against the team's daily cap.
    inboundJudged: integer("inbound_judged").notNull().default(0),
    // Recipients of mail from shared inbox domain addresses, against the
    // team's daily cap for them; kept here because inbox_usage_daily rows go
    // with each deleted inbox.
    sharedRecipients: integer("shared_recipients").notNull().default(0),
    // Shared-domain names the identity review refused, against a daily budget.
    sharedNameRefusals: integer("shared_name_refusals").notNull().default(0),
    // Identity reviews asked for the team, each a judge call, against a daily budget.
    sharedNameReviews: integer("shared_name_reviews").notNull().default(0),
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
 * counter bumps the hour as well, except sent_no_feedback, which only the
 * platform breaker's region counts read, by day, and the shared inbox
 * domain's shared_recipients, shared_name_refusals and shared_name_reviews,
 * which only their own daily limits read; quota, the deliverability
 * guardrail and the account score keep reading the daily table. Rows before
 * the table existed were backfilled at noon UTC of their day, which is the
 * same calendar date in every timezone between UTC-11 and UTC+11.
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
    received: integer("received").notNull().default(0),
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
    // The counter a meter event in flight advances to: set before the event
    // is sent and cleared once the row caught up, so a report whose commit
    // was lost is re-sent with the same value under the same identifier.
    pendingOverage: integer("pending_overage"),
    // Inbound messages this period. Up to twice the included volume they are
    // free; past that every tenth one adds one email to `accepted`, which is
    // how received mail reaches quota and overage.
    received: integer("received").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.periodStart] })],
);

/**
 * Recipients accepted per registrable domain and UTC day while the domain
 * warms up, across every team sending from it: the warm-up cap is the
 * domain's, so a team's older domains never share it and a second team
 * cannot double it. Reserved with the same guarded upsert as usage_counters.
 */
export const domainWarmupUsage = pgTable(
  "domain_warmup_usage",
  {
    registrableDomain: text("registrable_domain").notNull(),
    day: date("day").notNull(),
    accepted: integer("accepted").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.registrableDomain, t.day] })],
);

/**
 * Recipients a team accepted per UTC day from its domains still warming up:
 * the one daily limit they share, so a second fresh domain never adds
 * volume. Reserved beside domain_warmup_usage, the same way.
 */
export const teamWarmupUsage = pgTable(
  "team_warmup_usage",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    accepted: integer("accepted").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.day] })],
);
