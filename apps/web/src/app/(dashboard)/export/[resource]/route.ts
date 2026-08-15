import { getDb } from "@millionsend/db";
import { cookies } from "next/headers";
import { getAuth } from "@/server/auth";
import { buildExport } from "@/server/exports";
import { ACTIVE_TEAM_COOKIE, getActiveMembership } from "@/server/membership";

/**
 * CSV export for the dashboard list surfaces. Authenticated by the Better Auth
 * session (never an API key) and scoped to the session's active team — the
 * teamId comes only from membership, never from the request, so no query param
 * can widen the export past the caller's own team.
 */
export async function GET(request: Request, ctx: { params: Promise<{ resource: string }> }) {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return new Response(null, { status: 401 });

  const db = getDb();
  const cookieStore = await cookies();
  const membership = await getActiveMembership(
    db,
    session.user.id,
    cookieStore.get(ACTIVE_TEAM_COOKIE)?.value,
  );
  if (!membership) return new Response(null, { status: 403 });

  const { resource } = await ctx.params;
  const url = new URL(request.url);
  const result = await buildExport(db, membership.teamId, resource, url.searchParams);
  if (!result) return new Response(null, { status: 404 });

  return new Response(result.csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${result.filename}"`,
      "cache-control": "no-store",
    },
  });
}
