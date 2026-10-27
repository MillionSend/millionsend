import { sql } from "drizzle-orm";
import { check, integer, pgTable, smallint, timestamp } from "drizzle-orm/pg-core";
import { monitorSettingColumns } from "./monitor.js";

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
    // Percent of every served region's SES 24-hour quota that broadcasts
    // never touch; transactional mail may use all of it and borrow beyond.
    sesTransactionalReserve: smallint("ses_transactional_reserve"),
    emailRetentionDays: integer("email_retention_days"),
    ...monitorSettingColumns,
    // The Free fuse (Cloud): set when complaints on Free teams' mail reach
    // its line, with their count, and cleared only by an operator's release;
    // complaints on mail sent before the last release no longer count.
    freeFuseTrippedAt: timestamp("free_fuse_tripped_at", { withTimezone: true }),
    freeFuseComplaints: integer("free_fuse_complaints"),
    freeFuseReleasedAt: timestamp("free_fuse_released_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("instance_settings_single_row", sql`${t.id} = 1`)],
);
