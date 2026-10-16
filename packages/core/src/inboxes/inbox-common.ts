import { randomInt } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { AuditActor } from "../audit.js";
import type { InboxActor } from "./activity.js";
import { LABEL_NAME_MAX } from "./organize.js";
import {
  CURSOR_NOT_FOUND_MESSAGE,
  INBOX_NOT_FOUND_MESSAGE,
  type InboxError,
  type ListQuery,
} from "./types.js";

// Helpers the inbox modules share. Not re-exported from the package index.

export const INBOX_NOT_FOUND: InboxError = {
  status: 404,
  name: "not_found",
  message: INBOX_NOT_FOUND_MESSAGE,
};

/** Resend's answer when `after` or `before` names no item of the list. */
export const CURSOR_NOT_FOUND: InboxError = {
  status: 404,
  name: "not_found",
  message: CURSOR_NOT_FOUND_MESSAGE,
};

export const invalid = (message: string): InboxError => ({
  status: 422,
  name: "validation_error",
  message,
});

export const notFound = (message: string): InboxError => ({
  status: 404,
  name: "not_found",
  message,
});

export const labelNotFound = (id: string): InboxError => notFound(`Label "${id}" not found.`);

export const isInboxError = (v: unknown): v is InboxError =>
  typeof v === "object" && v !== null && "status" in v && "name" in v && "message" in v;

/** A label name, or an inbox name given `max`: 1 to `max` characters after trimming, on one line. */
export function oneLineName(value: string, max = LABEL_NAME_MAX): string | InboxError {
  const name = value.trim();
  return name.length === 0 || name.length > max || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)
    ? invalid(`name must be 1-${max} characters on one line`)
    : name;
}

/**
 * The audit_log actor for an inbox actor, as apiRequestActor names it; an
 * OAuth (MCP) client rides in metadata.
 */
export function auditActorOf(actor: InboxActor): {
  actor: AuditActor;
  metadata: Record<string, unknown>;
} {
  switch (actor.kind) {
    case "user":
      return { actor: { userId: actor.userId }, metadata: {} };
    case "api_key":
      return { actor: { apiKeyId: actor.apiKeyId }, metadata: {} };
    case "oauth":
      return { actor: { userId: actor.userId }, metadata: { oauth_client_id: actor.clientId } };
    case "system":
      return { actor: "system", metadata: {} };
  }
}

const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

/** `n` random lowercase letters and digits, for generated addresses and labels. */
export const randomAlnum = (n: number): string =>
  Array.from({ length: n }, () => ALNUM[randomInt(ALNUM.length)]).join("");

/**
 * One keyset page of a list ordered by (key, id). A newest-first list pages
 * toward older rows with `after`, an oldest-first one toward newer rows.
 * `cursorKey` reads the cursor row's sort key in SQL, never through a JS
 * Date, which would drop the microseconds and readmit rows sharing its
 * millisecond.
 */
export async function keysetRows<R>(p: {
  query: ListQuery;
  key: AnyPgColumn | SQL;
  id: AnyPgColumn | SQL;
  newestFirst: boolean;
  /** Whether the cursor is an item of this list (its scope, not its filters). */
  cursorExists: (cursorId: string) => Promise<boolean>;
  cursorKey: (cursorId: string) => SQL;
  load: (where: SQL | undefined, orderBy: SQL[], take: number) => Promise<R[]>;
}): Promise<{ rows: R[]; hasMore: boolean } | "bad_cursor"> {
  const limit = p.query.limit ?? 20;
  const cursorId = p.query.before ?? p.query.after;
  const forward = !p.query.before;
  // Walking a newest-first list forward, or an oldest-first one backward, reads descending.
  const descending = p.newestFirst === forward;
  let where: SQL | undefined;
  if (cursorId) {
    if (!(await p.cursorExists(cursorId))) return "bad_cursor";
    const cursor = sql`(${p.cursorKey(cursorId)}, ${cursorId}::uuid)`;
    where = descending
      ? sql`(${p.key}, ${p.id}) < ${cursor}`
      : sql`(${p.key}, ${p.id}) > ${cursor}`;
  }
  const direction = descending ? sql`desc` : sql`asc`;
  // One extra row decides has_more without a count.
  const fetched = await p.load(
    where,
    [sql`${p.key} ${direction}`, sql`${p.id} ${direction}`],
    limit + 1,
  );
  const rows = fetched.slice(0, limit);
  // A `before` page is read outward from its cursor; the answer keeps the list's order.
  if (p.query.before) rows.reverse();
  return { rows, hasMore: fetched.length > limit };
}
