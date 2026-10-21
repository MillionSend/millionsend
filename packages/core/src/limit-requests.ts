import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, desc, eq } from "drizzle-orm";
import { recordAudit } from "./audit.js";
import { warmupCap } from "./domain-warmup.js";
import { LIMIT_REQUEST_NOTE_MAX, LIMIT_REQUEST_PER_DAY_MAX } from "./limit-rules.js";

export const LIMIT_REQUEST_SENDS = schema.domainLimitRequestSendsEnum.enumValues;
export const LIMIT_REQUEST_SOURCES = schema.domainLimitRequestSourceEnum.enumValues;
export type LimitRequestSends = (typeof LIMIT_REQUEST_SENDS)[number];
export type LimitRequestSource = (typeof LIMIT_REQUEST_SOURCES)[number];
export type LimitRequestStatus = (typeof schema.domainLimitRequestStatusEnum.enumValues)[number];

/** A request as its team sees it: what it asked and where that stands, never who decided. */
export interface TeamLimitRequest {
  id: string;
  domainId: string;
  status: LimitRequestStatus;
  sends: LimitRequestSends;
  perDay: number;
  source: LimitRequestSource;
  note: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

/** A request as the operator's console lists it. */
export interface ConsoleLimitRequest extends TeamLimitRequest {
  teamId: string;
  team: string;
  domain: string;
  requesterEmail: string | null;
  /** The operator's email; null while open or when a trust granted it without one. */
  resolvedBy: string | null;
}

export type LimitRequestRefusal = "invalid" | "not_found" | "not_limited" | "already_open";

const r = schema.domainLimitRequests;
const TEAM_COLUMNS = {
  id: r.id,
  domainId: r.domainId,
  status: r.status,
  sends: r.sends,
  perDay: r.perDay,
  source: r.source,
  note: r.note,
  createdAt: r.createdAt,
  resolvedAt: r.resolvedAt,
};

/**
 * A team asks to lift the new domain limit on one of its verified domains
 * while the limit applies to it, one open request per domain. The team's
 * audit row is written after the request.
 */
export async function createLimitRequest(
  db: Db,
  input: {
    teamId: string;
    domainId: string;
    userId: string | null;
    sends: LimitRequestSends;
    perDay: number;
    source: LimitRequestSource;
    note?: string | null | undefined;
    now?: Date;
  },
): Promise<{ ok: true; request: TeamLimitRequest } | { ok: false; refusal: LimitRequestRefusal }> {
  const note = input.note?.trim() || null;
  if (
    !Number.isInteger(input.perDay) ||
    input.perDay < 1 ||
    input.perDay > LIMIT_REQUEST_PER_DAY_MAX ||
    !LIMIT_REQUEST_SENDS.includes(input.sends) ||
    !LIMIT_REQUEST_SOURCES.includes(input.source) ||
    (note !== null && note.length > LIMIT_REQUEST_NOTE_MAX)
  ) {
    return { ok: false, refusal: "invalid" };
  }
  const now = input.now ?? new Date();
  const d = schema.domains;
  const [domain] = await db
    .select({ name: d.name, status: d.status })
    .from(d)
    .where(and(eq(d.id, input.domainId), eq(d.teamId, input.teamId)));
  if (!domain) return { ok: false, refusal: "not_found" };
  if (
    domain.status !== "verified" ||
    !(await warmupCap(db, { teamId: input.teamId, domainId: input.domainId, at: now }))
  ) {
    return { ok: false, refusal: "not_limited" };
  }
  // The unique index on a domain's open request is the lock: of two at once, one is written.
  const [request] = await db
    .insert(r)
    .values({
      teamId: input.teamId,
      domainId: input.domainId,
      requestedBy: input.userId,
      sends: input.sends,
      perDay: input.perDay,
      source: input.source,
      note,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning(TEAM_COLUMNS);
  if (!request) return { ok: false, refusal: "already_open" };
  await recordAudit(db, {
    teamId: input.teamId,
    actor: input.userId ? { userId: input.userId } : "system",
    action: "domain.limit_requested",
    target: { type: "domain", id: input.domainId },
    metadata: {
      name: domain.name,
      perDay: input.perDay,
      sends: input.sends,
      source: input.source,
    },
  });
  return { ok: true, request };
}

/** The domain's open request, if any. */
export async function getOpenLimitRequest(
  db: Db,
  input: { teamId: string; domainId: string },
): Promise<TeamLimitRequest | null> {
  const [row] = await db
    .select(TEAM_COLUMNS)
    .from(r)
    .where(and(eq(r.teamId, input.teamId), eq(r.domainId, input.domainId), eq(r.status, "open")));
  return row ?? null;
}

/** The domain's most recent request, open or resolved. */
export async function latestLimitRequest(
  db: Db,
  input: { teamId: string; domainId: string },
): Promise<TeamLimitRequest | null> {
  const [row] = await db
    .select(TEAM_COLUMNS)
    .from(r)
    .where(and(eq(r.teamId, input.teamId), eq(r.domainId, input.domainId)))
    .orderBy(desc(r.createdAt), desc(r.id))
    .limit(1);
  return row ?? null;
}

/** Requests for the console, newest first, with the team, the domain and who asked. */
export async function listLimitRequests(
  db: Db,
  input: { status?: LimitRequestStatus; teamId?: string; limit: number },
): Promise<ConsoleLimitRequest[]> {
  const t = schema.teams;
  const d = schema.domains;
  const u = schema.user;
  return db
    .select({
      ...TEAM_COLUMNS,
      teamId: r.teamId,
      team: t.name,
      domain: d.name,
      requesterEmail: u.email,
      resolvedBy: r.resolvedBy,
    })
    .from(r)
    .innerJoin(t, eq(t.id, r.teamId))
    .innerJoin(d, eq(d.id, r.domainId))
    .leftJoin(u, eq(u.id, r.requestedBy))
    .where(
      and(
        input.status ? eq(r.status, input.status) : undefined,
        input.teamId ? eq(r.teamId, input.teamId) : undefined,
      ),
    )
    .orderBy(desc(r.createdAt), desc(r.id))
    .limit(input.limit);
}

/**
 * The warm-up override: a trusted team, or one trusted domain of it, sends
 * past the new domain limit from now on. A trust grants what is open for
 * the domain, or for the whole team. Null when the domain is not the
 * team's or the team does not exist. The caller audits and kicks the drain.
 */
export async function setWarmupTrust(
  db: Db,
  input: {
    teamId: string;
    domainId?: string | undefined;
    trusted: boolean;
    now?: Date;
    operator?: string | null;
  },
): Promise<{ domain: string | null } | null> {
  const now = input.now ?? new Date();
  const trustedAt = input.trusted ? now : null;
  let domain: string | null = null;
  if (input.domainId) {
    const d = schema.domains;
    const [row] = await db
      .update(d)
      .set({ warmupTrustedAt: trustedAt })
      .where(and(eq(d.id, input.domainId), eq(d.teamId, input.teamId)))
      .returning({ name: d.name });
    if (!row) return null;
    domain = row.name;
  } else {
    const t = schema.teams;
    const [row] = await db
      .update(t)
      .set({ warmupTrustedAt: trustedAt })
      .where(eq(t.id, input.teamId))
      .returning({ id: t.id });
    if (!row) return null;
  }
  if (input.trusted) {
    await db
      .update(r)
      .set({ status: "granted", resolvedAt: now, resolvedBy: input.operator ?? null })
      .where(
        and(
          eq(r.teamId, input.teamId),
          eq(r.status, "open"),
          input.domainId ? eq(r.domainId, input.domainId) : undefined,
        ),
      );
  }
  return { domain };
}

/**
 * The operator declines an open request: the domain keeps the new domain
 * limit. A grant is a trust (setWarmupTrust). The caller audits; the team
 * hears the outcome from the notifications sweep.
 */
export async function declineLimitRequest(
  db: Db,
  input: { requestId: string; operator: string; now?: Date },
): Promise<
  | { ok: true; request: { id: string; teamId: string; domainId: string } }
  | { ok: false; refusal: "not_open" }
> {
  const [request] = await db
    .update(r)
    .set({ status: "declined", resolvedAt: input.now ?? new Date(), resolvedBy: input.operator })
    .where(and(eq(r.id, input.requestId), eq(r.status, "open")))
    .returning({ id: r.id, teamId: r.teamId, domainId: r.domainId });
  return request ? { ok: true, request } : { ok: false, refusal: "not_open" };
}
