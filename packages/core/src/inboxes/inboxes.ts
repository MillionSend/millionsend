import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  max,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { recordAudit } from "../audit.js";
import { isPlainName } from "../customer-text.js";
import { imitatedBrandIn } from "../imitated-brands.js";
import { asciiHostname } from "../org-domain.js";
import type { Plan } from "../plans.js";
import { teamMemberEmails } from "../receiving/inbox-routing.js";
import { DAY_MS } from "../utc-day.js";
import type { WebhookEnqueue } from "../webhooks.js";
import { type InboxActor, recordInboxActivity, webhookSource } from "./activity.js";
import { inboxDeletedEvent, inboxEvent } from "./events.js";
import {
  auditActorOf,
  INBOX_NOT_FOUND,
  invalid,
  isInboxError,
  keysetRows,
  oneLineName,
  randomAlnum,
  webhookBatch,
} from "./inbox-common.js";
import {
  expiresInMs,
  findLiveInbox,
  INBOX_MAX_TTL,
  inboxCreatesLeft,
  inboxRoom,
  liveInbox,
  SHARED_INBOX_IDLE_TTL,
} from "./limits.js";
import { defaultSafety, type InboxSafety, inboxSafetySchema, safetyProblem } from "./safety.js";
import { teamInNewTier, teamSharedSending } from "./send.js";
import { secondsToNextUtcDay } from "./send-policy.js";
import {
  ensureSharedSubdomain,
  reservedSharedName,
  reviewSharedNames,
  type SharedNameReview,
  type SharedNameText,
} from "./shared-domain.js";
import {
  INBOX_KINDS,
  type InboxError,
  type InboxKind,
  type InboxListItemWire,
  type InboxWire,
  type ListQuery,
} from "./types.js";
import { INBOX_NAME_MAX, SHARED_USERNAME } from "./username.js";
import { type InboxCounts, inboxListItemWire, inboxWire } from "./wire.js";

export interface InboxDeps {
  sharedInboxDomain: string | null;
  receivingEnabled: boolean;
  enqueueWebhookDeliveries?: WebhookEnqueue | undefined;
  /**
   * The identity review of names published on the shared domain; absent
   * when no judge is configured, which leaves the deterministic guards to
   * decide alone.
   */
  judgeSharedNames?: SharedNameReview | undefined;
}

export interface CreateInboxInput {
  email_address?: string | undefined;
  /** The local part of a shared-domain address, asked for instead of email_address. */
  username?: string | undefined;
  name?: string | undefined;
  from_name?: string | undefined;
  forwarding?: boolean | undefined;
  kind?: InboxKind | undefined;
  expires_in?: string | null | undefined;
  safety?: Partial<InboxSafety> | undefined;
}

type InboxRow = typeof schema.inboxes.$inferSelect;
type Failure = { ok: false; error: InboxError };

const fail = (error: InboxError): Failure => ({ ok: false, error });

/** Resend's text for the plan cap, with its 403 validation_error. */
const PLAN_LIMIT: InboxError = {
  status: 403,
  name: "validation_error",
  message: "You have reached the inbox limit of your plan. Upgrade to add more.",
};

const OUTSIDE_KEY_DOMAIN: InboxError = {
  status: 403,
  name: "restricted_api_key",
  message: "This API key can only create inboxes on its assigned domain",
};

const SHORTEN_NEEDS_ADMIN: InboxError = {
  status: 403,
  name: "forbidden",
  message: "Only owners and admins can make an inbox expire sooner; you can extend it",
};

const ADDRESS_TAKEN: InboxError = {
  status: 409,
  name: "validation_error",
  message: "This address is already used by an inbox",
};

const NAME_REVIEW_UNAVAILABLE: InboxError = {
  status: 503,
  name: "name_review_unavailable",
  message:
    "This name couldn't be reviewed right now: try again shortly, or leave username out for a random address",
  retryAfterSec: 60,
};

/** Generated addresses retried on collision before giving up. */
const ADDRESS_ATTEMPTS = 5;
const EXPIRE_BATCH = 1000;
const LOCAL_PART = /^[a-z0-9._%+-]{1,64}$/;

/** Resend's from_name limit. */
const FROM_NAME_MAX = 78;

/** The 422 for a name the shared domain won't carry; why is never said. */
const refusedOnShared = (field: string): InboxError =>
  invalid(`${field} can't be used on the shared domain: pick another`);

/**
 * The display name recipients see: a plain name as team and display names
 * are everywhere (no "@", links or phone numbers), and nothing that would
 * read as From header structure. "" removes it. On the shared domain it may
 * not imitate a brand either.
 */
function fromNameOf(value: string, shared: boolean): string | null | InboxError {
  const name = value.trim();
  if (name === "") return null;
  if (!isPlainName(name, FROM_NAME_MAX) || /[:<>]/.test(name)) {
    return invalid(
      `from_name must be a plain name of at most ${FROM_NAME_MAX} characters, without @ : < >, line breaks, links or phone numbers`,
    );
  }
  return shared && imitatedBrandIn(name, { everydayWords: false })
    ? refusedOnShared("from_name")
    : name;
}

/**
 * A chosen username on the shared domain, trimmed and lowercased, or the
 * 422 that refuses it (SHARED_USERNAME). `fwd-` is the shape of forwarding
 * inboxes' receiving addresses.
 */
function usernameOf(value: string, shared: boolean): string | InboxError {
  if (!shared) return invalid("Send username or email_address, not both");
  const username = value.trim().toLowerCase();
  if (!SHARED_USERNAME.test(username)) {
    return invalid(
      "username must be 1-64 letters, digits and . _ - that start and end with a letter or digit, without two dots in a row",
    );
  }
  return username.startsWith("fwd-") ||
    reservedSharedName(username) ||
    imitatedBrandIn(username, { everydayWords: false })
    ? refusedOnShared("username")
    : username;
}

/** When an inbox created or renewed now expires: never (null) unless expires_in says otherwise. */
function expiryOf(
  value: string | null | undefined,
  now: Date,
): { expiresAt: Date | null } | InboxError {
  if (value === undefined || value === null) return { expiresAt: null };
  const ms = expiresInMs(value);
  if (ms === null) return invalid('expires_in must be hours or days, like "24h" or "7d"');
  if (ms > INBOX_MAX_TTL) return invalid(`expires_in can be at most ${INBOX_MAX_TTL / DAY_MS}d`);
  return { expiresAt: new Date(now.getTime() + ms) };
}

/** The refusal the identity review gives names on the shared domain, or null when it passes them. */
async function reviewRefusal(
  db: Db,
  deps: InboxDeps,
  p: { teamId: string; texts: SharedNameText[]; now: Date },
): Promise<InboxError | null> {
  const refused = await reviewSharedNames(db, { review: deps.judgeSharedNames, ...p });
  if (refused === "unavailable") return NAME_REVIEW_UNAVAILABLE;
  if (refused === "refusals_spent" || refused === "reviews_spent") {
    return {
      status: 429,
      name: "rate_limit_exceeded",
      message: `Too many names were ${refused === "refusals_spent" ? "refused" : "reviewed"} today: try again tomorrow, or leave username out for a random address`,
      retryAfterSec: secondsToNextUtcDay(p.now),
    };
  }
  return refused ? refusedOnShared(refused.field) : null;
}

/** A complete safety object for this inbox, or the 422 that refuses it. `plan` is the effective plan. */
async function checkedSafety(
  db: Db,
  p: {
    teamId: string;
    kind: InboxKind;
    shared: boolean;
    safety: InboxSafety;
    plan: Plan;
    isCloud: boolean;
    now: Date;
  },
): Promise<InboxSafety | InboxError> {
  const parsed = inboxSafetySchema.safeParse(p.safety);
  if (!parsed.success) {
    return invalid(
      parsed.error.issues.map((i) => `safety.${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  const safety = parsed.data;
  const open = safety.send_policy === "open";
  const problem = safetyProblem(safety, {
    kind: p.kind,
    shared: p.shared,
    teamTierNew: open && (await teamInNewTier(db, p.teamId, p.now)),
    memberEmails: safety.forward_to.length > 0 ? await teamMemberEmails(db, p.teamId) : [],
    sharedSending: p.shared && open ? await teamSharedSending(db, p, p.plan) : undefined,
  });
  return problem === null ? safety : invalid(problem);
}

/** Only the keys a partial safety object sets, so an absent key never overwrites one. */
const setKeys = (patch: Partial<InboxSafety>): Partial<InboxSafety> =>
  Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));

const ZERO_COUNTS: InboxCounts = {
  unread: 0,
  drafts: 0,
  quarantined: 0,
  pendingApproval: 0,
  lastReceived: null,
};

/** The read and attention counts of several inboxes at once. */
async function countsFor(db: Db, inboxIds: string[]): Promise<Map<string, InboxCounts>> {
  const out = new Map(inboxIds.map((id) => [id, { ...ZERO_COUNTS }]));
  if (inboxIds.length === 0) return out;
  const m = schema.receivedEmailInboxes;
  const t = schema.inboxThreads;
  const d = schema.inboxDrafts;
  const [unread, drafts, held, last] = await Promise.all([
    // Unread threads, spam and trash aside: what needs reading.
    db
      .select({ inboxId: m.inboxId, n: sql<number>`count(distinct ${m.threadId})::int` })
      .from(m)
      .innerJoin(t, eq(t.id, m.threadId))
      .where(
        and(
          inArray(m.inboxId, inboxIds),
          sql`${m.readAt} is null and ${m.deliveredAt} is not null`,
          notInArray(t.folder, ["spam", "trash"]),
        ),
      )
      .groupBy(m.inboxId),
    db
      .select({
        inboxId: d.inboxId,
        unsent: count(),
        pending: sql<number>`count(*) filter (where ${d.status} = 'pending_approval')::int`,
      })
      .from(d)
      .where(and(inArray(d.inboxId, inboxIds), inArray(d.status, ["draft", "pending_approval"])))
      .groupBy(d.inboxId),
    db
      .select({ inboxId: m.inboxId, n: count() })
      .from(m)
      .where(
        and(
          inArray(m.inboxId, inboxIds),
          sql`${m.quarantinedAt} is not null and ${m.releasedAt} is null`,
        ),
      )
      .groupBy(m.inboxId),
    db
      .select({ inboxId: t.inboxId, at: max(t.lastMessageAt) })
      .from(t)
      .where(inArray(t.inboxId, inboxIds))
      .groupBy(t.inboxId),
  ]);
  const of = (id: string) => out.get(id) as InboxCounts;
  for (const r of unread) of(r.inboxId).unread = r.n;
  for (const r of drafts) {
    of(r.inboxId).drafts = r.unsent;
    of(r.inboxId).pendingApproval = r.pending;
  }
  for (const r of held) of(r.inboxId).quarantined = r.n;
  for (const r of last) of(r.inboxId).lastReceived = r.at ? new Date(r.at) : null;
  return out;
}

async function wireOf(db: Db, row: InboxRow): Promise<InboxWire> {
  return inboxWire(row, (await countsFor(db, [row.id])).get(row.id) ?? ZERO_COUNTS);
}

/** Where a new inbox's address lives, resolved from the request. */
type AddressPlan =
  | { shared: true; sub: { id: string; name: string }; username: string | undefined }
  | {
      shared: false;
      emailAddress: string;
      localPart: string;
      domainId: string;
      /** The shared subdomain a forwarding inbox's receiving_address sits on. */
      forwardingSub: { id: string; name: string } | null;
    };

async function addressPlan(
  db: Db,
  deps: InboxDeps,
  p: {
    teamId: string;
    teamName: string;
    input: CreateInboxInput;
    username: string | undefined;
    fromName: string | null;
    now: Date;
  },
): Promise<AddressPlan | InboxError> {
  const { input } = p;
  const shared = deps.sharedInboxDomain;
  if (input.email_address === undefined) {
    if (input.forwarding) {
      return invalid("forwarding needs email_address: an address on one of your domains");
    }
    if (!shared) {
      return invalid("email_address is required: this instance has no shared inbox domain");
    }
    const texts: SharedNameText[] = [];
    if (p.username !== undefined) texts.push({ field: "username", value: p.username });
    if (p.fromName !== null) texts.push({ field: "from_name", value: p.fromName });
    const refused = await reviewRefusal(db, deps, { teamId: p.teamId, texts, now: p.now });
    if (refused) return refused;
    const sub = await ensureSharedSubdomain(db, {
      teamId: p.teamId,
      teamName: p.teamName,
      sharedInboxDomain: shared,
      review: deps.judgeSharedNames,
      now: p.now,
    });
    return { shared: true, sub, username: p.username };
  }
  const address = input.email_address.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  const localPart = address.slice(0, at);
  const domain = at > 0 ? asciiHostname(address.slice(at + 1)) : null;
  if (
    domain === null ||
    !LOCAL_PART.test(localPart) ||
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..")
  ) {
    return invalid(
      "email_address must be an address like support@example.com: a local part of at most 64 letters, digits and . _ % + - with no leading, trailing or double dot",
    );
  }
  if (shared && (domain === shared || domain.endsWith(`.${shared}`))) {
    return invalid(
      "Addresses on the shared domain take a username: leave email_address out and set username",
    );
  }
  const d = schema.domains;
  const [row] = await db
    .select({ id: d.id, receivingEnabled: d.receivingEnabled })
    .from(d)
    .where(and(eq(d.teamId, p.teamId), eq(d.name, domain), eq(d.status, "verified")));
  if (!row) return invalid("email_address must be on a verified domain of this team");
  if (!input.forwarding && !row.receivingEnabled) {
    return invalid(
      `Turn on receiving for ${domain} first, or create the inbox with forwarding: true`,
    );
  }
  let forwardingSub: { id: string; name: string } | null = null;
  if (input.forwarding) {
    if (!shared) {
      return invalid("forwarding needs a shared inbox domain, which this instance does not have");
    }
    forwardingSub = await ensureSharedSubdomain(db, {
      teamId: p.teamId,
      teamName: p.teamName,
      sharedInboxDomain: shared,
      review: deps.judgeSharedNames,
      now: p.now,
    });
  }
  return {
    shared: false,
    emailAddress: `${localPart}@${domain}`,
    localPart,
    domainId: row.id,
    forwardingSub,
  };
}

export async function createInbox(
  db: Db,
  deps: InboxDeps,
  p: {
    teamId: string;
    teamName: string;
    plan: Plan;
    isCloud: boolean;
    actor: InboxActor;
    input: CreateInboxInput;
    /** A domain-scoped key creates inboxes on its own domain only. */
    onlyDomainId?: string | null | undefined;
    now?: Date | undefined;
  },
): Promise<{ ok: true; inbox: InboxWire } | { ok: false; error: InboxError }> {
  const now = p.now ?? new Date();
  const { input } = p;
  if (!deps.receivingEnabled) return fail(invalid("This instance does not receive mail"));
  const kind = input.kind ?? "agent";
  if (!INBOX_KINDS.includes(kind)) return fail(invalid("kind must be agent or human"));
  const name = input.name === undefined ? undefined : oneLineName(input.name, INBOX_NAME_MAX);
  if (isInboxError(name)) return fail(name);
  const shared = input.email_address === undefined;
  const fromName = input.from_name === undefined ? null : fromNameOf(input.from_name, shared);
  if (isInboxError(fromName)) return fail(fromName);
  const username = input.username === undefined ? undefined : usernameOf(input.username, shared);
  if (isInboxError(username)) return fail(username);
  const expiry = expiryOf(input.expires_in, now);
  if (isInboxError(expiry)) return fail(expiry);

  if ((await inboxRoom(db, p.teamId, p.plan, p.isCloud, now)) === 0) return fail(PLAN_LIMIT);
  const creates = await inboxCreatesLeft(db, p.teamId, p.plan, p.isCloud, now);
  if (creates?.left === 0) {
    return fail({
      status: 429,
      name: "rate_limit_exceeded",
      message: "Too many inboxes created in the last hour. Try again later.",
      retryAfterSec: creates.retryAfterSec,
    });
  }

  if (p.onlyDomainId && shared) return fail(OUTSIDE_KEY_DOMAIN);
  const plan = await addressPlan(db, deps, { ...p, username, fromName, now });
  if (isInboxError(plan)) return fail(plan);
  if (p.onlyDomainId && (plan.shared || plan.domainId !== p.onlyDomainId)) {
    return fail(OUTSIDE_KEY_DOMAIN);
  }
  const defaults = defaultSafety(kind, plan.shared);
  const requested = setKeys(input.safety ?? {});
  // A new team may not send openly yet, so its default steps down to what it may use.
  if (
    defaults.send_policy === "open" &&
    requested.send_policy === undefined &&
    (await teamInNewTier(db, p.teamId, now))
  ) {
    defaults.send_policy = "allowlist";
  }
  const safety = await checkedSafety(db, {
    teamId: p.teamId,
    kind,
    shared: plan.shared,
    safety: { ...defaults, ...requested },
    plan: p.plan,
    isCloud: p.isCloud,
    now,
  });
  if (isInboxError(safety)) return fail(safety);

  const i = schema.inboxes;
  const hooks = webhookBatch(deps.enqueueWebhookDeliveries);
  const row = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    for (let attempt = 0; attempt < ADDRESS_ATTEMPTS; attempt += 1) {
      const localPart = plan.shared ? (plan.username ?? `inbox-${randomAlnum(8)}`) : plan.localPart;
      // A random draw can spell a brand look-alike, which the send rules would hold back.
      if (
        plan.shared &&
        plan.username === undefined &&
        imitatedBrandIn(localPart, { everydayWords: false })
      ) {
        continue;
      }
      const emailAddress = plan.shared ? `${localPart}@${plan.sub.name}` : plan.emailAddress;
      const [inserted] = await t
        .insert(i)
        .values({
          teamId: p.teamId,
          kind,
          emailAddress,
          localPart,
          domainId: plan.shared ? null : plan.domainId,
          sharedDomainId: plan.shared ? plan.sub.id : (plan.forwardingSub?.id ?? null),
          receivingAddress:
            !plan.shared && plan.forwardingSub
              ? `fwd-${randomAlnum(16)}@${plan.forwardingSub.name}`
              : null,
          name: name ?? emailAddress,
          fromName,
          safety,
          expiresAt: expiry.expiresAt,
          lastUsedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) {
        await recordInboxActivity(t, {
          teamId: p.teamId,
          inboxId: inserted.id,
          actor: p.actor,
          action: "inbox.created",
        });
        await hooks.emit(t, p.teamId, [
          inboxEvent("inbox.created", {
            source: webhookSource(p.actor),
            inbox: inboxWire(inserted, ZERO_COUNTS),
            occurredAt: now,
          }),
        ]);
        return inserted;
      }
      // A chosen address collides only with its own; a generated one is drawn again.
      if (!plan.shared || plan.username !== undefined) {
        const [taken] = await t
          .select({ id: i.id })
          .from(i)
          .where(eq(i.emailAddress, emailAddress));
        if (taken) return null;
      }
    }
    throw new Error("no free inbox address after several draws");
  });
  if (!row) return fail(ADDRESS_TAKEN);
  await hooks.flush();
  if (p.actor.kind === "user") {
    await recordAudit(db, {
      teamId: p.teamId,
      actor: { userId: p.actor.userId },
      action: "inbox.created",
      target: { type: "inbox", id: row.id },
      metadata: { email_address: row.emailAddress, kind: row.kind },
    });
  }
  return { ok: true, inbox: inboxWire(row, ZERO_COUNTS) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** By id or, when the value holds an "@", by address (case-insensitive). */
export async function getInbox(
  db: Db,
  p: {
    teamId: string;
    idOrEmail: string;
    onlyInboxId?: string | null | undefined;
    now?: Date | undefined;
  },
): Promise<InboxWire | null> {
  const i = schema.inboxes;
  const byAddress = p.idOrEmail.includes("@");
  if (!byAddress && !UUID.test(p.idOrEmail)) return null;
  const [row] = await db
    .select()
    .from(i)
    .where(
      and(
        byAddress
          ? eq(i.emailAddress, p.idOrEmail.trim().toLowerCase())
          : eq(i.id, p.idOrEmail.toLowerCase()),
        eq(i.teamId, p.teamId),
        p.onlyInboxId ? eq(i.id, p.onlyInboxId) : undefined,
        liveInbox(p.now ?? new Date()),
      ),
    );
  return row ? wireOf(db, row) : null;
}

/** Newest first, as Resend lists inboxes; `after` pages toward older ones. */
export async function listInboxes(
  db: Db,
  p: {
    teamId: string;
    query: ListQuery;
    kind?: InboxKind | undefined;
    onlyInboxId?: string | null | undefined;
    /** A domain-scoped key's domain: shared-domain inboxes are on none. */
    onlyDomainId?: string | null | undefined;
    now?: Date | undefined;
  },
): Promise<{ data: InboxListItemWire[]; hasMore: boolean } | "bad_cursor"> {
  const i = schema.inboxes;
  const scope = and(
    eq(i.teamId, p.teamId),
    liveInbox(p.now ?? new Date()),
    p.kind ? eq(i.kind, p.kind) : undefined,
    p.onlyInboxId ? eq(i.id, p.onlyInboxId) : undefined,
    p.onlyDomainId ? eq(i.domainId, p.onlyDomainId) : undefined,
  );
  const page = await keysetRows({
    query: p.query,
    key: i.createdAt,
    id: i.id,
    newestFirst: true,
    cursorExists: async (id) =>
      (
        await db
          .select({ id: i.id })
          .from(i)
          .where(and(eq(i.id, id), scope))
      ).length > 0,
    cursorKey: (id) => sql`(select ${i.createdAt} from ${i} where ${i.id} = ${id}::uuid)`,
    load: (where, orderBy, take) =>
      db
        .select()
        .from(i)
        .where(and(scope, where))
        .orderBy(...orderBy)
        .limit(take),
  });
  if (page === "bad_cursor") return page;
  const counts = await countsFor(
    db,
    page.rows.map((r) => r.id),
  );
  return {
    data: page.rows.map((r) => inboxListItemWire(r, counts.get(r.id) ?? ZERO_COUNTS)),
    hasMore: page.hasMore,
  };
}

export async function updateInbox(
  db: Db,
  deps: InboxDeps,
  p: {
    teamId: string;
    inboxId: string;
    actor: InboxActor;
    patch: {
      name?: string | undefined;
      from_name?: string | undefined;
      expires_in?: string | null | undefined;
    };
    /** Owners, admins and full-access keys: an earlier expiry deletes the inbox sooner, as a delete would. */
    mayShorten: boolean;
  },
): Promise<{ ok: true; inbox: InboxWire } | { ok: false; error: InboxError }> {
  const now = new Date();
  const inbox = await findLiveInbox(db, { teamId: p.teamId, inboxId: p.inboxId, now: now });
  if (!inbox) return fail(INBOX_NOT_FOUND);
  const shared = inbox.domainId === null;
  const set: Partial<typeof schema.inboxes.$inferInsert> = { updatedAt: now };
  if (p.patch.name !== undefined) {
    const name = oneLineName(p.patch.name, INBOX_NAME_MAX);
    if (isInboxError(name)) return fail(name);
    set.name = name;
  }
  if (p.patch.from_name !== undefined) {
    const fromName = fromNameOf(p.patch.from_name, shared);
    if (isInboxError(fromName)) return fail(fromName);
    set.fromName = fromName;
  }
  if (p.patch.expires_in !== undefined) {
    const expiry = expiryOf(p.patch.expires_in, now);
    if (isInboxError(expiry)) return fail(expiry);
    const earlier =
      expiry.expiresAt !== null && (inbox.expiresAt === null || expiry.expiresAt < inbox.expiresAt);
    if (earlier && !p.mayShorten) return fail(SHORTEN_NEEDS_ADMIN);
    set.expiresAt = expiry.expiresAt;
  }
  // Repeating the stored from_name publishes nothing new, so it isn't reviewed again.
  if (shared && set.fromName && set.fromName !== inbox.fromName) {
    const refused = await reviewRefusal(db, deps, {
      teamId: p.teamId,
      texts: [{ field: "from_name", value: set.fromName }],
      now,
    });
    if (refused) return fail(refused);
  }
  const i = schema.inboxes;
  const hooks = webhookBatch(deps.enqueueWebhookDeliveries);
  const wire = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [row] = await t.update(i).set(set).where(eq(i.id, inbox.id)).returning();
    if (!row) throw new Error("inbox update returned no row");
    await recordInboxActivity(t, {
      teamId: p.teamId,
      inboxId: row.id,
      actor: p.actor,
      action: "inbox.updated",
    });
    const updated = await wireOf(t, row);
    await hooks.emit(t, p.teamId, [
      inboxEvent("inbox.updated", { source: webhookSource(p.actor), inbox: updated }),
    ]);
    return updated;
  });
  await hooks.flush();
  return { ok: true, inbox: wire };
}

/** Inboxes past expires_at, and shared-domain ones unused for SHARED_INBOX_IDLE_TTL. */
const sweepable = (now: Date) => {
  const i = schema.inboxes;
  return or(
    lte(i.expiresAt, now),
    and(isNull(i.domainId), lt(i.lastUsedAt, new Date(now.getTime() - SHARED_INBOX_IDLE_TTL))),
  );
};

/**
 * Deletes inboxes with their threads, drafts, labels and memberships, and
 * the received messages only they held (catch-all mail stays in All
 * received). Their scoped keys are revoked first, never widened.
 */
export async function deleteInboxes(
  db: Db,
  deps: InboxDeps,
  p: {
    teamId: string;
    inboxIds: string[];
    actor: InboxActor;
    reason: "deleted" | "expired" | "domain_deleted";
    /**
     * The sweep's clock. An inbox goes as expired only if it still is under
     * its row lock, so one used since the sweep read it stays.
     */
    now?: Date | undefined;
  },
): Promise<number> {
  if (p.inboxIds.length === 0) return 0;
  const i = schema.inboxes;
  const k = schema.apiKeys;
  const m = schema.receivedEmailInboxes;
  const r = schema.receivedEmails;
  const w = schema.webhookEndpoints;
  const source = webhookSource(p.actor);
  const hooks = webhookBatch(deps.enqueueWebhookDeliveries);
  const deleted = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const rows = await t
      .select()
      .from(i)
      .where(
        and(
          eq(i.teamId, p.teamId),
          inArray(i.id, p.inboxIds),
          p.reason === "expired" ? sweepable(p.now ?? new Date()) : undefined,
        ),
      )
      .for("update");
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const counts = p.reason === "expired" ? await countsFor(t, ids) : null;
    // SECURITY: inbox_id is never set null on a live key: that would widen it to the team.
    await t
      .update(k)
      .set({ revokedAt: sql`coalesce(${k.revokedAt}, now())`, inboxId: null })
      .where(inArray(k.inboxId, ids));
    await t
      .delete(r)
      .where(
        and(
          eq(r.teamId, p.teamId),
          eq(r.catchAll, false),
          inArray(r.id, t.select({ id: m.receivedEmailId }).from(m).where(inArray(m.inboxId, ids))),
          sql`not exists (select 1 from ${m} where ${m.receivedEmailId} = ${r.id} and ${notInArray(m.inboxId, ids)})`,
        ),
      );
    // Emitted while endpoints still name these inboxes, so filtered ones hear of it.
    await hooks.emit(
      t,
      p.teamId,
      rows.flatMap((row) => [
        ...(counts
          ? [
              inboxEvent("inbox.expired", {
                source,
                inbox: inboxWire(row, counts.get(row.id) ?? ZERO_COUNTS),
              }),
            ]
          : []),
        inboxDeletedEvent({ source, inboxId: row.id }),
      ]),
    );
    await t.delete(i).where(inArray(i.id, ids));
    // An endpoint left filtered to no inbox hears of none, rather than of every one.
    const gone = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
    await t
      .update(w)
      .set({
        inboxIds: sql`coalesce((select jsonb_agg(x) from jsonb_array_elements_text(${w.inboxIds}) x where x not in (${gone})), '[]'::jsonb)`,
      })
      .where(
        and(
          eq(w.teamId, p.teamId),
          sql`exists (select 1 from jsonb_array_elements_text(${w.inboxIds}) x where x in (${gone}))`,
        ),
      );
    for (const row of rows) {
      await recordInboxActivity(t, {
        teamId: p.teamId,
        inboxId: row.id,
        actor: p.actor,
        action: p.reason === "expired" ? "inbox.expired" : "inbox.deleted",
      });
    }
    return rows;
  });
  await hooks.flush();
  // Bulk and API deletions stay out of audit_log, which is never purged.
  if (p.reason === "deleted" && p.actor.kind === "user") {
    for (const row of deleted) {
      await recordAudit(db, {
        teamId: p.teamId,
        actor: { userId: p.actor.userId },
        action: "inbox.deleted",
        target: { type: "inbox", id: row.id },
        metadata: { email_address: row.emailAddress },
      });
    }
  }
  return deleted.length;
}

/** The hourly sweep: sweepable inboxes go, each announced as expired then deleted. */
export async function expireInboxes(db: Db, deps: InboxDeps, now: Date): Promise<number> {
  const i = schema.inboxes;
  // ponytail: one batch per run; a larger backlog clears over the next hourly runs,
  // and expired inboxes already read as gone everywhere. The idle half has no
  // index on last_used_at and scans inboxes: a partial one where domain_id is
  // null once that table is large.
  const due = await db
    .select({ id: i.id, teamId: i.teamId })
    .from(i)
    .where(sweepable(now))
    .orderBy(asc(i.expiresAt))
    .limit(EXPIRE_BATCH);
  const byTeam = new Map<string, string[]>();
  for (const row of due) byTeam.set(row.teamId, [...(byTeam.get(row.teamId) ?? []), row.id]);
  let n = 0;
  for (const [teamId, inboxIds] of byTeam) {
    n += await deleteInboxes(db, deps, {
      teamId,
      inboxIds,
      actor: { kind: "system" },
      reason: "expired",
      now,
    });
  }
  return n;
}

export async function getInboxSafety(
  db: Db,
  p: { teamId: string; inboxId: string },
): Promise<InboxSafety | null> {
  return (await findLiveInbox(db, { teamId: p.teamId, inboxId: p.inboxId }))?.safety ?? null;
}

export async function updateInboxSafety(
  db: Db,
  deps: InboxDeps,
  p: {
    teamId: string;
    inboxId: string;
    actor: InboxActor;
    patch: Partial<InboxSafety>;
    /** The team's effective plan, which decides whether a shared inbox may be open. */
    plan: Plan;
    isCloud: boolean;
  },
): Promise<{ ok: true; safety: InboxSafety } | { ok: false; error: InboxError }> {
  const now = new Date();
  const inbox = await findLiveInbox(db, { teamId: p.teamId, inboxId: p.inboxId, now: now });
  if (!inbox) return fail(INBOX_NOT_FOUND);
  const patch = setKeys(p.patch);
  const safety = await checkedSafety(db, {
    teamId: p.teamId,
    kind: inbox.kind,
    shared: inbox.domainId === null,
    safety: { ...inbox.safety, ...patch },
    plan: p.plan,
    isCloud: p.isCloud,
    now,
  });
  if (isInboxError(safety)) return fail(safety);
  const i = schema.inboxes;
  const hooks = webhookBatch(deps.enqueueWebhookDeliveries);
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [row] = await t
      .update(i)
      .set({ safety, updatedAt: now })
      .where(eq(i.id, inbox.id))
      .returning();
    if (!row) throw new Error("inbox safety update returned no row");
    await recordInboxActivity(t, {
      teamId: p.teamId,
      inboxId: row.id,
      actor: p.actor,
      action: "inbox.safety_updated",
    });
    await hooks.emit(t, p.teamId, [
      inboxEvent("inbox.updated", { source: webhookSource(p.actor), inbox: await wireOf(t, row) }),
    ]);
  });
  await hooks.flush();
  const audit = auditActorOf(p.actor);
  await recordAudit(db, {
    teamId: p.teamId,
    actor: audit.actor,
    action: "inbox.safety_updated",
    target: { type: "inbox", id: inbox.id },
    metadata: { ...audit.metadata, fields: Object.keys(patch) },
  });
  return { ok: true, safety };
}
