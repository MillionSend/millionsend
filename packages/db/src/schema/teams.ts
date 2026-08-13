import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const planEnum = pgEnum("plan", ["free", "pro", "scale", "self_hosted"]);

export const teams = pgTable("teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: planEnum("plan").notNull().default("free"),
  // SES tenant name for cloud reputation isolation; null on self-host.
  sesTenantName: text("ses_tenant_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
