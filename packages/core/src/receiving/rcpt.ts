import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { firstRow, isUniqueViolation } from "../driver-result.js";
import { INBOX_FLOOD_PER_HOUR } from "../inboxes/limits.js";
import { SHARED_ROLE_LOCAL_PARTS } from "../inboxes/shared-domain.js";
import { isDomainOrSubdomain } from "../org-domain.js";
import { OVERAGE_HARD_CAP, type QuotaTeamRow, type TeamQuota, teamQuota } from "../plans.js";
import { dailyCeiling, reserveQuota } from "../quota.js";
import { routableAddress } from "../sender-address.js";
import { QUOTA_COLUMNS } from "../team-plan.js";
import { bumpHourlyUsage } from "../usage-hourly.js";
import { utcDay } from "../utc-day.js";
import { findInboxesForRecipients } from "./inbox-routing.js";
import type { RcptResponse } from "./protocol.js";

/** The free receiving allowance on Starter and on monthly plans, as a multiple of the plan's volume. */
export const RECEIVING_ALLOWANCE_MULTIPLIER = 2;

/** Past a monthly plan's allowance, this many received messages count as one email. */
export const RECEIVED_PER_BILLED_EMAIL = 10;

/**
 * How received mail is counted against a team, by plan (the approved pricing).
 * Self-host never caps it, whatever the operator's sending ceiling says.
 */
export type ReceivingRule =
  /** Self-host and the instance's own team: counted, never capped. */
  | { kind: "none" }
  /**
   * Free: received mail spends the same daily counter sends do, so both
   * share the cap, up to the ceiling where sends park (tolerance included).
   */
  | { kind: "shared_day"; quota: Extract<TeamQuota, { kind: "day" }>; ceiling: number }
  /** Starter: free up to its own daily allowance, apart from sending. */
  | { kind: "day"; allowance: number }
  /**
   * Monthly plans: free up to the allowance per billing period; past it every
   * RECEIVED_PER_BILLED_EMAIL-th message adds one email to the period's
   * counter (quota and overage), and none is taken once that counter sits at
   * the period ceiling (the overage hard cap, or the volume with overage off).
   */
  | { kind: "month"; allowance: number; periodStart: Date; ceiling: number };

export function receivingRule(
  team: QuotaTeamRow,
  isCloud: boolean,
  now: Date = new Date(),
): ReceivingRule {
  const quota = teamQuota(team, isCloud, now);
  // The plan's own cap: the operator's ceiling limits sending, not receiving.
  const plan = teamQuota({ ...team, dailySendCeiling: null }, isCloud, now);
  if (quota.kind === "none" || plan.kind === "none") return { kind: "none" };
  if (plan.kind === "day") {
    if (plan.plan === "free" && quota.kind === "day") {
      const ceiling = Math.min(
        dailyCeiling(quota.limit),
        quota.dailyCeiling ?? Number.POSITIVE_INFINITY,
      );
      return { kind: "shared_day", quota, ceiling };
    }
    return { kind: "day", allowance: plan.limit * RECEIVING_ALLOWANCE_MULTIPLIER };
  }
  return {
    kind: "month",
    allowance: plan.included * RECEIVING_ALLOWANCE_MULTIPLIER,
    periodStart: plan.periodStart,
    ceiling: plan.overage ? plan.included * OVERAGE_HARD_CAP : plan.included,
  };
}

/** Whether one more received message fits the rule right now; read-only, for the RCPT answer. */
export async function hasReceivingRoom(
  db: Db,
  teamId: string,
  rule: ReceivingRule,
  now: Date = new Date(),
): Promise<boolean> {
  if (rule.kind === "none") return true;
  if (rule.kind === "month") {
    const p = schema.usagePeriods;
    const [row] = await db
      .select({ received: p.received, accepted: p.accepted })
      .from(p)
      .where(and(eq(p.teamId, teamId), eq(p.periodStart, rule.periodStart)));
    return (row?.received ?? 0) < rule.allowance || (row?.accepted ?? 0) < rule.ceiling;
  }
  const c = schema.usageCounters;
  const [row] = await db
    .select({ accepted: c.accepted, received: c.received })
    .from(c)
    .where(and(eq(c.teamId, teamId), eq(c.day, utcDay(now))));
  return rule.kind === "shared_day"
    ? (row?.accepted ?? 0) < rule.ceiling
    : (row?.received ?? 0) < rule.allowance;
}

/**
 * Counts one received message against a team, in the caller's transaction:
 * the daily and hourly `received` counters always, plus what the rule
 * charges. False when the allowance is spent; the caller then rolls back, so
 * a refusal never leaves a partial count behind. Every check sits inside its
 * upsert's WHERE, so concurrent deliveries cannot overshoot.
 */
export async function chargeReceived(
  db: Db,
  params: { teamId: string; rule: ReceivingRule; now: Date },
): Promise<boolean> {
  const { teamId, rule, now } = params;
  const day = utcDay(now);
  if (rule.kind === "shared_day") {
    const reserved = await reserveQuota(db, { teamId, count: 1, quota: rule.quota, day, at: now });
    if (!reserved.reserved) return false;
  }
  if (rule.kind === "month") {
    const p = schema.usagePeriods;
    // Postgres reads every SET expression against the row before the update,
    // so `received + 1` here is the message being counted.
    const unit = sql`case when ${p.received} + 1 > ${rule.allowance} and (${p.received} + 1 - ${rule.allowance}) % ${RECEIVED_PER_BILLED_EMAIL} = 0 then 1 else 0 end`;
    const charged = await db.execute<{ received: number }>(sql`
      insert into ${p} (team_id, period_start, received)
      values (${teamId}, ${rule.periodStart}, 1)
      on conflict (team_id, period_start) do update
        set received = ${p.received} + 1, accepted = ${p.accepted} + ${unit}
        where ${p.received} < ${rule.allowance} or ${p.accepted} < ${rule.ceiling}
      returning received
    `);
    if (!firstRow(charged)) return false;
  }
  const c = schema.usageCounters;
  const guard = rule.kind === "day" ? sql`${c.received} < ${rule.allowance}` : sql`true`;
  const counted = await db.execute<{ received: number }>(sql`
    insert into ${c} (team_id, day, received)
    values (${teamId}, ${day}, 1)
    on conflict (team_id, day) do update
      set received = ${c.received} + 1
      where ${guard}
    returning received
  `);
  if (!firstRow(counted)) return false;
  await bumpHourlyUsage(db, { teamId, at: now, counts: { received: 1 } });
  return true;
}

/** A receiving-enabled domain with what routing and the pricing rule need of its team. */
export interface ReceivingDomain extends QuotaTeamRow {
  /**
   * Null for a team's subdomain of the shared inbox domain and for the shared
   * domain's role mail, which are no domains rows.
   */
  domainId: string | null;
  sharedDomainId: string | null;
  name: string;
  teamId: string;
  suspendedAt: Date | null;
  /** Mail to an address without an inbox is stored; off, it is refused at RCPT. */
  catchAll: boolean;
  /** Whether any inbox lives at this name: then RCPT answers depend on the address. */
  hasInboxes: boolean;
}

/**
 * The receiving-enabled domains among `names` (already ASCII, lowercase),
 * and the teams' shared-domain subdomains among them; at most one row per
 * name. A shared subdomain is never a catch-all: only its inboxes receive.
 * A deleted team's label (team_id null) matches nothing.
 */
export async function findReceivingDomains(
  db: Db,
  names: readonly string[],
): Promise<ReceivingDomain[]> {
  if (names.length === 0) return [];
  const d = schema.domains;
  const s = schema.sharedInboxDomains;
  const i = schema.inboxes;
  const [custom, shared] = await Promise.all([
    db
      .select({
        domainId: d.id,
        sharedDomainId: sql<string | null>`null`,
        name: d.name,
        teamId: d.teamId,
        suspendedAt: schema.teams.suspendedAt,
        catchAll: d.receivingCatchAll,
        hasInboxes: sql<boolean>`exists (select 1 from ${i} where ${i.domainId} = ${d.id})`,
        ...QUOTA_COLUMNS,
      })
      .from(d)
      .innerJoin(schema.teams, eq(schema.teams.id, d.teamId))
      .where(and(inArray(d.name, [...names]), eq(d.receivingEnabled, true))),
    db
      .select({
        domainId: sql<string | null>`null`,
        sharedDomainId: s.id,
        name: s.name,
        teamId: schema.teams.id,
        suspendedAt: schema.teams.suspendedAt,
        catchAll: sql<boolean>`false`,
        hasInboxes: sql<boolean>`true`,
        ...QUOTA_COLUMNS,
      })
      .from(s)
      .innerJoin(schema.teams, eq(schema.teams.id, s.teamId))
      .where(inArray(s.name, [...names])),
  ]);
  return [...custom, ...shared];
}

/**
 * Permanent refusals are cached only briefly: the sender bounces on a 550, so
 * one must not outlive the state behind it (a domain switching receiving on).
 */
const REFUSAL_TTL_SECONDS = 10;

const UNKNOWN_RECIPIENT = {
  accept: false,
  code: 550,
  enhanced: "5.1.1",
  message: "Recipient domain does not receive mail here",
  ttlSeconds: REFUSAL_TTL_SECONDS,
} as const satisfies RcptResponse;

const SUSPENDED_RECIPIENT = {
  accept: false,
  code: 550,
  enhanced: "5.7.1",
  message: "Recipient account is not accepting mail",
  ttlSeconds: REFUSAL_TTL_SECONDS,
} as const satisfies RcptResponse;

const OVER_QUOTA = {
  accept: false,
  code: 452,
  enhanced: "4.2.2",
  message: "Recipient account is over its receiving limit, try again later",
  ttlSeconds: 30,
} as const satisfies RcptResponse;

// The MX caches answers per domain, and these depend on the address: never cached.
const NO_SUCH_RECIPIENT = {
  accept: false,
  code: 550,
  enhanced: "5.1.1",
  message: "No such recipient here",
  ttlSeconds: 0,
} as const satisfies RcptResponse;

const MAILBOX_FLOODED = {
  accept: false,
  code: 452,
  enhanced: "4.2.2",
  message: "This mailbox is receiving too much mail, try again later",
  ttlSeconds: 0,
} as const satisfies RcptResponse;

const HOUR_MS = 3_600_000;

/** Whether an inbox took `limit` messages or more in the last hour; counts no further than that. */
export async function inboxFlooded(
  db: Db,
  inboxId: string,
  limit: number,
  now: Date,
): Promise<boolean> {
  const m = schema.receivedEmailInboxes;
  const counted = firstRow<{ n: number }>(
    await db.execute(sql`
      select count(*)::int as n from (
        select 1 from ${m}
        where ${m.inboxId} = ${inboxId} and ${m.createdAt} > ${new Date(now.getTime() - HOUR_MS)}
        limit ${limit}
      ) recent
    `),
  );
  return (counted?.n ?? 0) >= limit;
}

/**
 * Whether `address` (routableAddress form) is a SHARED_ROLE_LOCAL_PARTS
 * address, any case but never by its +tag, at the shared inbox domain or any
 * name under it.
 */
export function isSharedRoleAddress(
  address: string,
  sharedDomain: string | null | undefined,
): boolean {
  const at = address.lastIndexOf("@");
  return (
    !!sharedDomain &&
    (SHARED_ROLE_LOCAL_PARTS as readonly string[]).includes(address.slice(0, at).toLowerCase()) &&
    isDomainOrSubdomain(address.slice(at + 1), sharedDomain)
  );
}

/**
 * Where the shared domain's role mail lands: the oldest System-plan team, as
 * a catch-all with no domains row. Null on an instance without one.
 */
export async function findRoleMailTeam(
  db: Db,
  sharedDomain: string,
): Promise<ReceivingDomain | null> {
  // ponytail: never capped (the System plan's receiving rule is none), so only
  // the MX's per-IP limits bound a flood of role mail; an hourly cap like
  // INBOX_FLOOD_PER_HOUR is the upgrade if that ever bites.
  const t = schema.teams;
  const [team] = await db
    .select({ teamId: t.id, suspendedAt: t.suspendedAt, ...QUOTA_COLUMNS })
    .from(t)
    .where(eq(t.plan, "system"))
    .orderBy(asc(t.createdAt), asc(t.id))
    .limit(1);
  return team
    ? {
        ...team,
        domainId: null,
        sharedDomainId: null,
        name: sharedDomain,
        catchAll: true,
        hasInboxes: false,
      }
    : null;
}

/**
 * The MX's question per RCPT TO: recipient → domain (lowercase, IDNA-encoded)
 * → a receiving-enabled domain or a shared subdomain → its team, the
 * address's live inbox (exact, then without its +tag) or the domain's
 * catch-all, then the inbox's hourly flood limit and the team's receiving
 * allowance. The shared domain's role mail goes to the System team before
 * any of that. Only the envelope decides; nothing here reads a header. An
 * answer that depends on the address is never cached by the MX.
 */
export async function decideRecipient(
  db: Db,
  params: {
    recipient: string;
    isCloud: boolean;
    sharedInboxDomain?: string | null | undefined;
    now?: Date;
  },
): Promise<RcptResponse> {
  const now = params.now ?? new Date();
  const recipient = routableAddress(params.recipient);
  if (!recipient) return UNKNOWN_RECIPIENT;
  const shared = params.sharedInboxDomain;
  // The MX caches answers per domain, and role mail makes every answer under
  // the shared domain depend on the address: a cached refusal would shadow
  // postmaster@ and abuse@.
  const underShared = !!shared && isDomainOrSubdomain(recipient.domain, shared);
  const uncached = (answer: RcptResponse): RcptResponse =>
    underShared ? { ...answer, ttlSeconds: 0 } : answer;
  const [domain] =
    shared && isSharedRoleAddress(recipient.address, shared)
      ? [await findRoleMailTeam(db, shared)]
      : await findReceivingDomains(db, [recipient.domain]);
  if (!domain) return underShared ? NO_SUCH_RECIPIENT : UNKNOWN_RECIPIENT;
  if (domain.suspendedAt) return uncached(SUSPENDED_RECIPIENT);
  const perAddress = domain.hasInboxes || !domain.catchAll;
  if (perAddress) {
    const inbox = (await findInboxesForRecipients(db, [domain], [recipient.address], now)).get(
      recipient.address,
    );
    if (!inbox && !domain.catchAll) return NO_SUCH_RECIPIENT;
    if (inbox && (await inboxFlooded(db, inbox.id, INBOX_FLOOD_PER_HOUR[inbox.kind], now))) {
      return MAILBOX_FLOODED;
    }
  }
  const rule = receivingRule(domain, params.isCloud, now);
  if (!(await hasReceivingRoom(db, domain.teamId, rule, now))) return uncached(OVER_QUOTA);
  return { accept: true, ttlSeconds: perAddress || underShared ? 0 : 30 };
}

export type DomainReceivingResult =
  | {
      ok: true;
      /** False when the domain was already in the asked state. */
      changed: boolean;
      name: string;
      receivingEnabled: boolean;
      receivingEnabledAt: Date | null;
    }
  | {
      ok: false;
      /** not_found: no such domain in the team; not_verified: receiving needs a verified domain; taken: another team receives this name. */
      reason: "not_found" | "not_verified" | "taken";
    };

/**
 * Switches a domain's receiving on or off. On requires the domain verified in
 * the team; the database refuses a name another team already receives
 * (domains_receiving_name_idx), which reads as `taken`. Callers check that
 * the instance receives mail at all (RECEIVING_MX_HOST) before calling.
 */
export async function setDomainReceiving(
  db: Db,
  params: { teamId: string; domainId: string; enabled: boolean; now?: Date },
): Promise<DomainReceivingResult> {
  const d = schema.domains;
  const scope = and(eq(d.id, params.domainId), eq(d.teamId, params.teamId));
  const [domain] = await db
    .select({
      name: d.name,
      status: d.status,
      receivingEnabled: d.receivingEnabled,
      receivingEnabledAt: d.receivingEnabledAt,
    })
    .from(d)
    .where(scope);
  if (!domain) return { ok: false, reason: "not_found" };
  if (domain.receivingEnabled === params.enabled) {
    return {
      ok: true,
      changed: false,
      name: domain.name,
      receivingEnabled: domain.receivingEnabled,
      receivingEnabledAt: domain.receivingEnabledAt,
    };
  }
  if (params.enabled && domain.status !== "verified") return { ok: false, reason: "not_verified" };
  try {
    const [row] = await db
      .update(d)
      .set({
        receivingEnabled: params.enabled,
        receivingEnabledAt: params.enabled ? (params.now ?? new Date()) : null,
      })
      .where(scope)
      .returning({
        receivingEnabled: d.receivingEnabled,
        receivingEnabledAt: d.receivingEnabledAt,
      });
    if (!row) return { ok: false, reason: "not_found" };
    return { ok: true, changed: true, name: domain.name, ...row };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "taken" };
    throw err;
  }
}

/**
 * Whether a received row is visible without asking for held mail: a row
 * delivered into any inbox (released mail counts as delivered), or a
 * catch-all row that a person released, or that carries no virus and no
 * inbox holds, so the catch-all copy never shows what an inbox quarantined
 * or still screens.
 */
export function receivedEmailVisible(): SQL {
  const r = schema.receivedEmails;
  const m = schema.receivedEmailInboxes;
  return sql`((${r.catchAll} and (${r.releasedAt} is not null or (${r.virusVerdict} is distinct from 'fail' and not exists (select 1 from ${m} where ${m.receivedEmailId} = ${r.id} and ${m.deliveredAt} is null)))) or exists (select 1 from ${m} where ${m.receivedEmailId} = ${r.id} and ${m.deliveredAt} is not null))`;
}

/**
 * The received_emails rows a caller may read: its team's, and for a
 * domain-scoped API key only mail addressed to that domain. `held` decides
 * whether pending and quarantined mail is left out (agents, Resend-shaped
 * lists), included (the dashboard, include_quarantined) or the only mail
 * read; `inboxId` narrows to mail that reached that inbox, delivered unless
 * held mail is asked for.
 */
export function receivedEmailScope(params: {
  teamId: string;
  domainId?: string | null | undefined;
  inboxId?: string | null | undefined;
  held: "include" | "exclude" | "only";
}): SQL {
  const r = schema.receivedEmails;
  const m = schema.receivedEmailInboxes;
  const parts: SQL[] = [eq(r.teamId, params.teamId)];
  if (params.domainId) parts.push(sql`${params.domainId}::uuid = any(${r.domainIds})`);
  if (params.inboxId) {
    const delivered =
      params.held === "exclude"
        ? sql` and ${m.deliveredAt} is not null`
        : params.held === "only"
          ? sql` and ${m.deliveredAt} is null`
          : sql``;
    parts.push(
      sql`exists (select 1 from ${m} where ${m.receivedEmailId} = ${r.id} and ${m.inboxId} = ${params.inboxId}${delivered})`,
    );
  } else if (params.held === "exclude") {
    parts.push(receivedEmailVisible());
  } else if (params.held === "only") {
    parts.push(sql`not ${receivedEmailVisible()}`);
  }
  return and(...parts) as SQL;
}
