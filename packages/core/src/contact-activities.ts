import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";

export type ContactActivityRow = typeof schema.contactActivities.$inferInsert;

/**
 * Append rows to the contact's activity timeline. Call AFTER the parent
 * mutation commits (never inside its transaction): the write is best-effort —
 * a timeline insert failure is logged and swallowed so it can never fail the
 * mutation it records.
 */
export async function recordContactActivity(
  db: Db,
  rows: ContactActivityRow | ContactActivityRow[],
): Promise<void> {
  const values = Array.isArray(rows) ? rows : [rows];
  if (values.length === 0) return;
  try {
    await db.insert(schema.contactActivities).values(values);
  } catch (err) {
    console.error("contact activity write failed", err);
  }
}
