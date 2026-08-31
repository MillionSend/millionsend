import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { broadcasts } from "./broadcasts.js";
import { emails } from "./emails.js";
import { teams } from "./teams.js";

export interface EmailInsightCheck {
  id: string;
  severity: "critical" | "major" | "minor" | "info";
  status: "pass" | "fail" | "passed_by_design" | "not_applicable" | "unknown";
  penaltyHundredths: number;
  detail?: Record<string, string | number | boolean | string[]>;
}

/**
 * Rows hold only content-DERIVED metadata (booleans/counts/sizes/hostnames —
 * never body content or full URLs), which is why they deliberately outlive the
 * encrypted-body purge and live on the metadata retention clock (cascade with
 * the email row). Broadcast fan-out stores ONE row keyed by broadcastId shared
 * by all recipients (content identical modulo the unsubscribe token); API
 * sends store one row keyed by emailId.
 */
export const emailInsights = pgTable(
  "email_insights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    emailId: uuid("email_id")
      .unique()
      .references(() => emails.id, { onDelete: "cascade" }),
    broadcastId: uuid("broadcast_id")
      .unique()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    marketing: boolean("marketing").notNull(),
    checks: jsonb("checks").$type<EmailInsightCheck[]>().notNull(),
    scoreTenths: integer("score_tenths").notNull(),
    scoreVersion: integer("score_version").notNull(),
    htmlSizeBytes: integer("html_size_bytes"),
    mimeSizeBytes: integer("mime_size_bytes"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("email_insights_one_target", sql`(${t.emailId} IS NULL) <> (${t.broadcastId} IS NULL)`),
  ],
);
