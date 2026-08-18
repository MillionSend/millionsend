import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { asc } from "drizzle-orm";

/** The first registered user is the self-host deployment operator. */
export async function isInstanceOperator(db: Db, userId: string): Promise<boolean> {
  const [first] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .orderBy(asc(schema.user.createdAt), asc(schema.user.id))
    .limit(1);
  return first?.id === userId;
}
