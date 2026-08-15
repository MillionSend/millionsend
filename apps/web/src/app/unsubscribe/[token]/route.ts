import { getDb, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { contactForToken } from "../lookup";

/**
 * Public unsubscribe endpoint — the signed token is the only credential.
 * This path is what buildUnsubscribeHeaders puts in List-Unsubscribe, so it
 * takes both verbs: a browser GET lands on the hosted confirm page (which
 * lives one segment over — page.tsx and route.ts can't share a segment),
 * and POST serves the confirm form plus RFC 8058 one-click posts
 * (form-encoded `List-Unsubscribe=One-Click`, which must get a bare 2xx,
 * not a redirect).
 */
export async function GET(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  return Response.redirect(
    new URL(`/unsubscribe/confirm/${encodeURIComponent(token)}`, request.url),
    302,
  );
}

export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const db = getDb();
  const contact = await contactForToken(db, token);
  if (!contact) return new Response(null, { status: 404 });

  await db
    .update(schema.contacts)
    .set({ unsubscribed: true, updatedAt: new Date() })
    .where(eq(schema.contacts.id, contact.id));

  const body = await request.text().catch(() => "");
  if (new URLSearchParams(body).get("List-Unsubscribe") === "One-Click") {
    return new Response(null, { status: 200 });
  }
  return Response.redirect(
    new URL(`/unsubscribe/confirm/${encodeURIComponent(token)}?done=1`, request.url),
    303,
  );
}
