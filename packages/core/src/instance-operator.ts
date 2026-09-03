import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { asc } from "drizzle-orm";

/** The first registered user is the deployment operator — the one who gets instance-wide alerts. */
export async function findInstanceOperator(
  db: Db,
): Promise<{ id: string; email: string; name: string } | null> {
  const [first] = await db
    .select({ id: schema.user.id, email: schema.user.email, name: schema.user.name })
    .from(schema.user)
    .orderBy(asc(schema.user.createdAt), asc(schema.user.id))
    .limit(1);
  return first ?? null;
}

export async function isInstanceOperator(db: Db, userId: string): Promise<boolean> {
  return (await findInstanceOperator(db))?.id === userId;
}
