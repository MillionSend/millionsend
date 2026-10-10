import { createHmac, hkdfSync, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { accountMailDeliverable } from "@millionsend/config";
import { createFixedWindowLimiter, SUPPORT_VIEW_SIGN_IN_MINUTES } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { requireAuthSecret } from "./auth-secret";
import { accountMailLocale } from "./locale";
import { buildConsoleCodeEmail, defaultSystemMailDeps } from "./system-mail";
import type { AuthSession } from "./trpc";

/** How long an emailed console code works. */
export const CONSOLE_CODE_MINUTES = 10;
/** Wrong entries one code takes; the last of them voids it. */
export const CONSOLE_CODE_TRIES = 5;
/** Codes one operator may be sent in an hour. */
export const CONSOLE_CODES_PER_HOUR = 5;

const v = schema.verification;
// Better Auth's verification rows, at most one of each per operator: the
// live code as `<hmac>:<tries spent>`, and the mark of a send that failed.
const codeId = (userId: string) => `console-code:${userId}`;
const unsentId = (userId: string) => `console-code-unsent:${userId}`;

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

/** Leaves `row` as the operator's only console-code row, valid for the code's minutes. */
async function replaceRow(
  db: Db,
  userId: string,
  row: { identifier: string; value: string },
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Sends by one operator queue here, so no second code sits beside the first.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${codeId(userId)}))`);
    await tx.delete(v).where(inArray(v.identifier, [codeId(userId), unsentId(userId)]));
    await tx.insert(v).values({
      id: randomUUID(),
      ...row,
      expiresAt: new Date(now.getTime() + CONSOLE_CODE_MINUTES * 60_000),
      createdAt: now,
      updatedAt: now,
    });
  });
}

export type ConsoleCodeSend =
  | { sent: true; to: string; minutes: number }
  | { sent: false; reason: "no_mail" | "send_failed" };

/**
 * Emails the operator a new one-time code, which replaces any earlier one.
 * When the instance cannot send account mail, or this send fails, it says
 * so instead; a failed send leaves the mark that lets a recent sign-in
 * stand in (consoleStepUp), so only the server's own attempt opens that
 * fallback, never a client saying the mail did not arrive.
 */
export async function sendConsoleCode(
  db: Db,
  user: { id: string; email: string },
  now: Date = new Date(),
): Promise<ConsoleCodeSend> {
  if (!accountMailDeliverable()) return { sent: false, reason: "no_mail" };
  if (sendsLimited(user.id)) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "code_limit" });
  }
  const code = String(randomInt(1_000_000)).padStart(6, "0");
  await replaceRow(
    db,
    user.id,
    { identifier: codeId(user.id), value: `${codeMac(user.id, code)}:0` },
    now,
  );
  try {
    const locale = await accountMailLocale(db, user.email, null);
    await defaultSystemMailDeps.send(
      buildConsoleCodeEmail({ to: user.email, code, minutes: CONSOLE_CODE_MINUTES, locale }),
    );
    return { sent: true, to: user.email, minutes: CONSOLE_CODE_MINUTES };
  } catch (error) {
    console.error("console code email failed to send", error);
    await replaceRow(db, user.id, { identifier: unsentId(user.id), value: "1" }, now);
    return { sent: false, reason: "send_failed" };
  }
}

/** Whether the sign-in is recent enough to stand in for a code that could not be sent. */
export function signedInRecently(session: AuthSession, now: Date = new Date()): boolean {
  const at = session.session?.createdAt;
  return at !== undefined && now.getTime() - at.getTime() <= SUPPORT_VIEW_SIGN_IN_MINUTES * 60_000;
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
        eq(v.identifier, codeId(userId)),
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
 * code, or, only when the server could not send one, a sign-in from the
 * last SUPPORT_VIEW_SIGN_IN_MINUTES. Throws the refusal the dialog explains.
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
    return;
  }
  if (accountMailDeliverable()) {
    const [unsent] = await db
      .select({ id: v.id })
      .from(v)
      .where(and(eq(v.identifier, unsentId(userId)), gt(v.expiresAt, now)))
      .limit(1);
    if (!unsent) throw refusal("code_required");
  }
  if (!signedInRecently(session, now)) throw refusal("sign_in_again");
}
