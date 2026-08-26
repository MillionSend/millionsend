import { oauthProvider } from "@better-auth/oauth-provider";
import { env } from "@millionsend/config";
import { isLoopbackUrl, MCP_SCOPES } from "@millionsend/core";
import { type Db, getDb, schema } from "@millionsend/db";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { mcpResourceUrl } from "@/lib/api-base-url";
import { getActiveMembership, listMemberships } from "./membership";
import {
  passwordRecoveryEnabled,
  RESET_TOKEN_TTL_MINUTES,
  type SystemMailDeps,
  sendPasswordResetEmail,
} from "./system-mail";

export type Auth = ReturnType<typeof createAuth>;

/**
 * Better Auth rejects sign-ins from origins outside its trusted set. Production
 * must never silently trust localhost; development and tests retain the local
 * fallback for the no-config quickstart.
 */
export function resolveBaseUrl(
  appBaseUrl: string | undefined,
  nodeEnv = process.env.NODE_ENV,
): string {
  if (appBaseUrl) return appBaseUrl;
  if (nodeEnv === "production") {
    throw new Error("APP_BASE_URL is required in production");
  }
  console.warn("APP_BASE_URL is not set: using http://localhost:3000 outside production.");
  return "http://localhost:3000";
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
 * on the session row (team.switch), and this resolves it with the same rule
 * as the dashboard cookie: a membership of the user's own, else their oldest
 * team, else nothing (the consent page refuses to grant without a team).
 */
export async function grantTeamId(
  db: Db,
  userId: string,
  activeTeamId: string | null | undefined,
): Promise<string | undefined> {
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
): Promise<{ team_id: string; team_role: string }> {
  const membership = user
    ? (await listMemberships(db, user.id)).find((m) => m.teamId === referenceId)
    : undefined;
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
      additionalFields: {
        activeTeamId: { type: "string", required: false, input: false },
      },
    },
    plugins: [
      // Issuer is the bare APP_BASE_URL (not .../api/auth) so RFC 8414
      // discovery resolves at /.well-known/oauth-authorization-server
      // (app/.well-known/oauth-authorization-server/route.ts).
      jwt({ jwt: { issuer: baseURL } }),
      oauthProvider({
        loginPage: "/login",
        consentPage: "/oauth/consent",
        scopes: OAUTH_SCOPES,
        resources: [{ identifier: mcpResourceUrl(), allowedScopes: [...MCP_SCOPES] }],
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
     * The IP key comes from the default x-forwarded-for header, matching the
     * nginx config in SELF_HOSTING.md; a client-appended (spoofed) multi-value
     * chain is rejected by Better Auth and collapses into one shared bucket,
     * so spoofing cannot widen a limit.
     */
    rateLimit: {
      customRules: {
        "/request-password-reset": { window: 15 * 60, max: 3 },
        "/reset-password": { window: 15 * 60, max: 5 },
        "/reset-password/*": { window: 15 * 60, max: 5 },
      },
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
        const body = ctx.body as
          | { application_type?: string; redirect_uris?: string[] }
          | undefined;
        const loopbackOnly = body?.redirect_uris?.every(
          (uri) => uri.startsWith("http://") && isLoopbackUrl(uri),
        );
        if (!body || body.application_type || !loopbackOnly) return;
        return { context: { body: { ...body, application_type: "native" } } };
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
