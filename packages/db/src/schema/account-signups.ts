import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Where each account signed up from, for the operator only. No foreign key
 * on purpose: the row outlives the account by 90 days, or by 12 months when
 * the account sat in a team suspended for abuse, so a throwaway account
 * deleted minutes after sign-up still leaves its trace. The retention sweep
 * stamps both columns below and deletes what is past them.
 */
export const accountSignups = pgTable(
  "account_signups",
  {
    userId: text("user_id").primaryKey(),
    email: text("email").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // A member of a team suspended for phishing, manual or reputation reasons,
    // as the sweep last saw the account alive.
    abuseSuspended: boolean("abuse_suspended").notNull().default(false),
    // When the sweep first found the account gone; retention counts from it.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("account_signups_ip_idx").on(t.ip).where(sql`${t.ip} is not null`)],
);
