import { and, lt, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";

/**
 * Keyset cursor over (createdAt desc, id desc); id breaks createdAt ties.
 * createdAt travels as the Postgres text rendering of the timestamptz, not
 * as a Date: timestamptz carries microseconds and a JS Date only
 * milliseconds, so a Date round-trip would silently skip same-millisecond
 * rows at page boundaries.
 *
 * Mirror: routers/emails.ts keeps a local copy of these helpers (plus an
 * ascending variant) predating this module.
 */
export const cursorSchema = z.object({ createdAt: z.string(), id: z.uuid() });
export type Cursor = z.infer<typeof cursorSchema>;

export function beforeCursor(
  t: { createdAt: AnyPgColumn; id: AnyPgColumn },
  cursor: Cursor,
): SQL | undefined {
  return or(
    sql`${t.createdAt} < ${cursor.createdAt}::timestamptz`,
    and(sql`${t.createdAt} = ${cursor.createdAt}::timestamptz`, lt(t.id, cursor.id)),
  );
}

/** Full-precision cursor value for a row's createdAt (see cursorSchema). */
export function createdAtCursorField(t: { createdAt: AnyPgColumn }): SQL<string> {
  return sql<string>`${t.createdAt}::text`;
}

/**
 * Splits a limit+1 fetch into the page and its next-page cursor. Rows must
 * already be ordered on (createdAt desc, id desc); the cursorCreatedAt field
 * feeds the cursor and is stripped from the returned items.
 */
export function paginate<T extends { id: string; cursorCreatedAt: string }>(
  rows: T[],
  limit: number,
): { items: Omit<T, "cursorCreatedAt">[]; nextCursor: Cursor | null } {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last ? { createdAt: last.cursorCreatedAt, id: last.id } : null;
  const items = page.map(({ cursorCreatedAt: _cursorCreatedAt, ...item }) => item);
  return { items, nextCursor };
}
