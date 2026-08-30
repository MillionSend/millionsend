import { getDb, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { httpOrigin } from "@/lib/http-url";
import { getAuth, OAUTH_SCOPES } from "@/server/auth";
import { ACTIVE_TEAM_COOKIE, getActiveMembership, listMemberships } from "@/server/membership";
import { ConsentForm } from "./consent-form";

/**
 * OAuth consent screen. The provider redirects here with a signed copy of
 * the authorization query (client_id, scope, sig, exp…); the form posts it
 * back through the auth client, which is what completes the flow.
 */
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") query.set(key, value);
  }
  const session = await getAuth().api.getSession({ headers: await headers() });
  // Expired session: the login resumes the pending authorization from the
  // same signed query, exactly as the provider's own login redirect does.
  if (!session) redirect(`/login?${query}`);

  const db = getDb();
  const clientId = query.get("client_id");
  const [client] = clientId
    ? await db
        .select({
          clientId: schema.oauthClient.clientId,
          name: schema.oauthClient.name,
          uri: schema.oauthClient.uri,
          redirectUris: schema.oauthClient.redirectUris,
          createdAt: schema.oauthClient.createdAt,
          skipConsent: schema.oauthClient.skipConsent,
        })
        .from(schema.oauthClient)
        .where(eq(schema.oauthClient.clientId, clientId))
    : [];
  const teams = await listMemberships(db, session.user.id);
  const active = await getActiveMembership(
    db,
    session.user.id,
    (await cookies()).get(ACTIVE_TEAM_COOKIE)?.value,
  );
  // Only known scopes are described; the provider rejects unknown ones anyway.
  const scopes = (query.get("scope") ?? "")
    .split(" ")
    .filter((scope) => (OAUTH_SCOPES as string[]).includes(scope));

  return (
    <ConsentForm
      app={
        client
          ? {
              clientId: client.clientId,
              name: client.name,
              uri: client.uri,
              // Where the code (and the user) end up after Allow — the one
              // fact about the app the registrant could not make up.
              redirectOrigins: [
                ...new Set(client.redirectUris.map(httpOrigin).filter((o) => o !== null)),
              ],
              // Only operator-trusted clients skip consent; everything else
              // self-registered and is shown as such.
              unverified: !client.skipConsent,
              registeredAt: client.createdAt?.toISOString() ?? null,
            }
          : null
      }
      userEmail={session.user.email}
      scopes={scopes}
      teams={teams.map(({ teamId, teamName, role }) => ({ teamId, teamName, role }))}
      defaultTeamId={active?.teamId ?? null}
    />
  );
}
