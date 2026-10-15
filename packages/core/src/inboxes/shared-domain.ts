import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull, lt, not, sql } from "drizzle-orm";
import { isUniqueViolation, resultRows } from "../driver-result.js";
import { errorSummary } from "../error-summary.js";
import { imitatedBrandIn } from "../imitated-brands.js";
import { slugify } from "../slug.js";
import { utcDay } from "../utc-day.js";
import { randomAlnum } from "./inbox-common.js";
import { SHARED_NAME_REFUSALS_PER_DAY, SHARED_NAME_REVIEWS_PER_DAY } from "./limits.js";

/** Characters a team name's slug keeps as its subdomain label. */
export const SHARED_LABEL_MAX = 30;
const ATTEMPTS = 5;
const RANDOM_LABEL = /^team-[a-z0-9]{6}$/;

const s = schema.sharedInboxDomains;

/**
 * An inbox has an address on the label, which locks it as locked_at does:
 * code from before migration 0054 wrote such inboxes without the stamp. A
 * label's inboxes are its team's, so this reads through inboxes' team index.
 */
const inboxOnLabel = sql`exists (select 1 from ${schema.inboxes} i where i.team_id = ${s}."team_id" and i.shared_domain_id = ${s}."id")`;

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

/** The team's subdomain of the shared inbox domain; null while its name review is pending. */
export async function teamSharedDomain(
  db: Db,
  teamId: string,
): Promise<{ id: string; name: string; createdAt: Date } | null> {
  const [row] = await db
    .select({ id: s.id, name: s.name, createdAt: s.createdAt })
    .from(s)
    .where(eq(s.teamId, teamId));
  return row ?? null;
}

/** Whether `id` names the team's subdomain row; ids may arrive uppercase, Postgres answers lowercase. */
export const isSharedDomainId = (row: { id: string } | null, id: string): boolean =>
  row !== null && row.id === id.toLowerCase();

/** The team's name, its label and whether the label is locked; undefined once the team is gone. */
async function readTeamLabel(db: Db, teamId: string) {
  const t = schema.teams;
  const [row] = await db
    .select({
      name: t.name,
      label: s.name,
      locked: sql<boolean>`(${s.lockedAt} is not null or ${inboxOnLabel})`,
    })
    .from(t)
    .leftJoin(s, eq(s.teamId, t.id))
    .where(eq(t.id, teamId));
  return row;
}

/**
 * One write of a label: the team's row, renamed in place while it is
 * unlocked, and only while the team is still named `nameRead`. False when
 * nothing was written: the team was renamed or deleted, or its label locked.
 */
async function writeLabel(
  db: Db,
  p: { teamId: string; nameRead: string; name: string },
): Promise<boolean> {
  const t = schema.teams;
  const rows = await db.execute(sql`
    insert into ${s} (team_id, name)
    select ${t.id}, ${p.name} from ${t} where ${t.id} = ${p.teamId} and ${t.name} = ${p.nameRead}
    on conflict (team_id) do update set name = excluded.name
      where ${s}."locked_at" is null and not ${inboxOnLabel}
    returning ${s}."id"`);
  return resultRows(rows).length > 0;
}

/**
 * Gives the team the subdomain label its name asks for, unless its label is
 * locked: the name as a slug once the identity review passes it, else
 * `team-<random>`, as a look-alike subdomain would lend a phisher the brand.
 * A label another team holds, or held until it was deleted, gets a random
 * suffix: a reissued label would receive mail meant for its old owner. An
 * unlocked label is renamed in place, so its id never changes and its old
 * name is free at once. A label that already is what the name asks for is
 * kept without a review, matched exactly: tolerating a suffix would read
 * `acme-corp` as `acme` plus one.
 *
 * "unavailable", writing nothing, when the review can't answer (an outage
 * or a spent budget); with `giveUp`, a team without a label takes
 * `team-<random>` instead. No transaction is held across the review.
 */
export async function settleSharedSubdomain(
  db: Db,
  p: {
    teamId: string;
    sharedInboxDomain: string;
    review: SharedNameReview | undefined;
    now: Date;
    giveUp?: boolean | undefined;
  },
): Promise<"settled" | "unavailable"> {
  const suffix = `.${p.sharedInboxDomain}`;
  const keeps = (name: string | null, base: string) => {
    const label = name?.endsWith(suffix) ? name.slice(0, -suffix.length) : null;
    return label !== null && (base ? label === base : RANDOM_LABEL.test(label));
  };
  let read = await readTeamLabel(db, p.teamId);
  if (!read || read.locked) return "settled";
  const slug = sharedSlug(read.name, SHARED_LABEL_MAX);
  let base = slug;
  if (keeps(read.label, base)) return "settled";
  if (base) {
    const refused = await reviewSharedNames(db, {
      review: p.review,
      teamId: p.teamId,
      texts: [{ field: "label", value: base }],
      now: p.now,
    });
    // The string answers are the review's outage and spent budgets; a refusal is the text refused.
    if (typeof refused === "string") {
      if (!p.giveUp || read.label !== null) return "unavailable";
      base = "";
    } else if (refused) {
      base = "";
    }
    if (!base && keeps(read.label, base)) return "settled";
  }
  let taken = false;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    // A random base is drawn whole each time: a suffix keeps whatever the guard refused in it.
    const label = !base ? `team-${randomAlnum(6)}` : taken ? `${base}-${randomAlnum(4)}` : base;
    if (refusedLabel(label)) continue;
    try {
      if (await writeLabel(db, { teamId: p.teamId, nameRead: read.name, name: label + suffix })) {
        return "settled";
      }
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      taken = true;
      continue;
    }
    // Renamed, deleted or locked since the read. A rename to another slug
    // settles its own name; one to the same slug (Acme to ACME) settles
    // nothing, so this write goes on under the new name with the same verdict.
    read = await readTeamLabel(db, p.teamId);
    if (!read || read.locked || sharedSlug(read.name, SHARED_LABEL_MAX) !== slug) return "settled";
    if (keeps(read.label, base)) return "settled";
  }
  throw new Error("no free shared inbox subdomain label");
}

/**
 * Frees the team's label unless it is locked, in the transaction that
 * deletes the team, right before its DELETE. The team row is locked before
 * the label is deleted, so a settle writing after this waits for the
 * deletion and fails its foreign key; without that lock its write could land
 * in between, and ON DELETE SET NULL would keep an unused name for good.
 */
export async function releaseSharedSubdomain(tx: Db, teamId: string): Promise<void> {
  const t = schema.teams;
  // Label row before team row, the order createInbox locks them in: the reverse deadlocks with it.
  await tx.select({ id: s.id }).from(s).where(eq(s.teamId, teamId)).for("update");
  await tx.select({ id: t.id }).from(t).where(eq(t.id, teamId)).for("update");
  await tx.delete(s).where(and(eq(s.teamId, teamId), isNull(s.lockedAt), not(inboxOnLabel)));
}

/** Teams without a subdomain label, whose name review is pending. */
export async function teamsWithoutSharedSubdomain(db: Db): Promise<string[]> {
  const t = schema.teams;
  const rows = await db
    .select({ id: t.id })
    .from(t)
    .where(sql`not exists (select 1 from ${s} l where l.team_id = ${t}."id")`);
  return rows.map((row) => row.id);
}

/** Stamps every label an inbox is on but locked_at doesn't say so; how many were stamped. */
export async function lockUsedSharedSubdomains(db: Db): Promise<number> {
  const rows = await db
    .update(s)
    .set({ lockedAt: new Date() })
    .where(and(isNull(s.lockedAt), inboxOnLabel))
    .returning({ id: s.id });
  return rows.length;
}
