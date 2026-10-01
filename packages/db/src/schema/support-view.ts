import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { teams } from "./teams.js";

/**
 * The controller's instruction a support view rests on; the reference ties it
 * to a request. Every value is a request the customer made: an operator
 * checking an abuse report works from the console's own metadata and, when
 * content is needed, the Trust & safety reveal, neither of which opens the
 * customer's dashboard.
 */
export const supportViewReasonEnum = pgEnum("support_view_reason", [
  "support_ticket",
  "billing_dispute",
  "other",
]);

export const supportViewEndedByEnum = pgEnum("support_view_ended_by", [
  "operator",
  "owner",
  "expiry",
]);

/**
 * One read-only look at a team's dashboard by the instance operator: who,
 * which team, why, until when, how it ended, and which procedures were
 * read (a path → count map; never what they returned). The grant rides on
 * the operator's own session and is the record GDPR art. 30 asks for.
 */
export const supportViewGrants = pgTable(
  "support_view_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    operatorUserId: text("operator_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    reason: supportViewReasonEnum("reason").notNull(),
    reference: text("reference"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedBy: supportViewEndedByEnum("ended_by"),
    procedures: jsonb("procedures").$type<Record<string, number>>().notNull().default({}),
    // ponytail: nothing writes this; drop it in the next migration that touches this table.
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (t) => [
    // One live view per operator, enforced where a race cannot get past it.
    uniqueIndex("support_view_grants_live_operator_idx")
      .on(t.operatorUserId)
      .where(sql`${t.endedAt} is null`),
    index("support_view_grants_team_idx").on(t.teamId, t.createdAt),
  ],
);
