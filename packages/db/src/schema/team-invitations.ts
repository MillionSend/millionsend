import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { teamMemberRoleEnum, user } from "./auth.js";
import { teams } from "./teams.js";

/**
 * Pending team invitations. The accept token is not stored: it is an
 * HMAC-signed derivation of `id` (see core/signInviteToken), so revoke is a
 * hard delete and single-use is enforced by stamping acceptedAt. The partial
 * unique index allows only one un-accepted invite per (team, lowercased
 * email); re-inviting after accept or revoke is unblocked.
 */
export const teamInvitations = pgTable(
  "team_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    // Only member/admin are invitable; owner is reserved for team creators.
    role: teamMemberRoleEnum("role").notNull().default("member"),
    invitedByUserId: text("invited_by_user_id").references(() => user.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("team_invitations_team_email_pending_idx")
      .on(t.teamId, sql`lower(${t.email})`)
      .where(sql`${t.acceptedAt} is null`),
  ],
);
