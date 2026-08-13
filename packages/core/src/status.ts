import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { sql } from "drizzle-orm";
import { firstRow } from "./driver-result.js";

export type EmailStatus = (typeof schema.emailStatusEnum.enumValues)[number];

/**
 * Highest-rank-wins compare-and-set on emails.latest_status, leaning on
 * Postgres's native enum ordering (declaration order = comparison order).
 * Out-of-order SES events can never regress a status. Returns whether the
 * update applied.
 */
export async function applyStatusCas(db: Db, emailId: string, next: EmailStatus): Promise<boolean> {
  const t = schema.emails;
  const rows = await db.execute<{ id: string }>(sql`
    update ${t}
    set latest_status = ${next}
    where ${t.id} = ${emailId}
      and ${t.latestStatus} < ${next}
    returning id
  `);
  const row = firstRow<{ id: string }>(rows);
  return row !== undefined;
}
