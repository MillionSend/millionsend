import { createHmac, hkdfSync, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { accountMailDeliverable } from "@millionsend/config";
import {
  bindConsoleCodeMail,
  CONSOLE_CODE_MINUTES,
  consoleCodeId,
  consoleCodeUnsentId,
  createFixedWindowLimiter,
  replaceConsoleCodeRow,
  SUPPORT_VIEW_SIGN_IN_MINUTES,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, sql } from "drizzle-orm";
import { requireAuthSecret } from "./auth-secret";
import { accountMailLocale } from "./locale";
import { buildConsoleCodeEmail, defaultSystemMailDeps } from "./system-mail";
import type { AuthSession } from "./trpc";

/** Wrong entries one code takes; the last of them voids it. */
export const CONSOLE_CODE_TRIES = 5;
/** Codes one operator may be sent in an hour. */
export const CONSOLE_CODES_PER_HOUR = 5;

const v = schema.verification;
const verifiedId = (sessionId: string) => `console-code-verified:${sessionId}`;

let sendsLimited = createFixedWindowLimiter(CONSOLE_CODES_PER_HOUR, 3_600_000);

/** Tests: a fresh hour for the send limit. */
export function resetConsoleCodeSends(): void {
  sendsLimited = createFixedWindowLimiter(CONSOLE_CODES_PER_HOUR, 3_600_000);
}

/**
 * Keyed by the auth secret: six digits are a million guesses away, so a
 * plain hash read off the row would give the code back.
 */
function codeMac(userId: string, code: string): string {
  const key = hkdfSync("sha256", requireAuthSecret(), Buffer.alloc(0), "console-code", 32);
  return createHmac("sha256", Buffer.from(key)).update(`${userId}:${code}`).digest("hex");
}

/** Whether a code email to the operator failed in the last minutes, here or in the queue. */
async function codeUnsent(db: Db, userId: string, now: Date): Promise<boolean> {
  const [unsent] = await db
    .select({ id: v.id })
    .from(v)
    .where(and(eq(v.identifier, consoleCodeUnsentId(userId)), gt(v.expiresAt, now)))
    .limit(1);
  return unsent !== undefined;
}

export type ConsoleCodeSend =
  | { sent: true; to: string; minutes: number }
  | { sent: false; reason: "no_mail" | "send_failed" };

/**
 * Emails the operator a new one-time code, which replaces any earlier one.
 * When the instance cannot send account mail, or a code email to them just
 * failed, it says so instead. A failure leaves the mark that lets a recent
 * sign-in stand in (consoleStepUp): this send's own, or the worker's for a
 * code email the queue accepted and then could not deliver. Only the
 * server's own attempts open that fallback, never a client saying the mail
 * did not arrive.
 */
export async function sendConsoleCode(
  db: Db,
  user: { id: string; email: string },
  now: Date = new Date(),
): Promise<ConsoleCodeSend> {
  if (!accountMailDeliverable()) return { sent: false, reason: "no_mail" };
  // While the mark stands no new code goes out: one the queue accepted would
  // fail out of sight again, behind a field waiting for a code that never comes.
  if (await codeUnsent(db, user.id, now)) return { sent: false, reason: "send_failed" };
  if (sendsLimited(user.id)) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "code_limit" });
  }
  const code = String(randomInt(1_000_000)).padStart(6, "0");
  await replaceConsoleCodeRow(
    db,
    user.id,
    { identifier: consoleCodeId(user.id), value: `${codeMac(user.id, code)}:0` },
    now,
  );
  try {
    const locale = await accountMailLocale(db, user.email, null);
    await defaultSystemMailDeps.send(
      buildConsoleCodeEmail({ to: user.email, code, minutes: CONSOLE_CODE_MINUTES, locale }),
      { completeInTx: (tx, emailId) => bindConsoleCodeMail(tx, user.id, emailId, now) },
    );
    return { sent: true, to: user.email, minutes: CONSOLE_CODE_MINUTES };
  } catch (error) {
    console.error("console code email failed to send", error);
    await replaceConsoleCodeRow(
      db,
      user.id,
      { identifier: consoleCodeUnsentId(user.id), value: "1" },
      now,
    );
    return { sent: false, reason: "send_failed" };
  }
}

/** Whether the sign-in is recent enough to stand in for a code that could not be sent. */
export function signedInRecently(session: AuthSession, now: Date = new Date()): boolean {
  const at = session.session?.createdAt;
  return at !== undefined && now.getTime() - at.getTime() <= SUPPORT_VIEW_SIGN_IN_MINUTES * 60_000;
}

/**
 * Until when a code confirmed on this session covers its starts, or null.
 * Only while the session's row stands, so signing out, which deletes it,
 * ends the mark with it.
 */
export async function consoleCodeVerifiedUntil(
  db: Db,
  session: AuthSession,
  now: Date = new Date(),
): Promise<Date | null> {
  const sessionId = session.session?.id;
  if (!sessionId) return null;
  const s = schema.session;
  const [mark] = await db
    .select({ until: v.expiresAt })
    .from(v)
    .innerJoin(s, and(eq(s.id, sessionId), eq(s.userId, session.user.id)))
    .where(
      and(
        eq(v.identifier, verifiedId(sessionId)),
        eq(v.value, session.user.id),
        gt(v.expiresAt, now),
      ),
    )
    .limit(1);
  return mark?.until ?? null;
}

function refusal(message: string): TRPCError {
  return new TRPCError({ code: "PRECONDITION_FAILED", message });
}

/** Spends one try of the operator's code on `code`; a match uses the code up. */
async function spendCode(
  db: Db,
  userId: string,
  code: string,
  now: Date,
): Promise<"ok" | "code_invalid" | "code_void"> {
  // The try is spent before the comparison and in one statement, so guesses
  // sent in parallel each cost one.
  const [row] = await db
    .update(v)
    .set({
      value: sql`split_part(${v.value}, ':', 1) || ':' || (split_part(${v.value}, ':', 2)::int + 1)`,
      updatedAt: now,
    })
    .where(
      and(
        eq(v.identifier, consoleCodeId(userId)),
        gt(v.expiresAt, now),
        sql`split_part(${v.value}, ':', 2)::int < ${CONSOLE_CODE_TRIES}`,
      ),
    )
    .returning({ id: v.id, value: v.value });
  if (!row) return "code_void";
  const [stored = "", tries = ""] = row.value.split(":");
  const given = codeMac(userId, code);
  if (stored.length === given.length && timingSafeEqual(Buffer.from(stored), Buffer.from(given))) {
    const [used] = await db.delete(v).where(eq(v.id, row.id)).returning({ id: v.id });
    return used ? "ok" : "code_void";
  }
  if (Number(tries) < CONSOLE_CODE_TRIES) return "code_invalid";
  await db.delete(v).where(eq(v.id, row.id));
  return "code_void";
}

/**
 * The step-up in front of starting a support view: the operator's emailed
 * code, which then covers this session's starts for
 * SUPPORT_VIEW_SIGN_IN_MINUTES, or, only when no code could reach them, a
 * sign-in from the last SUPPORT_VIEW_SIGN_IN_MINUTES. Throws the refusal the
 * dialog explains.
 */
export async function consoleStepUp(
  db: Db,
  session: AuthSession,
  code: string | undefined,
  now: Date = new Date(),
): Promise<void> {
  const userId = session.user.id;
  if (code !== undefined) {
    const outcome = await spendCode(db, userId, code, now);
    if (outcome !== "ok") throw refusal(outcome);
    const sessionId = session.session?.id;
    if (sessionId) {
      await db.delete(v).where(eq(v.identifier, verifiedId(sessionId)));
      await db.insert(v).values({
        id: randomUUID(),
        identifier: verifiedId(sessionId),
        value: userId,
        expiresAt: new Date(now.getTime() + SUPPORT_VIEW_SIGN_IN_MINUTES * 60_000),
        createdAt: now,
        updatedAt: now,
      });
    }
    return;
  }
  if (await consoleCodeVerifiedUntil(db, session, now)) return;
  if (accountMailDeliverable() && !(await codeUnsent(db, userId, now))) {
    throw refusal("code_required");
  }
  if (!signedInRecently(session, now)) throw refusal("sign_in_again");
}
