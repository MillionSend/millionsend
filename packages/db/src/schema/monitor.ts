import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { broadcasts } from "./broadcasts.js";
import { emails } from "./emails.js";
import { teams } from "./teams.js";

/** Why a message was picked for the content monitor. */
export const monitorSampleKindEnum = pgEnum("monitor_sample_kind", [
  "first_sends",
  "ramp",
  "tier",
  "anomaly",
  "override",
  "broadcast_skeleton",
  "broadcast_copy",
]);

/** `unjudged` is every judge failure: the sample is kept with its error class and touches nothing else. */
export const monitorSampleStatusEnum = pgEnum("monitor_sample_status", [
  "pending",
  "judged",
  "unjudged",
]);

/**
 * One row per team the content monitor ever drew for: its send count and
 * age (the tier inputs), the internal risk the verdicts decay into (never
 * shown to the team), and the operator's per-team levers. The risk is a
 * decayed mean kept as numerator and denominator so a sample can update it
 * without replaying history.
 */
export const teamMonitor = pgTable("team_monitor", {
  teamId: uuid("team_id")
    .primaryKey()
    .references(() => teams.id, { onDelete: "cascade" }),
  sentTotal: integer("sent_total").notNull().default(0),
  firstSendAt: timestamp("first_send_at", { withTimezone: true }),
  risk: doublePrecision("risk"),
  riskNum: doublePrecision("risk_num").notNull().default(0),
  riskDen: doublePrecision("risk_den").notNull().default(0),
  riskUpdatedAt: timestamp("risk_updated_at", { withTimezone: true }),
  lastSampleAt: timestamp("last_sample_at", { withTimezone: true }),
  // An operator's sampling override replaces the tier rate until it lapses.
  overrideRate: doublePrecision("override_rate"),
  overrideUntil: timestamp("override_until", { withTimezone: true }),
  // Set by the pause policy; the same instant is written to
  // teams.broadcasts_paused_by_operator_at so every hold honours it.
  broadcastsPausedAt: timestamp("broadcasts_paused_at", { withTimezone: true }),
  // When an operator last lifted the policy's pause: only verdicts after it
  // can pause the team again, so a reviewed episode is not re-litigated.
  broadcastsResumedAt: timestamp("broadcasts_resumed_at", { withTimezone: true }),
  // Set when the review hold suspended the team. It holds a team once: after
  // a person released it, the drained campaign's next verdicts only alert.
  heldAt: timestamp("held_at", { withTimezone: true }),
  alertedAt: timestamp("alerted_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One judged (or unjudged) message. Holds the judge's output only: score,
 * verdict, categories, reason codes, brand, language, model and timing.
 * Never the text sent to the model, the subject or the body; the row
 * outlives the email it points at.
 */
export const monitorSamples = pgTable(
  "monitor_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    emailId: uuid("email_id").references(() => emails.id, { onDelete: "set null" }),
    broadcastId: uuid("broadcast_id").references(() => broadcasts.id, { onDelete: "set null" }),
    kind: monitorSampleKindEnum("kind").notNull(),
    status: monitorSampleStatusEnum("status").notNull().default("pending"),
    score: smallint("score"),
    verdict: text("verdict"),
    categories: jsonb("categories").$type<string[]>(),
    reasons: jsonb("reasons").$type<string[]>(),
    impersonatedBrand: text("impersonated_brand"),
    language: text("language"),
    errorClass: text("error_class"),
    model: text("model"),
    latencyMs: integer("latency_ms"),
    // Throttled judge calls retry a few times before the sample gives up.
    attempts: smallint("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    judgedAt: timestamp("judged_at", { withTimezone: true }),
  },
  (t) => [
    index("monitor_samples_team_created_idx").on(t.teamId, t.createdAt),
    // The instance-wide daily cap and the retention prune count by age alone.
    index("monitor_samples_created_idx").on(t.createdAt),
    // The set-null foreign keys fire on every email and broadcast delete.
    index("monitor_samples_email_idx").on(t.emailId).where(sql`${t.emailId} is not null`),
    index("monitor_samples_broadcast_idx")
      .on(t.broadcastId)
      .where(sql`${t.broadcastId} is not null`),
  ],
);

/** The judge's own switch is env; these sampling and threshold overrides sit beside it, with the warm-up's. */
export const monitorSettingColumns = {
  monitorFirstSends: integer("monitor_first_sends"),
  monitorFirstHours: integer("monitor_first_hours"),
  monitorRampSends: integer("monitor_ramp_sends"),
  monitorRampRate: doublePrecision("monitor_ramp_rate"),
  monitorRampDays: integer("monitor_ramp_days"),
  monitorProbationRate: doublePrecision("monitor_probation_rate"),
  monitorEstablishedRate: doublePrecision("monitor_established_rate"),
  monitorTrustedRate: doublePrecision("monitor_trusted_rate"),
  monitorBroadcastCopies: integer("monitor_broadcast_copies"),
  monitorBroadcastCopiesNew: integer("monitor_broadcast_copies_new"),
  monitorAnomalyMultiplier: doublePrecision("monitor_anomaly_multiplier"),
  monitorTeamDailyCap: integer("monitor_team_daily_cap"),
  monitorInstanceDailyCap: integer("monitor_instance_daily_cap"),
  monitorFlagRisk: doublePrecision("monitor_flag_risk"),
  monitorAlertRisk: doublePrecision("monitor_alert_risk"),
  monitorPauseRisk: doublePrecision("monitor_pause_risk"),
  monitorAutoPause: boolean("monitor_auto_pause"),
  monitorFlagScore: smallint("monitor_flag_score"),
  monitorAutoHold: boolean("monitor_auto_hold"),
  monitorHoldScore: smallint("monitor_hold_score"),
  monitorHoldRepeatCount: integer("monitor_hold_repeat_count"),
  monitorHoldRepeatScore: smallint("monitor_hold_repeat_score"),
  // The new-domain warm-up shares the trust & safety settings page.
  warmupEnabled: boolean("warmup_enabled"),
  warmupCapFirstDay: integer("warmup_cap_first_day"),
  warmupCapFirstWeek: integer("warmup_cap_first_week"),
  warmupCapFirstMonth: integer("warmup_cap_first_month"),
} as const;
