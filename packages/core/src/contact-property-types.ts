import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import type { ContactPropertyType } from "./contact-properties.js";

/** A team's property types by lower(key): the definitions' unique index is
 * case-insensitive, and contact map keys are matched the same way. */
export type ContactPropertyTypes = Map<string, ContactPropertyType>;

export async function loadContactPropertyTypes(
  db: Db,
  teamId: string,
): Promise<ContactPropertyTypes> {
  const p = schema.contactProperties;
  const rows = await db.select({ key: p.key, type: p.type }).from(p).where(eq(p.teamId, teamId));
  return new Map(rows.map((r) => [r.key.toLowerCase(), r.type]));
}
