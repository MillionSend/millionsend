import { env } from "@millionsend/config";
import { applyStatusCas, deriveTrackingKey, utcDay } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

/**
 * Signing key for the open/click tokens the /t/o and /t/c endpoints verify.
 * Absent MASTER_ENCRYPTION_KEY (misconfigured deploy) there is no key, so every
 * token is treated as unverifiable — the endpoints degrade to 404 / blank pixel.
 */
export function trackingKey(): Buffer | null {
  if (!env.MASTER_ENCRYPTION_KEY) return null;
  return deriveTrackingKey(Buffer.from(env.MASTER_ENCRYPTION_KEY, "base64"));
}

/**
 * Records an app-layer engagement event for a verified tracking token. The
 * teamId is read from the email row — never taken from the request — so a
 * token can only ever touch its own email's team.
 *
 * Unique per email, mirroring the old SES OPEN/CLICK path: the event row,
 * status ladder, and daily counter advance only on the FIRST open/click for
 * this email; later hits (a client prefetching the pixel, a second click) are
 * no-ops. Both endpoints are public, so a missing/foreign/non-uuid emailId
 * returns silently.
 */
export async function recordEngagement(
  db: Db,
  emailId: string,
  type: "opened" | "clicked",
): Promise<void> {
  // A raw non-uuid string must never reach a uuid column — Postgres would 500.
  if (!z.uuid().safeParse(emailId).success) return;

  const [email] = await db
    .select({ id: schema.emails.id, teamId: schema.emails.teamId })
    .from(schema.emails)
    .where(eq(schema.emails.id, emailId))
    .limit(1);
  if (!email) return;

  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [prior] = await tx
      .select({ id: schema.emailEvents.id })
      .from(schema.emailEvents)
      .where(and(eq(schema.emailEvents.emailId, email.id), eq(schema.emailEvents.type, type)))
      .limit(1);
    // ponytail: two concurrent identical hits could both miss `prior` and
    // double-count — same race the SES path carries. A slightly-high
    // engagement counter is not a correctness/security concern; add a
    // (email_id, type) unique index if it ever matters.
    if (prior) return;

    await tx.insert(schema.emailEvents).values({ emailId: email.id, type, occurredAt: new Date() });
    await applyStatusCas(tx, email.id, type);
    await tx.execute(sql`
      insert into ${schema.usageCounters} (team_id, day, ${sql.raw(type)})
      values (${email.teamId}, ${utcDay(new Date())}, 1)
      on conflict (team_id, day) do update
        set ${sql.raw(type)} = ${schema.usageCounters}.${sql.raw(type)} + 1
    `);
  });
}
