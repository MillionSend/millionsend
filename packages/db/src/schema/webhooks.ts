import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { bytea } from "./custom-types.js";
import { emails } from "./emails.js";
import { teams } from "./teams.js";

export const webhookStatusEnum = pgEnum("webhook_status", ["enabled", "disabled", "auto_disabled"]);

export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id")
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  description: text("description"),
  // Standard Webhooks whsec_ secret, envelope-encrypted like email bodies
  // (per-row DEK wrapped by the keyring KEK — never plaintext at rest).
  secretCiphertext: bytea("secret_ciphertext").notNull(),
  secretIv: bytea("secret_iv").notNull(),
  secretWrappedDek: bytea("secret_wrapped_dek").notNull(),
  secretKeyVersion: integer("secret_key_version").notNull(),
  // Display-only masked form ("whsec_…abcd"); never enough to reconstruct.
  secretLast4: text("secret_last4").notNull(),
  // null = subscribe to all event types.
  events: jsonb("events").$type<string[]>(),
  status: webhookStatusEnum("status").notNull().default("enabled"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status", [
  "pending",
  "success",
  "failed",
  "exhausted",
]);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    emailId: uuid("email_id").references(() => emails.id, { onDelete: "set null" }),
    // Standard Webhooks msg id: stable across retries so receivers can dedupe.
    messageId: text("message_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: webhookDeliveryStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastResponseCode: integer("last_response_code"),
    // Truncated snippet for debugging; the delivery client caps reads anyway.
    lastResponseBody: text("last_response_body"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("webhook_deliveries_endpoint_idx").on(t.endpointId, t.createdAt),
    index("webhook_deliveries_created_idx").on(t.createdAt),
    // The retry worker polls non-terminal rows; keep that scan on a small
    // partial index that rows exit as soon as they reach a terminal status.
    index("webhook_deliveries_open_idx")
      .on(t.createdAt)
      .where(sql`${t.status} in ('pending', 'failed')`),
  ],
);
