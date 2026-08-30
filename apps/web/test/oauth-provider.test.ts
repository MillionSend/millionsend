import { createHash, createPublicKey, type JsonWebKey, randomBytes, verify } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Auth, createAuth } from "@/server/auth";
import { createCaller } from "@/server/routers";

const BASE = "http://localhost:3000";
const RESOURCE = "http://localhost:3001/mcp";
const REDIRECT_URI = "http://localhost:1234/callback";
const SCOPE = "offline_access emails:send audience:read";
// offline_access only drives refresh-token issuance; the resource-bound
// access token carries the scopes the MCP server enforces.
const RESOURCE_SCOPE = "emails:send audience:read";

let db: Db;
let close: () => Promise<void>;
let auth: Auth;

beforeEach(async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-1234");
  vi.stubEnv("APP_BASE_URL", BASE);
  vi.stubEnv("ALLOW_SIGNUP", "true");
  ({ db, close } = await createTestDb());
  auth = createAuth(db);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

function decodeJwt(token: string): Record<string, unknown> {
  const payload = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

/** Checks the token signature against the published JWKS, as the resource server will. */
async function verifiedByJwks(token: string): Promise<boolean> {
  const [header = "", payload = "", signature = ""] = token.split(".");
  const { kid } = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { kid: string };
  const jwks = (await (await call("/jwks")).json()) as {
    keys: Array<{ kid: string } & JsonWebKey>;
  };
  const jwk = jwks.keys.find((key) => key.kid === kid);
  if (!jwk) throw new Error(`kid ${kid} not in JWKS`);
  const key = createPublicKey({ key: jwk, format: "jwk" });
  return verify(
    null,
    Buffer.from(`${header}.${payload}`),
    key,
    Buffer.from(signature, "base64url"),
  );
}

async function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  return auth.handler(new Request(`${BASE}/api/auth${path}`, { ...init, headers }));
}

async function signUp(email: string): Promise<{ userId: string; cookie: string }> {
  const { headers, response } = await auth.api.signUpEmail({
    body: { name: email, email, password: "correct horse battery" },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { userId: response.user.id, cookie };
}

async function registerClient(scope?: string): Promise<string> {
  const res = await call("/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude Code",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(scope !== undefined ? { scope } : {}),
    }),
  });
  const body = (await res.json()) as { client_id: string };
  expect(res.status, JSON.stringify(body)).toBe(201);
  return body.client_id;
}

/** Authorization-code + PKCE round trip as an MCP client would run it. */
async function authorize(clientId: string, cookie: string, consentScope?: string) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  });
  const authorizeRes = await call(`/oauth2/authorize?${query}`, { cookie });
  const consentUrl = new URL(await redirectTarget(authorizeRes), BASE);
  expect(consentUrl.pathname).toBe("/oauth/consent");
  expect(consentUrl.searchParams.get("client_id")).toBe(clientId);

  const consentRes = await call("/oauth2/consent", {
    method: "POST",
    cookie,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accept: true,
      oauth_query: consentUrl.search.slice(1),
      // What the consent form sends when the user unticks permissions.
      ...(consentScope !== undefined ? { scope: consentScope } : {}),
    }),
  });
  const callback = new URL(await redirectTarget(consentRes), BASE);
  expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
  expect(callback.searchParams.get("state")).toBe("xyz");
  expect(callback.searchParams.get("iss")).toBe(BASE);
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("no authorization code");
  return token({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
    resource: RESOURCE,
  });
}

/** A redirect answered either as JSON `{ redirect, url }` (fetch) or a 302 (navigation). */
async function redirectTarget(res: Response): Promise<string> {
  const location = res.headers.get("location");
  if (location) return location;
  const body = (await res.json()) as { url?: string };
  if (!body.url) throw new Error(`no redirect in ${res.status} ${JSON.stringify(body)}`);
  return body.url;
}

async function token(form: Record<string, string>) {
  const res = await call("/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function addMember(userId: string, teamId: string, role: "owner" | "member" = "owner") {
  await db.insert(schema.teamMembers).values({ teamId, userId, role });
}

describe("OAuth authorization server", () => {
  it("publishes RFC 8414 metadata on the bare APP_BASE_URL issuer", async () => {
    // Served at the site root, not under /api/auth (see app/.well-known).
    const res = await auth.handler(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.issuer).toBe(BASE);
    expect(meta.authorization_endpoint).toBe(`${BASE}/api/auth/oauth2/authorize`);
    expect(meta.token_endpoint).toBe(`${BASE}/api/auth/oauth2/token`);
    expect(meta.registration_endpoint).toBe(`${BASE}/api/auth/oauth2/register`);
    expect(meta.jwks_uri).toBe(`${BASE}/api/auth/jwks`);
    expect(meta.code_challenge_methods_supported).toContain("S256");
    expect(meta.scopes_supported).toEqual(expect.arrayContaining(["emails:send", "domains:read"]));
  });

  it("issues a JWT access token bound to the MCP resource and the user's team", async () => {
    const teamId = await createTeam(db);
    const { userId, cookie } = await signUp("ada@example.com");
    await addMember(userId, teamId);
    const clientId = await registerClient();

    const { status, body } = await authorize(clientId, cookie);
    expect(status).toBe(200);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(15 * 60);
    expect(typeof body.refresh_token).toBe("string");
    expect(body.scope).toBe(RESOURCE_SCOPE);

    const claims = decodeJwt(body.access_token as string);
    expect(claims.iss).toBe(BASE);
    expect(claims.aud).toBe(RESOURCE);
    expect(claims.sub).toBe(userId);
    expect(claims.client_id).toBe(clientId);
    expect(claims.scope).toBe(RESOURCE_SCOPE);
    expect(claims.team_id).toBe(teamId);
    expect(claims.team_role).toBe("owner");
    // Signed by the jwt plugin's key, so the API can verify it offline via /jwks.
    expect(await verifiedByJwks(body.access_token as string)).toBe(true);

    const consents = await db.select().from(schema.oauthConsent);
    expect(consents).toHaveLength(1);
    expect(consents[0]?.referenceId).toBe(teamId);
  });

  it("binds the grant to the team chosen on the consent screen", async () => {
    const first = await createTeam(db, "first");
    const second = await createTeam(db, "second");
    const { userId, cookie } = await signUp("ada@example.com");
    await addMember(userId, first);
    await addMember(userId, second, "member");
    const [session] = await db
      .select({ id: schema.session.id })
      .from(schema.session)
      .where(eq(schema.session.userId, userId));
    if (!session) throw new Error("no session");
    // What the consent form does before posting consent.
    await createCaller({
      db,
      session: { user: { id: userId, email: "ada@example.com", name: "ada" }, session },
      teamId: null,
      role: null,
    }).team.switch({ teamId: second });

    const clientId = await registerClient();
    const { body } = await authorize(clientId, cookie);
    const claims = decodeJwt(body.access_token as string);
    expect(claims.team_id).toBe(second);
    expect(claims.team_role).toBe("member");
  });

  it("refreshes until the grant is revoked from Connected apps", async () => {
    const teamId = await createTeam(db);
    const { userId, cookie } = await signUp("ada@example.com");
    await addMember(userId, teamId);
    const clientId = await registerClient();
    const { body } = await authorize(clientId, cookie);

    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: body.refresh_token as string,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    expect(decodeJwt(refreshed.body.access_token as string).team_id).toBe(teamId);

    const caller = createCaller({
      db,
      session: { user: { id: userId, email: "ada@example.com", name: "ada" } },
      teamId,
      role: "owner",
    });
    const grants = await caller.connectedApps.list();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      clientId,
      clientName: "Claude Code",
      userEmail: "ada@example.com",
      own: true,
      scopes: SCOPE.split(" "),
    });
    await caller.connectedApps.revoke({ id: grants[0]?.id ?? "" });
    expect(await caller.connectedApps.list()).toHaveLength(0);
    expect(await db.select().from(schema.oauthRefreshToken)).toHaveLength(0);

    const denied = await token({
      grant_type: "refresh_token",
      refresh_token: refreshed.body.refresh_token as string,
      client_id: clientId,
    });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(denied.body.error).toBe("invalid_grant");
  });

  it("stops issuing tokens once the user leaves the team", async () => {
    const teamId = await createTeam(db);
    const { userId, cookie } = await signUp("ada@example.com");
    await addMember(userId, teamId);
    const clientId = await registerClient();
    const { body } = await authorize(clientId, cookie);

    await db
      .delete(schema.teamMembers)
      .where(and(eq(schema.teamMembers.userId, userId), eq(schema.teamMembers.teamId, teamId)));
    const denied = await token({
      grant_type: "refresh_token",
      refresh_token: body.refresh_token as string,
      client_id: clientId,
    });
    expect(denied.status).toBeGreaterThanOrEqual(400);
  });

  it("lets members revoke only their own grants; admins revoke any", async () => {
    const teamId = await createTeam(db);
    const owner = await signUp("owner@example.com");
    const member = await signUp("member@example.com");
    await addMember(owner.userId, teamId, "owner");
    await addMember(member.userId, teamId, "member");
    const clientId = await registerClient();
    await authorize(clientId, owner.cookie);
    await authorize(clientId, member.cookie);

    const memberCaller = createCaller({
      db,
      session: { user: { id: member.userId, email: "member@example.com", name: "m" } },
      teamId,
      role: "member",
    });
    const grants = await memberCaller.connectedApps.list();
    expect(grants).toHaveLength(2);
    const ownersGrant = grants.find((g) => g.userId === owner.userId);
    await expect(
      memberCaller.connectedApps.revoke({ id: ownersGrant?.id ?? "" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const ownerCaller = createCaller({
      db,
      session: { user: { id: owner.userId, email: "owner@example.com", name: "o" } },
      teamId,
      role: "owner",
    });
    const membersGrant = grants.find((g) => g.userId === member.userId);
    await ownerCaller.connectedApps.revoke({ id: membersGrant?.id ?? "" });
    expect(await ownerCaller.connectedApps.list()).toHaveLength(1);
  });

  it("issues only the scopes accepted on the consent screen", async () => {
    const teamId = await createTeam(db);
    const { userId, cookie } = await signUp("ada@example.com");
    await addMember(userId, teamId);
    const clientId = await registerClient();

    const { status, body } = await authorize(clientId, cookie, "offline_access emails:send");
    expect(status).toBe(200);
    expect(body.scope).toBe("emails:send");
    expect(decodeJwt(body.access_token as string).scope).toBe("emails:send");
    // offline_access was kept, so the grant still refreshes — to the same subset.
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: body.refresh_token as string,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    expect(decodeJwt(refreshed.body.access_token as string).scope).toBe("emails:send");

    const consents = await db.select().from(schema.oauthConsent);
    expect(consents[0]?.scopes).toEqual(["offline_access", "emails:send"]);
  });

  it("rejects a consent scope that was not requested", async () => {
    const teamId = await createTeam(db);
    const { userId, cookie } = await signUp("ada@example.com");
    await addMember(userId, teamId);
    const clientId = await registerClient();
    await expect(authorize(clientId, cookie, "offline_access domains:write")).rejects.toThrow();
  });

  it("binds an all-teams grant and resolves membership per refresh", async () => {
    const first = await createTeam(db, "first");
    const second = await createTeam(db, "second");
    const { userId, cookie } = await signUp("ada@example.com");
    await addMember(userId, first);
    await addMember(userId, second, "member");
    const [session] = await db
      .select({ id: schema.session.id })
      .from(schema.session)
      .where(eq(schema.session.userId, userId));
    if (!session) throw new Error("no session");
    // What the consent form does when "All teams" is picked.
    await createCaller({
      db,
      session: { user: { id: userId, email: "ada@example.com", name: "ada" }, session },
      teamId: null,
      role: null,
    }).team.grantTeam({ teamId: "*" });

    const clientId = await registerClient();
    const { body } = await authorize(clientId, cookie);
    const claims = decodeJwt(body.access_token as string);
    expect(claims.team_id).toBe("*");
    expect(claims.team_role).toBeUndefined();
    const consents = await db.select().from(schema.oauthConsent);
    expect(consents[0]?.referenceId).toBe("*");

    // Leaving one team keeps the grant alive; leaving the last one kills it.
    await db.delete(schema.teamMembers).where(eq(schema.teamMembers.teamId, first));
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: body.refresh_token as string,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    expect(decodeJwt(refreshed.body.access_token as string).team_id).toBe("*");
    await db.delete(schema.teamMembers).where(eq(schema.teamMembers.teamId, second));
    const denied = await token({
      grant_type: "refresh_token",
      refresh_token: refreshed.body.refresh_token as string,
      client_id: clientId,
    });
    expect(denied.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses to bind a grant to a team the user is not in", async () => {
    const mine = await createTeam(db, "mine");
    const other = await createTeam(db, "other");
    const { userId } = await signUp("ada@example.com");
    await addMember(userId, mine);
    const [session] = await db
      .select({ id: schema.session.id })
      .from(schema.session)
      .where(eq(schema.session.userId, userId));
    if (!session) throw new Error("no session");
    const caller = createCaller({
      db,
      session: { user: { id: userId, email: "ada@example.com", name: "ada" }, session },
      teamId: null,
      role: null,
    });
    await expect(caller.team.grantTeam({ teamId: other })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    const loner = await signUp("loner@example.com");
    const [lonerSession] = await db
      .select({ id: schema.session.id })
      .from(schema.session)
      .where(eq(schema.session.userId, loner.userId));
    if (!lonerSession) throw new Error("no session");
    await expect(
      createCaller({
        db,
        session: {
          user: { id: loner.userId, email: "loner@example.com", name: "l" },
          session: lonerSession,
        },
        teamId: null,
        role: null,
      }).team.grantTeam({ teamId: "*" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("shows all-teams grants in the holder's teams only, and revokes them everywhere", async () => {
    const first = await createTeam(db, "first");
    const second = await createTeam(db, "second");
    const elsewhere = await createTeam(db, "elsewhere");
    const ada = await signUp("ada@example.com");
    await addMember(ada.userId, first);
    await addMember(ada.userId, second, "member");
    const stranger = await signUp("stranger@example.com");
    await addMember(stranger.userId, elsewhere);
    const [session] = await db
      .select({ id: schema.session.id })
      .from(schema.session)
      .where(eq(schema.session.userId, ada.userId));
    if (!session) throw new Error("no session");
    await createCaller({
      db,
      session: { user: { id: ada.userId, email: "ada@example.com", name: "ada" }, session },
      teamId: null,
      role: null,
    }).team.grantTeam({ teamId: "*" });
    const clientId = await registerClient();
    const { body } = await authorize(clientId, ada.cookie);

    const callerFor = (userId: string, email: string, teamId: string, role: "owner" | "member") =>
      createCaller({ db, session: { user: { id: userId, email, name: email } }, teamId, role });
    const inFirst = await callerFor(
      ada.userId,
      "ada@example.com",
      first,
      "owner",
    ).connectedApps.list();
    expect(inFirst).toHaveLength(1);
    expect(inFirst[0]?.allTeams).toBe(true);
    const inSecond = await callerFor(
      ada.userId,
      "ada@example.com",
      second,
      "member",
    ).connectedApps.list();
    expect(inSecond).toHaveLength(1);
    // Not leaked into a team the grant holder doesn't belong to.
    const inElsewhere = await callerFor(
      stranger.userId,
      "stranger@example.com",
      elsewhere,
      "owner",
    ).connectedApps.list();
    expect(inElsewhere).toHaveLength(0);

    // Revoking from one team kills the grant for all of them.
    await callerFor(ada.userId, "ada@example.com", second, "member").connectedApps.revoke({
      id: inSecond[0]?.id ?? "",
    });
    expect(await db.select().from(schema.oauthRefreshToken)).toHaveLength(0);
    const denied = await token({
      grant_type: "refresh_token",
      refresh_token: body.refresh_token as string,
      client_id: clientId,
    });
    expect(denied.status).toBeGreaterThanOrEqual(400);
  });

  it("does not pin a registration's scope list, so scopes added later stay requestable", async () => {
    const teamId = await createTeam(db);
    const { userId, cookie } = await signUp("ada@example.com");
    await addMember(userId, teamId);
    // A registration that named only yesterday's scopes — the row must not
    // freeze the list, or a server upgrade adding a scope strands the client.
    const clientId = await registerClient("offline_access emails:send");
    const [client] = await db
      .select({ scopes: schema.oauthClient.scopes })
      .from(schema.oauthClient)
      .where(eq(schema.oauthClient.clientId, clientId));
    expect(client?.scopes).toBeNull();

    // Requests the full current list, audience:read included.
    const { status, body } = await authorize(clientId, cookie);
    expect(status).toBe(200);
    expect(body.scope).toBe(RESOURCE_SCOPE);
  });

  it("re-syncs the seeded resource's allowedScopes from config on a new boot", async () => {
    const teamId = await createTeam(db);
    const { userId, cookie } = await signUp("ada@example.com");
    await addMember(userId, teamId);
    const clientId = await registerClient();
    // First authorize lazily seeds the oauthResource row.
    const first = await authorize(clientId, cookie);
    expect(first.status).toBe(200);

    // A deployment that shipped before a scope existed: the stored row lacks
    // it. Token issuance intersects with allowedScopes, so without the merge
    // reseed this would silently strip the newer scopes from every token.
    await db
      .update(schema.oauthResource)
      .set({ allowedScopes: ["emails:send"] })
      .where(eq(schema.oauthResource.identifier, RESOURCE));

    const rebooted = createAuth(db);
    const prior = auth;
    auth = rebooted;
    try {
      // Same scopes as the stored consent, so the provider skips the consent
      // screen and redirects straight to the callback with a code.
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const query = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        state: "xyz",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
      });
      const res = await call(`/oauth2/authorize?${query}`, { cookie });
      const callback = new URL(await redirectTarget(res), BASE);
      expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
      const code = callback.searchParams.get("code") ?? "";
      const { status, body } = await token({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
        resource: RESOURCE,
      });
      expect(status).toBe(200);
      expect(decodeJwt(body.access_token as string).scope).toBe(RESOURCE_SCOPE);
      const [row] = await db
        .select({ allowedScopes: schema.oauthResource.allowedScopes })
        .from(schema.oauthResource)
        .where(eq(schema.oauthResource.identifier, RESOURCE));
      expect(row?.allowedScopes).toContain("webhooks:write");
    } finally {
      auth = prior;
    }
  });
});
