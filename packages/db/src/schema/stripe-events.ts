import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Webhook dedupe ledger: insert the Stripe event id before acting on it so a
// redelivered event is a no-op instead of a second plan change.
export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});
