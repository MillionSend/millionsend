import { getDb, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { sniffImageType, TEAM_LOGO_MAX_BYTES } from "@/lib/image-type";
import { getAuth } from "@/server/auth";
import { listMemberships } from "@/server/membership";
import {
  deletePublicObject,
  keyFromPublicUrl,
  putPublicObject,
  uploadsEnabled,
} from "@/server/storage";

/**
 * Team logo upload/removal. Authenticated by the Better Auth session (never an
 * API key). Unlike tRPC teamProcedure the target teamId comes from the client
 * — onboarding uploads immediately after creating the team — so authorization
 * is a fresh membership lookup: the caller must hold an owner/admin membership
 * of that exact team, and the id itself never reaches a query unverified.
 *
 * One object per team at `team-logos/<teamId>.<ext>`, overwritten on
 * re-upload; the stored URL carries a ?v= cache-buster so replacing the logo
 * defeats browser/CDN caches. A format change moves the key, so the previous
 * object is best-effort deleted.
 */

type Admin = { db: ReturnType<typeof getDb> } | { status: 401 | 403 };

async function requireTeamAdmin(request: Request, teamId: string): Promise<Admin> {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return { status: 401 };
  const db = getDb();
  const membership = (await listMemberships(db, session.user.id)).find((m) => m.teamId === teamId);
  if (!membership || membership.role === "member") return { status: 403 };
  return { db };
}

export async function POST(request: Request) {
  if (!uploadsEnabled()) return new Response(null, { status: 404 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response(null, { status: 400 });
  }
  const teamId = form.get("teamId");
  const file = form.get("file");
  if (typeof teamId !== "string" || teamId.length === 0 || !(file instanceof File)) {
    return new Response(null, { status: 400 });
  }

  const auth = await requireTeamAdmin(request, teamId);
  if (!("db" in auth)) return new Response(null, { status: auth.status });

  if (file.size > TEAM_LOGO_MAX_BYTES) return new Response(null, { status: 413 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImageType(bytes);
  if (!type) return new Response(null, { status: 415 });

  const [team] = await auth.db
    .select({ logoUrl: schema.teams.logoUrl })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));

  const key = `team-logos/${teamId}.${type}`;
  const objectUrl = await putPublicObject(key, bytes, `image/${type}`);
  const logoUrl = `${objectUrl}?v=${Date.now()}`;
  await auth.db.update(schema.teams).set({ logoUrl }).where(eq(schema.teams.id, teamId));

  const previousKey = team?.logoUrl ? keyFromPublicUrl(team.logoUrl) : null;
  if (previousKey && previousKey !== key) await deletePublicObject(previousKey);

  return Response.json({ logoUrl });
}

export async function DELETE(request: Request) {
  if (!uploadsEnabled()) return new Response(null, { status: 404 });

  const teamId = new URL(request.url).searchParams.get("teamId");
  if (!teamId) return new Response(null, { status: 400 });

  const auth = await requireTeamAdmin(request, teamId);
  if (!("db" in auth)) return new Response(null, { status: auth.status });

  const [team] = await auth.db
    .select({ logoUrl: schema.teams.logoUrl })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  await auth.db.update(schema.teams).set({ logoUrl: null }).where(eq(schema.teams.id, teamId));

  const key = team?.logoUrl ? keyFromPublicUrl(team.logoUrl) : null;
  if (key) await deletePublicObject(key);

  return Response.json({ ok: true });
}
