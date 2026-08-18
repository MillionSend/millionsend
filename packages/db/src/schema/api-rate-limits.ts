import { integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { apiKeys } from "./api-keys.js";

/** One fixed-window bucket per API key; updates are atomic across replicas. */
export const apiRateLimits = pgTable("api_rate_limits", {
  apiKeyId: uuid("api_key_id")
    .primaryKey()
    .references(() => apiKeys.id, { onDelete: "cascade" }),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
});
