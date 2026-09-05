import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Keyset boundary over (createdAt, id) relative to the row `cursorId`. The
 * cursor's timestamp is read by a scalar subquery in SQL, never through a JS
 * Date: timestamptz stores microseconds and Date keeps milliseconds, so a
 * Date-bound cursor readmits its own row and every row sharing its
 * millisecond (a batch insert shares one now()) — page 2 == page 1, forever.
 */
export function keysetCursorWhere(
  createdAt: AnyPgColumn,
  id: AnyPgColumn,
  cursorId: string,
  direction: "after" | "before" = "after",
): SQL {
  const cursorCreatedAt = sql`(select ${createdAt} from ${createdAt.table} where ${id} = ${cursorId}::uuid)`;
  return direction === "before"
    ? sql`(${createdAt}, ${id}) < (${cursorCreatedAt}, ${cursorId}::uuid)`
    : sql`(${createdAt}, ${id}) > (${cursorCreatedAt}, ${cursorId}::uuid)`;
}
