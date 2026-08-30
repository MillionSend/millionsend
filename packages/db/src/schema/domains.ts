import { boolean, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
    // BYODKIM: only the selector and public half are stored — the private key
    // is uploaded to SES at create time and never persisted anywhere. Nullable
    // only so bare fixture inserts stay cheap; the create flow always sets both.
    dkimSelector: text("dkim_selector"),
    dkimPublicKey: text("dkim_public_key"),
    mailFromSubdomain: text("mail_from_subdomain").notNull().default("send"),
    trackingSubdomain: text("tracking_subdomain"),
    // Both tracking kinds are off by default, as the Domains docs promise.
    clickTracking: boolean("click_tracking").notNull().default(false),
    openTracking: boolean("open_tracking").notNull().default(false),
    tlsMode: tlsModeEnum("tls_mode").notNull().default("opportunistic"),
    sesConfigurationSet: text("ses_configuration_set"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("domains_team_name_idx").on(t.teamId, t.name)],
);
