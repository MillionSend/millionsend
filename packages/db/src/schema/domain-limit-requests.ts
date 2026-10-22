import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { domains } from "./domains.js";
import { teams } from "./teams.js";

/** What the domain will send, as the team describes it. */
export const domainLimitRequestSendsEnum = pgEnum("domain_limit_request_sends", [
  "account",
  "notifications",
  "marketing",
  "mix",
]);

/** Where that mail goes out today: nowhere yet, another provider, or the team's own servers. */
export const domainLimitRequestSourceEnum = pgEnum("domain_limit_request_source", [
  "new",
  "other_provider",
  "own_servers",
]);

export const domainLimitRequestStatusEnum = pgEnum("domain_limit_request_status", [
  "open",
  "granted",
  "declined",
]);

/**
 * A team asking to lift the new domain limit on one of its domains. An
 * operator grants it by trusting the domain (any trust of the domain or its
 * team grants what is open) or declines it; the team hears the outcome by
 * email, never who decided. The two notified_at columns are the sweep's
 * claims: one notice to the operator per request, one outcome to the team.
 */
export const domainLimitRequests = pgTable(
  "domain_limit_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
    sends: domainLimitRequestSendsEnum("sends").notNull(),
    perDay: integer("per_day").notNull(),
    source: domainLimitRequestSourceEnum("source").notNull(),
    note: text("note"),
    status: domainLimitRequestStatusEnum("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // The operator's email, for the console; the team never sees it.
    resolvedBy: text("resolved_by"),
    operatorNotifiedAt: timestamp("operator_notified_at", { withTimezone: true }),
    outcomeNotifiedAt: timestamp("outcome_notified_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("domain_limit_requests_open_domain_idx")
      .on(t.domainId)
      .where(sql`${t.status} = 'open'`),
    index("domain_limit_requests_status_idx").on(t.status, t.createdAt),
  ],
);
