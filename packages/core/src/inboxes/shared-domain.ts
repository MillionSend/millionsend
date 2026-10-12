import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { imitatedBrandIn } from "../imitated-brands.js";
import { slugify } from "../slug.js";
import { randomAlnum } from "./inbox-common.js";

const LABEL_MAX = 30;
const ATTEMPTS = 5;

/**
 * The team's subdomain of the shared inbox domain, created on first use:
 * the team name as a slug, or `team-<random>` when the name imitates a
 * brand (a look-alike subdomain would lend a phisher the brand). A label
 * another team holds gets a random suffix.
 */
export async function ensureSharedSubdomain(
  db: Db,
  p: { teamId: string; teamName: string; sharedInboxDomain: string },
): Promise<{ id: string; name: string }> {
  const s = schema.sharedInboxDomains;
  const existing = async () =>
    (await db.select({ id: s.id, name: s.name }).from(s).where(eq(s.teamId, p.teamId)))[0];
  const found = await existing();
  if (found) return found;
  const base = imitatedBrandIn(p.teamName)
    ? `team-${randomAlnum(6)}`
    : slugify(p.teamName).slice(0, LABEL_MAX).replace(/-+$/, "") || "team";
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const label = attempt === 0 ? base : `${base}-${randomAlnum(4)}`;
    const [row] = await db
      .insert(s)
      .values({ teamId: p.teamId, name: `${label}.${p.sharedInboxDomain}` })
      .onConflictDoNothing()
      .returning({ id: s.id, name: s.name });
    if (row) return row;
    // The conflict was this team's own row, written by a concurrent call.
    const raced = await existing();
    if (raced) return raced;
  }
  throw new Error("no free shared inbox subdomain label");
}
