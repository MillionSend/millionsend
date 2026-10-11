import { boolean, doublePrecision, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Why a region's broadcasts were paused: the window and metric of our own
 * counts that tripped, or SES's own complaint rate. Our own complaint count
 * only trips while SES's rate can't be read.
 */
export type RegionBreakerReason =
  | {
      metric: "bounce" | "complaint";
      /** Our own events; reasons older releases stored carry no source. */
      source?: "events";
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
  // When that read happened: a rate read over a day ago no longer counts, and
  // the breaker judges our own complaint count instead.
  sesComplaintReadAt: timestamp("ses_complaint_read_at", { withTimezone: true }),
  // When the operator was last told the rate sat over the alert line.
  sesComplaintAlertedAt: timestamp("ses_complaint_alerted_at", { withTimezone: true }),
});
