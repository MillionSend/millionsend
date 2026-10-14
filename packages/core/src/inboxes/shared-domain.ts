import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, lt, sql } from "drizzle-orm";
import { errorSummary } from "../error-summary.js";
import { imitatedBrandIn } from "../imitated-brands.js";
import { slugify } from "../slug.js";
import { utcDay } from "../utc-day.js";
import { randomAlnum } from "./inbox-common.js";
import { SHARED_NAME_REFUSALS_PER_DAY, SHARED_NAME_REVIEWS_PER_DAY } from "./limits.js";

const LABEL_MAX = 30;
const ATTEMPTS = 5;

/** Local parts at the shared domain, or any name under it, that reach the operator, never a team. */
export const SHARED_ROLE_LOCAL_PARTS = ["postmaster", "abuse"] as const;

/** Usernames no team may choose on the shared domain. */
export const RESERVED_SHARED_USERNAMES = [
  ...SHARED_ROLE_LOCAL_PARTS,
  "admin",
  "security",
  "support",
  "noreply",
  "no-reply",
  "billing",
  "hostmaster",
  "webmaster",
  "mailer-daemon",
  "root",
] as const;

/** Team subdomain labels never issued: the reserved usernames, mail service names and `team`. */
export const RESERVED_SHARED_LABELS = [
  ...RESERVED_SHARED_USERNAMES,
  "www",
  "mail",
  "mx",
  "smtp",
  "imap",
  "pop",
  "autodiscover",
  "autoconfig",
  "team",
  "send",
  "bounce",
] as const;

/**
 * Whether `value` is one of `reserved` (the usernames unless told
 * otherwise), ignoring case and the `.`, `_` and `-` separators, so
 * "No.Reply" and "post-master" count too.
 */
export function reservedSharedName(
  value: string,
  reserved: readonly string[] = RESERVED_SHARED_USERNAMES,
): boolean {
  const bare = (text: string) => text.toLowerCase().replace(/[._-]/g, "");
  return reserved.some((name) => bare(name) === bare(value));
}

/** One name a team would publish on the shared domain, as the identity review reads it. */
export interface SharedNameText {
  field: "username" | "from_name" | "label";
  value: string;
}

/**
 * The identity review of names a team publishes on the shared domain.
 * `refused` holds the `value` of each text refused; the promise rejects when
 * the review can't answer.
 */
export type SharedNameReview = (texts: SharedNameText[]) => Promise<{ refused: string[] }>;

/**
 * The first text the identity review refuses, or null when it passes them
 * all or no review is configured. Without asking: "refusals_spent" once the
 * team's refusals today reach SHARED_NAME_REFUSALS_PER_DAY, "reviews_spent"
 * once its reviews reach SHARED_NAME_REVIEWS_PER_DAY. "unavailable" when the
 * review can't answer. Each review is reserved before it asks and kept
 * whatever the answer, so a failing or throttled judge still spends it;
 * refusals are counted after the answer, not reserved, so concurrent reviews
 * can pass that budget by a few.
 */
export async function reviewSharedNames(
  db: Db,
  p: {
    review: SharedNameReview | undefined;
    teamId: string;
    texts: SharedNameText[];
    now: Date;
  },
): Promise<SharedNameText | null | "refusals_spent" | "reviews_spent" | "unavailable"> {
  if (!p.review || p.texts.length === 0) return null;
  const c = schema.usageCounters;
  const day = utcDay(p.now);
  const [today] = await db
    .select({ refusals: c.sharedNameRefusals })
    .from(c)
    .where(and(eq(c.teamId, p.teamId), eq(c.day, day)));
  if ((today?.refusals ?? 0) >= SHARED_NAME_REFUSALS_PER_DAY) return "refusals_spent";
  const [reserved] = await db
    .insert(c)
    .values({ teamId: p.teamId, day, sharedNameReviews: 1 })
    .onConflictDoUpdate({
      target: [c.teamId, c.day],
      set: { sharedNameReviews: sql`${c.sharedNameReviews} + 1` },
      setWhere: lt(c.sharedNameReviews, SHARED_NAME_REVIEWS_PER_DAY),
    })
    .returning({ teamId: c.teamId });
  if (!reserved) return "reviews_spent";
  let refused: string[];
  try {
    ({ refused } = await p.review(p.texts));
  } catch (err) {
    console.warn(`shared name review unavailable for team ${p.teamId}: ${errorSummary(err)}`);
    return "unavailable";
  }
  const hits = p.texts.filter((text) => refused.includes(text.value));
  if (hits.length > 0) {
    await db
      .insert(c)
      .values({ teamId: p.teamId, day, sharedNameRefusals: hits.length })
      .onConflictDoUpdate({
        target: [c.teamId, c.day],
        set: { sharedNameRefusals: sql`${c.sharedNameRefusals} + ${hits.length}` },
      });
  }
  return hits[0] ?? null;
}

/** Whether a label imitates a brand or is reserved, so it is never issued. */
export const refusedLabel = (label: string): boolean =>
  imitatedBrandIn(label) !== null || reservedSharedName(label, RESERVED_SHARED_LABELS);

/**
 * Text as a subdomain label: slugified, cut to `max` and trimmed, or "" when
 * the text or the label left after the cut imitates a brand (a cut can carve
 * one out of a longer word), or when the label is reserved.
 */
export function sharedSlug(text: string, max: number): string {
  const slug = slugify(text).slice(0, max).replace(/-+$/, "");
  return imitatedBrandIn(text) !== null || refusedLabel(slug) ? "" : slug;
}

/**
 * The team's subdomain of the shared inbox domain, created on first use:
 * the team name as a slug once the identity review passes it, else
 * `team-<random>`: a look-alike subdomain would lend a phisher the brand.
 * The review never holds creation up: a refusal, an outage or a spent
 * budget all mean the random label. A label another team holds, or held
 * until it was deleted, gets a random suffix, so no label is ever issued
 * twice: a new owner would receive mail meant for the old one.
 */
export async function ensureSharedSubdomain(
  db: Db,
  p: {
    teamId: string;
    teamName: string;
    sharedInboxDomain: string;
    review?: SharedNameReview | undefined;
    now?: Date | undefined;
  },
): Promise<{ id: string; name: string }> {
  const s = schema.sharedInboxDomains;
  const existing = async () =>
    (await db.select({ id: s.id, name: s.name }).from(s).where(eq(s.teamId, p.teamId)))[0];
  const found = await existing();
  if (found) return found;
  let base = sharedSlug(p.teamName, LABEL_MAX);
  if (base) {
    const refused = await reviewSharedNames(db, {
      review: p.review,
      teamId: p.teamId,
      texts: [{ field: "label", value: base }],
      now: p.now ?? new Date(),
    });
    if (refused !== null) base = "";
  }
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    // A random base is drawn whole each time: a suffix keeps whatever the guard refused in it.
    const label = !base
      ? `team-${randomAlnum(6)}`
      : attempt === 0
        ? base
        : `${base}-${randomAlnum(4)}`;
    if (refusedLabel(label)) continue;
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
