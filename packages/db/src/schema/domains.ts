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

/** One expected DNS record's live verdict, snapshotted at verification time. */
export interface DomainDnsRecord {
  group: string;
  name: string;
  type: string;
  status: "found" | "mismatch" | "missing" | "unknown";
}

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
    // The 72h auto-unset clock for a branded tracking subdomain: stamped when a
    // subdomain is adopted, cleared once its CNAME resolves (or on unset). While
    // set, an unresolved subdomain past 72h is unset by the worker, mirroring how
    // a never-verified domain is reaped. NULL = nothing pending to reap.
    trackingSubdomainSetAt: timestamp("tracking_subdomain_set_at", { withTimezone: true }),
    // Both tracking kinds are off by default, as the Domains docs promise.
    clickTracking: boolean("click_tracking").notNull().default(false),
    openTracking: boolean("open_tracking").notNull().default(false),
    tlsMode: tlsModeEnum("tls_mode").notNull().default("opportunistic"),
    sesConfigurationSet: text("ses_configuration_set"),
    // Stamped once the identity (and shared configuration set) are associated
    // with the team's SES tenant; sends carry TenantName only after that, since
    // SES rejects a tenant send whose resources are not associated. NULL = the
    // hourly tenants.sync backfill still has to do it.
    sesTenantAssociatedAt: timestamp("ses_tenant_associated_at", { withTimezone: true }),
    // The configuration set associated alongside the identity (NULL = none was).
    // A send names TenantName only while this matches the set it will use;
    // tenants.sync re-associates rows whose value drifted from the env.
    sesTenantConfigSet: text("ses_tenant_config_set"),
    // Per-record snapshot persisted by every verification pass so send-time
    // insights never do live DNS.
    dnsRecords: jsonb("dns_records").$type<DomainDnsRecord[]>(),
    // null = no valid DMARC record found, or never checked.
    dmarcPolicy: text("dmarc_policy").$type<"none" | "quarantine" | "reject">(),
    dmarcCheckedAt: timestamp("dmarc_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("domains_team_name_idx").on(t.teamId, t.name)],
);
