import { boolean, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Why a region's broadcasts were paused: the window and metric that tripped. */
export interface RegionBreakerReason {
  metric: "bounce" | "complaint";
  rate: number;
  limit: number;
  windowHours: number;
  sent: number;
  events: number;
}

/**
 * Per-SES-region platform breaker. SES judges bounce and complaint rates on
 * the whole account per region, so one row per region records whether
 * broadcasts are held there while the aggregate recovers.
 */
export const regionBreakers = pgTable("region_breakers", {
  region: text("region").primaryKey(),
  paused: boolean("paused").notNull().default(false),
  reason: jsonb("reason").$type<RegionBreakerReason>(),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
