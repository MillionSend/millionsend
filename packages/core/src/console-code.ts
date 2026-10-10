import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, gt, inArray, like, sql } from "drizzle-orm";
import { SYSTEM_MAIL_TAG } from "./system-mail.js";

/** How long an emailed console code works, and how long the mark of one that never arrived stands. */
export const CONSOLE_CODE_MINUTES = 10;

const v = schema.verification;
const MAIL_PREFIX = "console-code-mail:";

// Better Auth's verification rows behind the console code, at most one of
// each per operator: the live code as `<hmac>:<tries spent>`, the mark of a
// code email that did not reach the operator, and the id of the email that
// carries the live code.
export const consoleCodeId = (userId: string) => `console-code:${userId}`;
export const consoleCodeUnsentId = (userId: string) => `console-code-unsent:${userId}`;
const mailId = (userId: string) => `${MAIL_PREFIX}${userId}`;

// Writers of one operator's rows queue here, so no second code sits beside
// the first and no stale failure lands after a newer code.
const lockOperator = (tx: Db, userId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${consoleCodeId(userId)}))`);

/** Leaves `row` as the operator's only console-code row, valid for the code's minutes. */
export async function replaceConsoleCodeRow(
  db: Db,
  userId: string,
  row: { identifier: string; value: string },
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await lockOperator(t, userId);
    await t
      .delete(v)
      .where(
        inArray(v.identifier, [consoleCodeId(userId), consoleCodeUnsentId(userId), mailId(userId)]),
      );
    await t.insert(v).values({
      id: randomUUID(),
      ...row,
      expiresAt: new Date(now.getTime() + CONSOLE_CODE_MINUTES * 60_000),
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** For sendSystemMail's completeInTx: names the email that carries the operator's live code. */
export async function bindConsoleCodeMail(
  tx: Db,
  userId: string,
  emailId: string,
  now: Date,
): Promise<void> {
  await tx.insert(v).values({
    id: randomUUID(),
    identifier: mailId(userId),
    value: emailId,
    expiresAt: new Date(now.getTime() + CONSOLE_CODE_MINUTES * 60_000),
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * The queue's half of the code's fallback: when the email carrying an
 * operator's live code ends without reaching them (refused, failed, bounced,
 * or held back from SES), it leaves the mark a failed send leaves, so a
 * recent sign-in stands in. Only the row bound in that email's own accept
 * makes it the code's mail; the tag, which any sender can set, just spares
 * every other email the lookup. The code itself stays: a retry or a release
 * may still deliver it.
 */
export async function noteConsoleCodeUndelivered(
  db: Db,
  email: { id: string; tags: Record<string, string> | null },
  now: Date = new Date(),
): Promise<void> {
  if (email.tags?.[SYSTEM_MAIL_TAG] !== "console_code") return;
  const [bound] = await db
    .select({ identifier: v.identifier })
    .from(v)
    .where(and(like(v.identifier, `${MAIL_PREFIX}%`), eq(v.value, email.id), gt(v.expiresAt, now)))
    .limit(1);
  if (!bound) return;
  const userId = bound.identifier.slice(MAIL_PREFIX.length);
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await lockOperator(t, userId);
    // A newer code replaced the binding in the meantime: its own email decides.
    const [current] = await t
      .select({ id: v.id })
      .from(v)
      .where(and(eq(v.identifier, mailId(userId)), eq(v.value, email.id)))
      .limit(1);
    if (!current) return;
    await t.delete(v).where(eq(v.identifier, consoleCodeUnsentId(userId)));
    await t.insert(v).values({
      id: randomUUID(),
      identifier: consoleCodeUnsentId(userId),
      value: "1",
      expiresAt: new Date(now.getTime() + CONSOLE_CODE_MINUTES * 60_000),
      createdAt: now,
      updatedAt: now,
    });
  });
}
