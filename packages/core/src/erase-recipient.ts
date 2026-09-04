import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { type AnyColumn, and, eq, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import { extractAddrSpec, hashRecipient, normalizeAddress } from "./suppressions.js";

/** Replaces every erased copy of an address so readers see a deliberate gap, not a blank. */
export const ERASED_TOMBSTONE = "[erased]";

/** Escapes a literal for use inside a PostgreSQL (ARE) regular expression. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface EraseRecipientResult {
  emails: number;
  events: number;
  deliveries: number;
  apiRequests: number;
  suppressions: number;
}

/**
 * Cross-table erasure of one recipient address within a team (GDPR/LGPD
 * erasure request). Suppressions keep their hash so do-not-contact keeps
 * working; every plaintext copy is tombstoned or deleted: recipient lists on
 * emails, provider event payloads, webhook payloads and responses, and API
 * request logs. The caller removes the contact row itself. Idempotent.
 */
export async function eraseRecipient(
  db: Db,
  teamId: string,
  address: string,
): Promise<EraseRecipientResult> {
  const addr = normalizeAddress(extractAddrSpec(address));
  const plain = escapeRegex(addr);
  // Whole JSON string values that mention the address collapse to the
  // tombstone (display names and diagnostics quoting it go too). The class
  // excludes quotes and backslashes, so the rewritten text always re-parses
  // as jsonb.
  const json = `"[^"\\\\]*${plain}[^"\\\\]*"`;
  const jsonTombstone = `"${ERASED_TOMBSTONE}"`;
  const scrubJson = (column: AnyColumn): SQL =>
    sql`regexp_replace(${column}::text, ${json}, ${jsonTombstone}, 'gi')::jsonb`;

  const e = schema.emails;
  const mentions = or(
    sql`${e.to}::text ~* ${json}`,
    sql`${e.cc}::text ~* ${json}`,
    sql`${e.bcc}::text ~* ${json}`,
    sql`${e.replyTo}::text ~* ${json}`,
  );
  const teamEmailsMentioning = db
    .select({ id: e.id })
    .from(e)
    .where(and(eq(e.teamId, teamId), mentions));

  // Events first: their scope is derived from the recipient lists that the
  // emails update below tombstones.
  const ev = schema.emailEvents;
  const events = await db
    .update(ev)
    .set({ data: scrubJson(ev.data) })
    .where(and(inArray(ev.emailId, teamEmailsMentioning), sql`${ev.data}::text ~* ${json}`))
    .returning({ id: ev.id });

  // Scoped by endpoint, not email: test deliveries and deliveries whose email
  // already aged out have no email_id.
  const d = schema.webhookDeliveries;
  const wh = schema.webhookEndpoints;
  const teamEndpoints = db.select({ id: wh.id }).from(wh).where(eq(wh.teamId, teamId));
  // Contact events carry the name beside the address; a name alone is still
  // personal data, so it leaves with the address.
  const contactPayload = sql`lower(${d.payload}->'data'->>'email') = ${addr}`;
  const withoutNames = sql`case when ${contactPayload} then ${d.payload} #- '{data,first_name}' #- '{data,last_name}' else ${d.payload} end`;
  const deliveries = await db
    .update(d)
    .set({
      payload: sql`regexp_replace((${withoutNames})::text, ${json}, ${jsonTombstone}, 'gi')::jsonb`,
      lastResponseBody: sql`regexp_replace(${d.lastResponseBody}, ${plain}, ${ERASED_TOMBSTONE}, 'gi')`,
    })
    .where(
      and(
        inArray(d.endpointId, teamEndpoints),
        or(sql`${d.payload}::text ~* ${json}`, sql`${d.lastResponseBody} ~* ${plain}`),
      ),
    )
    .returning({ id: d.id });

  const emails = await db
    .update(e)
    .set({
      to: scrubJson(e.to),
      cc: scrubJson(e.cc),
      bcc: scrubJson(e.bcc),
      replyTo: scrubJson(e.replyTo),
    })
    .where(and(eq(e.teamId, teamId), mentions))
    .returning({ id: e.id });

  const r = schema.apiRequests;
  const apiRequests = await db
    .delete(r)
    .where(
      and(
        eq(r.teamId, teamId),
        or(
          sql`${r.path} ~* ${plain}`,
          sql`${r.path} ~* ${escapeRegex(encodeURIComponent(addr))}`,
          sql`${r.requestBody}::text ~* ${plain}`,
          sql`${r.responseBody}::text ~* ${plain}`,
        ),
      ),
    )
    .returning({ id: r.id });

  // Rows hashed before normalization existed still carry the plaintext, so
  // the address itself is matched alongside the current hash.
  const s = schema.suppressions;
  const suppressions = await db
    .update(s)
    .set({ email: null })
    .where(
      and(
        eq(s.teamId, teamId),
        isNotNull(s.email),
        or(eq(s.emailHash, hashRecipient(addr)), sql`lower(${s.email}) = ${addr}`),
      ),
    )
    .returning({ id: s.id });

  return {
    emails: emails.length,
    events: events.length,
    deliveries: deliveries.length,
    apiRequests: apiRequests.length,
    suppressions: suppressions.length,
  };
}
