import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { keysetRows } from "./inbox-common.js";
import type { ListQuery, QuarantinedItemWire } from "./types.js";

/**
 * Held mail, newest first: an inbox's quarantined memberships, or with
 * inboxId null the virus-held catch-all rows, which belong to no inbox.
 * Metadata only; `from` is the bare address.
 */
export async function listQuarantined(
  db: Db,
  p: { teamId: string; inboxId: string | null; query: ListQuery },
): Promise<{ data: QuarantinedItemWire[]; hasMore: boolean } | "bad_cursor"> {
  const r = schema.receivedEmails;
  if (p.inboxId === null) {
    const scope = and(
      eq(r.teamId, p.teamId),
      eq(r.catchAll, true),
      eq(r.virusVerdict, "fail"),
      isNull(r.releasedAt),
    );
    const page = await keysetRows({
      query: p.query,
      key: r.createdAt,
      id: r.id,
      newestFirst: true,
      cursorExists: async (id) =>
        (
          await db
            .select({ id: r.id })
            .from(r)
            .where(and(eq(r.id, id), scope))
        ).length > 0,
      cursorKey: (id) => sql`(select ${r.createdAt} from ${r} where ${r.id} = ${id}::uuid)`,
      load: (where, orderBy, take) =>
        db
          .select({
            id: r.id,
            from: r.from,
            subject: r.subject,
            createdAt: r.createdAt,
            senderTrust: r.senderTrust,
            virusSignature: r.virusSignature,
          })
          .from(r)
          .where(and(scope, where))
          .orderBy(...orderBy)
          .limit(take),
    });
    if (page === "bad_cursor") return page;
    return {
      data: page.rows.map((row) => ({
        id: row.id,
        thread_id: null,
        from: row.from,
        subject: row.subject === "" ? null : row.subject,
        received_at: row.createdAt.toISOString(),
        quarantine_reason: "virus" as const,
        sender_trust: row.senderTrust,
        injection_score: null,
        phishing_score: null,
        virus_signature: row.virusSignature,
      })),
      hasMore: page.hasMore,
    };
  }
  const inboxId = p.inboxId;
  const m = schema.receivedEmailInboxes;
  const scope = and(
    eq(m.inboxId, inboxId),
    eq(m.teamId, p.teamId),
    isNotNull(m.quarantinedAt),
    isNull(m.releasedAt),
  );
  const page = await keysetRows({
    query: p.query,
    key: m.quarantinedAt,
    id: m.receivedEmailId,
    newestFirst: true,
    cursorExists: async (id) =>
      (
        await db
          .select({ id: m.receivedEmailId })
          .from(m)
          .where(and(eq(m.receivedEmailId, id), scope))
      ).length > 0,
    cursorKey: (id) =>
      sql`(select ${m.quarantinedAt} from ${m} where ${m.receivedEmailId} = ${id}::uuid and ${m.inboxId} = ${inboxId}::uuid)`,
    load: (where, orderBy, take) =>
      db
        .select({
          id: m.receivedEmailId,
          threadId: m.threadId,
          reason: m.quarantineReason,
          senderTrust: m.senderTrust,
          injectionScore: m.injectionScore,
          phishingScore: m.phishingScore,
          from: r.from,
          subject: r.subject,
          createdAt: r.createdAt,
          virusSignature: r.virusSignature,
        })
        .from(m)
        .innerJoin(r, eq(r.id, m.receivedEmailId))
        .where(and(scope, where))
        .orderBy(...orderBy)
        .limit(take),
  });
  if (page === "bad_cursor") return page;
  return {
    data: page.rows.map((row) => ({
      id: row.id,
      thread_id: row.threadId,
      from: row.from,
      subject: row.subject === "" ? null : row.subject,
      received_at: row.createdAt.toISOString(),
      // A held membership always has its reason; unscreened covers a row written without one.
      quarantine_reason: row.reason ?? "unscreened",
      sender_trust: row.senderTrust,
      injection_score: row.injectionScore,
      phishing_score: row.phishingScore,
      virus_signature: row.virusSignature,
    })),
    hasMore: page.hasMore,
  };
}
