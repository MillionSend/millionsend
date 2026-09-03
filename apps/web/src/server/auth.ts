import { oauthProvider } from "@better-auth/oauth-provider";
import { env, isCloudDeployment, parseCommaList } from "@millionsend/config";
import { ALL_TEAMS_GRANT, isLoopbackUrl, MCP_SCOPES } from "@millionsend/core";
import { type Db, getDb, schema } from "@millionsend/db";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { captcha, jwt } from "better-auth/plugins";
import { and, eq, ne, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { headers } from "next/headers";
import { mcpResourceUrl, resolveBaseUrl } from "@/lib/api-base-url";
import { httpOrigin } from "@/lib/http-url";
import { getActiveMembership, listMemberships } from "./membership";
import {
  passwordRecoveryEnabled,
  RESET_TOKEN_TTL_MINUTES,
  type SystemMailDeps,
  sendPasswordResetEmail,
} from "./system-mail";

export type Auth = ReturnType<typeof createAuth>;

export { resolveBaseUrl };

/**
 * Registration metadata rendered as links on the consent screen. RFC 7591
 * lets the server ignore metadata it does not accept, so instead of failing
 * the registration these are dropped unless https and on the origin of a
 * redirect URI: a name plus a link to an arbitrary site on the trusted host
 * is the consent-phishing recipe, while a link to the callback's own origin
 * says nothing the redirect does not. Native (loopback) clients therefore
 * never get a link, which is fine — they have no web origin to vouch for.
 */
const CLIENT_LINK_FIELDS = ["client_uri", "logo_uri", "tos_uri", "policy_uri"] as const;

/**
 * Refuses account deletion while the user is the only owner of any team:
 * the team would be left with nobody able to administer or delete it.
 */
export async function assertNotSoleOwner(db: Db, userId: string): Promise<void> {
  const tm = schema.teamMembers;
  const others = alias(schema.teamMembers, "others");
  const [stranded] = await db
    .select({ teamId: tm.teamId })
    .from(tm)
    .where(
      and(
        eq(tm.userId, userId),
        eq(tm.role, "owner"),
        notExists(
          db
            .select({ one: others.userId })
            .from(others)
            .where(
              and(
                eq(others.teamId, tm.teamId),
                eq(others.role, "owner"),
                ne(others.userId, userId),
              ),
            ),
        ),
      ),
    )
    .limit(1);
  if (stranded) {
    throw new APIError("FORBIDDEN", {
      message: "Transfer ownership of your teams before deleting your account.",
    });
  }
}

/** Under SKIP_ENV_VALIDATION the env proxy carries the raw string, not the parsed list. */
function trustedProxies(): string[] {
  const raw: unknown = env.TRUSTED_PROXIES;
  if (Array.isArray(raw)) return raw;
  return parseCommaList(typeof raw === "string" ? raw : undefined) ?? ["127.0.0.1", "::1"];
}

/**
 * Self-host signup policy: the first user may always register (initial setup
 * has no other path to an account); after that, registration requires
 * ALLOW_SIGNUP=true. Open signup on a reachable dashboard would let anyone
 * mint API keys and send through the operator's SES account.
 */
export async function assertSignupAllowed(db: Db, allowSignup: boolean): Promise<void> {
  if (allowSignup) return;
  const [existing] = await db.select({ id: schema.user.id }).from(schema.user).limit(1);
  if (existing) {
    throw new APIError("FORBIDDEN", { message: "Signup is disabled." });
  }
}

/**
 * Which social sign-in buttons the auth screens should render. A provider
 * counts as enabled only when both its client id and secret are set — the
 * same condition that mounts it in `createAuth`, so the UI can never offer a
 * provider the server would reject.
 */
export function enabledSocialProviders(): { google: boolean; github: boolean } {
  return {
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
  };
}

/**
 * Scopes an OAuth client may request. `offline_access` is what makes the
 * provider issue a refresh token; the rest gate MCP tools on the API.
 */
export const OAUTH_SCOPES = ["offline_access", ...MCP_SCOPES];

/**
 * Team an OAuth grant is bound to. The consent page persists the picked team
 * (or ALL_TEAMS_GRANT) on the session row (team.grantTeam), and this
 * resolves it with the same rule as the dashboard cookie: a membership of
 * the user's own, else their oldest team, else nothing (the consent page
 * refuses to grant without a team).
 */
export async function grantTeamId(
  db: Db,
  userId: string,
  activeTeamId: string | null | undefined,
): Promise<string | undefined> {
  if (activeTeamId === ALL_TEAMS_GRANT) {
    return (await listMemberships(db, userId)).length ? ALL_TEAMS_GRANT : undefined;
  }
  return (await getActiveMembership(db, userId, activeTeamId ?? undefined))?.teamId;
}

/**
 * Claims stamped into every access token. Runs on each issuance and refresh,
 * so a member removed from the team stops getting tokens at the next refresh
 * rather than at consent expiry. Strict membership check — no fallback to
 * another team, or a revoked member's token would silently rebind.
 */
export async function grantClaims(
  db: Db,
  user: { id: string } | null | undefined,
  referenceId: string | undefined,
): Promise<{ team_id: string; team_role?: string }> {
  const memberships = user ? await listMemberships(db, user.id) : [];
  // All-teams grant: no single role to stamp — the API resolves the team
  // (and re-checks membership) per tool call instead.
  if (referenceId === ALL_TEAMS_GRANT) {
    if (!memberships.length) {
      throw new APIError("FORBIDDEN", { message: "You are no longer a member of any team." });
    }
    return { team_id: ALL_TEAMS_GRANT };
  }
  const membership = memberships.find((m) => m.teamId === referenceId);
  if (!membership) {
    throw new APIError("FORBIDDEN", { message: "The grant is not bound to a team you belong to." });
  }
  return { team_id: membership.teamId, team_role: membership.role };
}

/** Exported for tests, which inject a PGlite db and a captured mail sender. */
export function createAuth(db: Db = getDb(), mail?: SystemMailDeps) {
  // env.ts leaves BETTER_AUTH_SECRET optional (api/worker don't need it);
  // the web process is the one that must refuse to run without it.
  if (!env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET is required to run the web app");
  }
  const baseURL = resolveBaseUrl(env.APP_BASE_URL);
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        jwks: schema.jwks,
        oauthClient: schema.oauthClient,
        oauthResource: schema.oauthResource,
        oauthClientResource: schema.oauthClientResource,
        oauthRefreshToken: schema.oauthRefreshToken,
        oauthAccessToken: schema.oauthAccessToken,
        oauthConsent: schema.oauthConsent,
        oauthClientAssertion: schema.oauthClientAssertion,
      },
    }),
    session: {
      // No step-up: a signed-in session may do everything its role allows,
      // however old it is (Better Auth would otherwise re-prompt for
      // password changes and account deletion).
      freshAge: 0,
      additionalFields: {
        activeTeamId: { type: "string", required: false, input: false },
      },
    },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          await assertNotSoleOwner(db, user.id);
        },
      },
    },
    plugins: [
      // Turnstile on sign-in, sign-up and password reset when the instance
      // opts in; the forms send the token in x-captcha-response.
      ...(env.TURNSTILE_SECRET_KEY
        ? [captcha({ provider: "cloudflare-turnstile", secretKey: env.TURNSTILE_SECRET_KEY })]
        : []),
      // Issuer is the bare APP_BASE_URL (not .../api/auth) so RFC 8414
      // discovery resolves at /.well-known/oauth-authorization-server
      // (app/.well-known/oauth-authorization-server/route.ts).
      jwt({ jwt: { issuer: baseURL } }),
      oauthProvider({
        loginPage: "/login",
        consentPage: "/oauth/consent",
        scopes: OAUTH_SCOPES,
        resources: [{ identifier: mcpResourceUrl(), allowedScopes: [...MCP_SCOPES] }],
        // The seeded oauthResource row must track this config: token issuance
        // intersects requested scopes with the row's allowedScopes, so the
        // default insertOnly mode would freeze the scope list at first-boot —
        // every scope shipped later would be silently dropped from tokens.
        resourceSeedMode: "merge",
        clientRegistrationDefaultResources: [mcpResourceUrl()],
        // MCP clients (Claude Code, Cursor) still self-register via RFC 7591.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // Access tokens are JWTs the API verifies offline, so revoking a grant
        // only bites at the next refresh — keep that window short.
        accessTokenExpiresIn: 15 * 60,
        // A retried refresh within this window gets the same rotated response
        // instead of tripping replay detection (MCP clients retry on network blips).
        refreshTokenReuseInterval: 30,
        postLogin: {
          // Team selection happens on the consent page itself, so the
          // separate post-login step never redirects.
          page: "/oauth/consent",
          shouldRedirect: () => false,
          consentReferenceId: ({ user, session }) =>
            grantTeamId(
              db,
              user.id,
              typeof session.activeTeamId === "string" ? session.activeTeamId : undefined,
            ),
        },
        customAccessTokenClaims: ({ user, referenceId }) => grantClaims(db, user, referenceId),
        // The provider's OpenAPI parameter types (`items?: undefined`) do not
        // satisfy better-call's under exactOptionalPropertyTypes; runtime shape is fine.
      }) as unknown as BetterAuthPlugin,
    ],
    emailAndPassword: {
      enabled: true,
      // NIST floor: 8 with no composition rules — the signup form's strength
      // meter nudges toward longer, the server never blocks a valid 8+.
      minPasswordLength: 8,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_MINUTES * 60,
      // Left unset when the instance cannot deliver the email, which keeps
      // Better Auth's own RESET_PASSWORD_DISABLED 400 on the endpoint — the
      // sign-in screen hides the link for the same reason.
      ...(passwordRecoveryEnabled()
        ? {
            sendResetPassword: async (
              data: {
                user: { id: string; email: string; name: string };
                url: string;
                token: string;
              },
              request?: Request,
            ) => {
              await sendPasswordResetEmail(db, data, request, mail);
            },
          }
        : {}),
    },
    /**
     * Windows are seconds; storage is Better Auth's in-memory default
     * (per-process — fine for the single web replica this deploy runs).
     * The IP key comes from `advanced.ipAddress` below: without a trusted
     * proxy list Better Auth drops any multi-hop X-Forwarded-For chain into
     * one shared bucket, so a client that appends its own hop could lock
     * everyone out of sign-in.
     */
    rateLimit: {
      customRules: {
        "/request-password-reset": { window: 15 * 60, max: 3 },
        "/reset-password": { window: 15 * 60, max: 5 },
        "/reset-password/*": { window: 15 * 60, max: 5 },
        "/oauth2/register": { window: 15 * 60, max: 10 },
      },
    },
    advanced: {
      // Cloud sits behind Cloudflare only (the firewall admits nothing else),
      // which sets the single-value cf-connecting-ip. Self-host walks the
      // forwarded chain past the operator's declared proxies.
      ipAddress: isCloudDeployment()
        ? { ipAddressHeaders: ["cf-connecting-ip"] }
        : { trustedProxies: trustedProxies() },
    },
    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
        : {}),
      ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
        : {}),
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL,
    ...(env.APP_BASE_URL ? { trustedOrigins: [env.APP_BASE_URL] } : {}),
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            await assertSignupAllowed(db, env.ALLOW_SIGNUP);
          },
        },
      },
    },
    hooks: {
      // MCP clients register with http://localhost:<port> redirect URIs and
      // usually omit application_type, which RFC 7591 defaults to "web" — a
      // type the provider (rightly) refuses http redirects for. A loopback
      // redirect is the RFC 8252 signature of a native app, so classify it as one.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/oauth2/register") return;
        const body = ctx.body as Record<string, unknown> | undefined;
        if (!body) return;
        const redirects = Array.isArray(body.redirect_uris)
          ? body.redirect_uris.filter((uri): uri is string => typeof uri === "string")
          : [];
        const redirectOrigins = new Set(redirects.map(httpOrigin));
        for (const field of CLIENT_LINK_FIELDS) {
          const value = body[field];
          if (typeof value !== "string") continue;
          const origin = httpOrigin(value);
          if (!value.startsWith("https://") || origin === null || !redirectOrigins.has(origin)) {
            // In place: a body returned from the hook is defu-merged over the
            // original, so a key merely absent from it would survive.
            delete body[field];
          }
        }
        if (
          body.application_type ||
          !redirects.every((uri) => uri.startsWith("http://") && isLoopbackUrl(uri))
        ) {
          return;
        }
        return { context: { body: { ...body, application_type: "native" } } };
      }),
      // Registration persists a scope list (the client's own, or the server's
      // list as of that day) and authorization validates against it — which
      // would strand every registered MCP client with invalid_scope each time
      // a new scope ships. NULL defers to the live `scopes` config; per-user
      // consent remains the gate. drizzle/0007 does the same for clients
      // registered before this hook existed.
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/oauth2/register") return;
        const returned = ctx.context.returned;
        const clientId =
          returned && typeof returned === "object" && !(returned instanceof Response)
            ? (returned as { client_id?: unknown }).client_id
            : undefined;
        if (typeof clientId !== "string") return;
        await ctx.context.adapter.update({
          model: "oauthClient",
          where: [{ field: "clientId", value: clientId }],
          update: { scopes: null },
        });
      }),
    },
  });
}

let instance: Auth | undefined;

/**
 * Lazy singleton: `next build` evaluates route modules without runtime env,
 * so auth (and its db pool) must only be constructed on first request.
 */
export function getAuth(): Auth {
  instance ??= createAuth();
  return instance;
}

/**
 * Whether the request carries a signed-in session. False on any failure: the
 * auth screens use this to bounce signed-in visitors, and a broken session
 * lookup (no BETTER_AUTH_SECRET yet, or no request scope under tests) must
 * render the form rather than crash the page.
 */
export async function hasSession(): Promise<boolean> {
  try {
    return (await getAuth().api.getSession({ headers: await headers() })) !== null;
  } catch {
    return false;
  }
}
