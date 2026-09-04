import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { type ContactEventContext, emitActivityEvents } from "./contact-events.js";

export type ContactActivityRow = typeof schema.contactActivities.$inferInsert;

/**
 * Append rows to the contact's activity timeline. Call AFTER the parent
 * mutation commits (never inside its transaction): the write is best-effort —
 * a timeline insert failure is logged and swallowed so it can never fail the
 * mutation it records.
 *
 * The same transitions feed the team's webhooks: every write path already
 * passes through here with the "did the effective state really flip?"
 * filtering done, so `events` publishes them without a second set of hooks.
 */
export async function recordContactActivity(
  db: Db,
  rows: ContactActivityRow | ContactActivityRow[],
  events?: ContactEventContext,
): Promise<void> {
  const values = Array.isArray(rows) ? rows : [rows];
  if (values.length === 0) return;
  try {
    await db.insert(schema.contactActivities).values(values);
  } catch (err) {
    console.error("contact activity write failed", err);
  }
  if (events) await emitActivityEvents(db, values, events);
}
