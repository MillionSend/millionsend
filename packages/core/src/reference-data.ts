import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";

/** Replaces one downloaded file. Callers store only content that parsed. */
export async function storeReferenceData(
  db: Db,
  row: { name: string; version: string; content: Buffer; now?: Date },
): Promise<void> {
  const fetchedAt = row.now ?? new Date();
  await db
    .insert(schema.referenceData)
    .values({ name: row.name, version: row.version, content: row.content, fetchedAt })
    .onConflictDoUpdate({
      target: schema.referenceData.name,
      set: { version: row.version, content: row.content, fetchedAt },
    });
}
