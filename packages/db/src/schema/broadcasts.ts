import { index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { audiences } from "./audiences.js";
import { segments } from "./segments.js";
import { teams } from "./teams.js";
import { topics } from "./topics.js";

/**
 * Lifecycle: draft → scheduled → sending → sent, with scheduled → canceled as
 * the only cancel path. The fan-out worker re-checks status before doing any
 * work, so a cancel that races the send job is safe.
 */
export const broadcastStatusEnum = pgEnum("broadcast_status", [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "canceled",
]);

export const broadcasts = pgTable(
  "broadcasts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // SET NULL, not CASCADE: deleting an audience must not erase the send
    // history of broadcasts already sent to it.
    audienceId: uuid("audience_id").references(() => audiences.id, { onDelete: "set null" }),
    // SET NULL, not CASCADE: deleting a topic must not erase the send history
    // of broadcasts already sent under it. A null topicId is a global send.
    topicId: uuid("topic_id").references(() => topics.id, { onDelete: "set null" }),
    // Optional MillionSend segment (a filtered subset of the audience). SET NULL
    // on delete: the fan-out treats a null segmentId as "whole audience", so a
    // deleted segment gracefully widens the target rather than orphaning the row.
    segmentId: uuid("segment_id").references(() => segments.id, { onDelete: "set null" }),
    // Internal label, never rendered into the email.
    name: text("name"),
    from: text("from").notNull(),
    subject: text("subject").notNull(),
    // JSON-encoded string array (the wire format accepts one or many
    // addresses; a text column keeps the pinned schema contract).
    replyTo: text("reply_to"),
    html: text("html"),
    text: text("text"),
    status: broadcastStatusEnum("status").notNull().default("draft"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("broadcasts_team_idx").on(t.teamId)],
);
