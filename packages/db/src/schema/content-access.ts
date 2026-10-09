import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

/** The security reasons an operator may name; nothing decrypts without one. */
export const contentAccessReasonEnum = pgEnum("content_access_reason", [
  "phishing_or_malware",
  "complaint_spike",
  "provider_report",
  "legal_request",
  "owner_support_request",
]);

export const contentAccessScopeEnum = pgEnum("content_access_scope", ["email", "flagged_window"]);

/**
 * One break-glass grant: an operator's time-boxed permission to read the
 * subject and rendered text of named messages, with the reason and the
 * justification they gave before anything was decrypted.
 *
 * Rows are the access inventory a security measure over other people's
 * content has to keep: nothing prunes them, neither the retention cron nor
 * the message they point at, and they outlive both. `email_ids` is a plain
 * jsonb array rather than a join table for the same reason. They do go with
 * the team, whose deletion takes everything about it.
 */
export const contentAccessGrants = pgTable(
  "content_access_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // User id of the operator, deliberately without an FK (as team_flags
    // does): the inventory of who read what must outlive the account.
    operatorUserId: text("operator_user_id").notNull(),
    reason: contentAccessReasonEnum("reason").notNull(),
    // Never copied into an audit row or a job payload: an operator's own
    // words about a customer belong to the grant alone.
    justification: text("justification").notNull(),
    scope: contentAccessScopeEnum("scope").notNull(),
    emailIds: jsonb("email_ids").$type<string[]>().notNull(),
    // The second operator who approved a whole-window grant. Null while the
    // instance has one operator; approvals are not built.
    approvedBy: text("approved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    viewCount: integer("view_count").notNull().default(0),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
    // When the seven-day disclosure ran — including when it was withheld
    // because the team had been suspended for phishing by then, which is why
    // this is stamped even with team_visible_at left null. A team held for
    // review stays unstamped until the hold ends. Nothing is mailed.
    noticeSentAt: timestamp("notice_sent_at", { withTimezone: true }),
    // When the team's own audit gained its row for this access.
    teamVisibleAt: timestamp("team_visible_at", { withTimezone: true }),
  },
  (t) => [index("content_access_grants_team_idx").on(t.teamId, t.createdAt.desc())],
);
