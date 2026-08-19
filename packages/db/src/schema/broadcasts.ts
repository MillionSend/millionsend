import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
    // RESTRICT is a safety boundary: null means "all contacts", so SET NULL
    // could silently widen a scheduled broadcast when its topic was deleted.
    // Keeping the referenced target also preserves historical send meaning.
    topicId: uuid("topic_id").references(() => topics.id, { onDelete: "restrict" }),
    // The same invariant applies to segments: deleting one must never turn a
    // narrow campaign into an all-contacts send.
    segmentId: uuid("segment_id").references(() => segments.id, { onDelete: "restrict" }),
    // Internal label, never rendered into the email.
    name: text("name"),
    from: text("from").notNull(),
    subject: text("subject").notNull(),
    previewText: text("preview_text"),
    // JSON-encoded string array (the wire format accepts one or many
    // addresses; a text column keeps the pinned schema contract).
    replyTo: text("reply_to"),
    html: text("html"),
    text: text("text"),
    // Block-editor source of truth (BlockDoc). Null → legacy raw-HTML row whose
    // `html` was hand-authored; the app renders those in CODE mode.
    document: jsonb("document").$type<unknown>(),
    status: broadcastStatusEnum("status").notNull().default("draft"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("broadcasts_team_idx").on(t.teamId)],
);
