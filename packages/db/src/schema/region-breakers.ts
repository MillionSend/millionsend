import { boolean, doublePrecision, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Why a region's broadcasts were paused: the window and metric of our own
 * counts that tripped, or SES's own complaint rate. Complaints are judged on
 * SES's rate alone; a complaint reason with a window is what older releases
 * stored, left on a region they paused.
 */
export type RegionBreakerReason =
  | {
      metric: "bounce" | "complaint";
      rate: number;
      limit: number;
      windowHours: number;
      sent: number;
      events: number;
    }
  | {
      metric: "complaint";
      /** SES's Reputation.ComplaintRate for the account in the region. */
      source: "ses";
      rate: number;
      limit: number;
    };

/**
 * Per-SES-region platform breaker. SES judges bounce and complaint rates on
 * the whole account per region, so one row per region records whether
 * broadcasts are held there while the aggregate recovers.
 */
export const regionBreakers = pgTable("region_breakers", {
  region: text("region").primaryKey(),
  paused: boolean("paused").notNull().default(false),
  reason: jsonb("reason").$type<RegionBreakerReason>(),
  // Set when an operator held the region by hand; the breaker cron leaves
  // such a row alone until the operator releases it.
  manualReason: text("manual_reason"),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // SES's own complaint rate as of the breaker's last successful read; null
  // while SES publishes none. A failed read leaves the last one in place.
  sesComplaintRate: doublePrecision("ses_complaint_rate"),
  // When the operator was last told the rate sat over the alert line.
  sesComplaintAlertedAt: timestamp("ses_complaint_alerted_at", { withTimezone: true }),
});
