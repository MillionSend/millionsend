import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { bytea } from "./custom-types.js";

/**
 * Third-party data the worker downloads and the other processes read, one
 * row per file. A row is replaced only by a download that parsed, so a
 * failed refresh leaves the last good copy in place.
 */
export const referenceData = pgTable("reference_data", {
  name: text("name").primaryKey(),
  version: text("version").notNull(),
  content: bytea("content").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});
