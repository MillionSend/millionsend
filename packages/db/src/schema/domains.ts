import {
  boolean,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

export const domainStatusEnum = pgEnum("domain_status", [
  "pending",
  "verified",
  "temporary_failure",
  "failed",
]);

export const tlsModeEnum = pgEnum("tls_mode", ["opportunistic", "enforced"]);

export const domains = pgTable(
  "domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    region: text("region").notNull(),
    status: domainStatusEnum("status").notNull().default("pending"),
    // Easy DKIM CNAME tokens returned by SES; rendered as the customer's DNS checklist.
    dkimTokens: jsonb("dkim_tokens").$type<string[]>(),
    mailFromSubdomain: text("mail_from_subdomain").notNull().default("send"),
    trackingSubdomain: text("tracking_subdomain"),
    clickTracking: boolean("click_tracking").notNull().default(true),
    openTracking: boolean("open_tracking").notNull().default(false),
    tlsMode: tlsModeEnum("tls_mode").notNull().default("opportunistic"),
    sesConfigurationSet: text("ses_configuration_set"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("domains_team_name_idx").on(t.teamId, t.name)],
);
