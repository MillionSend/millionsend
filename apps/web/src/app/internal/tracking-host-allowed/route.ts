import { timingSafeEqual } from "node:crypto";
import { env } from "@millionsend/config";
import { getDb, schema } from "@millionsend/db";
import { and, isNotNull, sql } from "drizzle-orm";

// The tracking edge (a Caddy box doing on-demand TLS) calls this before issuing
// a certificate for a hostname, so a cert is only ever minted for a hostname a
// team has actually configured as its branded tracking subdomain — without it,
// anyone pointing DNS at the edge could exhaust the CA's issuance limits. A 2xx
// authorizes issuance; anything else denies it.
//
// Reachable without a session: it is gated by TRACKING_ASK_SECRET, which the
// edge sends in the query, and it returns only a yes/no with no data.
export const dynamic = "force-dynamic";

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request): Promise<Response> {
  const expected = env.TRACKING_ASK_SECRET;
  // No secret set → no edge is in use here; never authorize issuance.
  if (!expected) return new Response("tracking edge not configured", { status: 403 });

  const params = new URL(request.url).searchParams;
  const token = params.get("token") ?? "";
  if (!secretMatches(token, expected)) return new Response("forbidden", { status: 403 });

  const host = (params.get("domain") ?? "").trim().toLowerCase();
  if (!host) return new Response("missing domain", { status: 400 });

  const db = getDb();
  const [row] = await db
    .select({ id: schema.domains.id })
    .from(schema.domains)
    .where(
      and(
        isNotNull(schema.domains.trackingSubdomain),
        sql`lower(${schema.domains.trackingSubdomain} || '.' || ${schema.domains.name}) = ${host}`,
      ),
    )
    .limit(1);

  return row ? new Response("ok") : new Response("unknown host", { status: 404 });
}
