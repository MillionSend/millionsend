import {
  boolean,
  date,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { domains } from "./domains.js";
import { teams } from "./teams.js";

export const domainWarmupStatusEnum = pgEnum("domain_warmup_status", [
  "off",
  "warming",
  "paused",
  "done",
]);

/** How a checked day moved the ramp. */
export const domainWarmupOutcomeEnum = pgEnum("domain_warmup_outcome", [
  "grew",
  "held",
  "stepped_back",
  "paused",
  "done",
  "light",
  "idle",
]);

/** One signal's reading for a checked day, as fractions (0.031 = 3.1%); null when there was too little mail to judge. */
export interface WarmupSignalReading {
  gmail: number | null;
  other: number | null;
  result: "within" | "missed" | "severe" | "unknown";
}

export interface WarmupSignals {
  sent: { gmail: number; other: number };
  delays: WarmupSignalReading;
  opens: WarmupSignalReading;
  hardBounces: WarmupSignalReading;
  mailboxFull: WarmupSignalReading;
  complaints: WarmupSignalReading;
}

/**
 * A sending domain's reputation warm-up: the team turned it on for this
 * exact domain row, and its broadcasts go out under a daily volume that
 * grows while delivery stays healthy. No row means off.
 */
export const domainWarmups = pgTable("domain_warmups", {
  domainId: uuid("domain_id")
    .primaryKey()
    .references(() => domains.id, { onDelete: "cascade" }),
  teamId: uuid("team_id")
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" }),
  status: domainWarmupStatusEnum("status").notNull().default("warming"),
  volume: integer("volume").notNull(),
  startVolume: integer("start_volume").notNull(),
  dailyTarget: integer("daily_target").notNull(),
  sendingDays: integer("sending_days").notNull().default(0),
  // A day's releases wait until the day before it is checked.
  checkedThrough: date("checked_through"),
  orderByEngagement: boolean("order_by_engagement").notNull().default(true),
  orderByTransactional: boolean("order_by_transactional").notNull().default(true),
  orderProperty: text("order_property"),
  skipInactive: boolean("skip_inactive").notNull().default(true),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  // Null when the team paused it rather than a checked day.
  pauseSignals: jsonb("pause_signals").$type<WarmupSignals>(),
  doneAt: timestamp("done_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One UTC day of a warm-up: its allowance, what went out against it, and how the check judged it. */
export const domainWarmupDays = pgTable(
  "domain_warmup_days",
  {
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domainWarmups.domainId, { onDelete: "cascade" }),
    day: date("day").notNull(),
    allowance: integer("allowance").notNull(),
    sent: integer("sent").notNull().default(0),
    outcome: domainWarmupOutcomeEnum("outcome"),
    signals: jsonb("signals").$type<WarmupSignals>(),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.domainId, t.day] })],
);
