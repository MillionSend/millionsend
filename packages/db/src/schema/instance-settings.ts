import { sql } from "drizzle-orm";
import { check, integer, pgTable, smallint, timestamp } from "drizzle-orm/pg-core";

/**
 * Instance-wide operator settings (self-host application config), one row
 * enforced by the CHECK. A NULL column means "unset": readers fall back to
 * the env var, then its built-in default — env stays the bootstrap value,
 * the dashboard (Settings → Instance) is the runtime override.
 */
export const instanceSettings = pgTable(
  "instance_settings",
  {
    id: smallint("id").primaryKey().default(1),
    sesMaxSendRate: integer("ses_max_send_rate"),
    emailRetentionDays: integer("email_retention_days"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("instance_settings_single_row", sql`${t.id} = 1`)],
);
