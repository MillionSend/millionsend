import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

export const suppressionReasonEnum = pgEnum("suppression_reason", [
  "hard_bounce",
  "complaint",
  "manual",
  "one_click_unsubscribe",
]);

/**
 * Suppressions outlive GDPR/LGPD erasure (do-not-contact is retained as
 * legitimate interest, in the data subject's own interest): erasure nulls
 * `email` but keeps `emailHash`, which remains the uniqueness/lookup key.
 */
export const suppressions = pgTable(
  "suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    email: text("email"),
    emailHash: text("email_hash").notNull(),
    reason: suppressionReasonEnum("reason").notNull(),
    sourceEmailId: uuid("source_email_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("suppressions_team_hash_idx").on(t.teamId, t.emailHash)],
);
