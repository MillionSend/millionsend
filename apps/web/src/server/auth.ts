import { getOAuthProviderState, oauthProvider } from "@better-auth/oauth-provider";
import {
  accountEmailFrom,
  disposableEmailsBlocked,
  env,
  isCloudDeployment,
  signupOpen,
} from "@millionsend/config";
import {
  ALL_TEAMS_GRANT,
  CUSTOMER_TEXT_MAX,
  DAY_MS,
  enrollSystemContact,
  fillTemplate,
  findSenderDomainOwner,
  forwardedClientIp,
  isPlainName,
  MCP_SCOPES,
  recordSignup,
  removeSystemContact,
  stripInvisible,
} from "@millionsend/core";
import { type Db, getDb, schema } from "@millionsend/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { captcha, jwt } from "better-auth/plugins";
import { and, desc, eq, lte, ne, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { headers } from "next/headers";
import { mcpResourceUrl, resolveBaseUrl } from "@/lib/api-base-url";
import { GRANT_LIFETIME_DAYS, isGrantLifetime } from "@/lib/grant-lifetime";
import { httpOrigin, isUnlistedHostRedirect } from "@/lib/http-url";
import { isAppLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from "@/lib/locale-cookie";
import enAuth from "../../messages/en/auth.json";
import enCommon from "../../messages/en/common.json";
import ptBRAuth from "../../messages/pt-BR/auth.json";
import ptBRCommon from "../../messages/pt-BR/common.json";
import { disposableAddressTest } from "./disposable-email";
import { accountMailLocale, localeFromHeaders } from "./locale";
import { getActiveMembership, listMemberships } from "./membership";
import { enqueueRecipientErase } from "./queue";
import {
  buildMcpConnectedEmail,
  buildPasswordChangedEmail,
  buildWelcomeEmail,
  emailVerificationEnabled,
  passwordRecoveryEnabled,
  RESET_TOKEN_TTL_MINUTES,
  type SystemMailDeps,
  sendAccountMail,
  sendPasswordResetEmail,
  sendVerificationEmail,
  VERIFY_TOKEN_TTL_MINUTES,
} from "./system-mail";
import { trustedProxies } from "./trusted-proxies";

export type Auth = ReturnType<typeof createAuth>;

export { resolveBaseUrl };

/**
 * Registration metadata rendered as links on the consent screen. RFC 7591
 * lets the server ignore metadata it does not accept, so instead of failing
 * the registration these are dropped unless https and on the origin of a
 * redirect URI: a name plus a link to an arbitrary site on the trusted host
 * is the consent-phishing recipe, while a link to the callback's own origin
 * says nothing the redirect does not. Loopback-only clients therefore
 * never get a link, which is fine — they have no web origin to vouch for.
 */
const CLIENT_LINK_FIELDS = ["client_uri", "logo_uri", "tos_uri", "policy_uri"] as const;

/**
 * Open registration stores a client row per request, so the metadata is
 * bounded, and client_name headlines the consent screen, so it is kept to a
 * line and stripped of the invisible and bidi characters that make a name
 * read as something it is not.
 */
const MAX_REGISTRATION_JSON = 16 * 1024;

const NAME_RULE = { en: enCommon.nameRule, "pt-BR": ptBRCommon.nameRule } as const;

/**
 * Sign-up and the profile endpoint store the display name that system mail
 * prints, so it must be a plain name (isPlainName), refused in the
 * requester's language.
 */
function assertPlainName(body: unknown, headers: Headers | undefined): void {
  const name = (body as { name?: unknown } | undefined)?.name;
  if (typeof name !== "string" || isPlainName(name)) return;
  throw new APIError("BAD_REQUEST", {
    code: "INVALID_NAME",
    message: fillTemplate(NAME_RULE[localeFromHeaders(headers)], {
      max: String(CUSTOMER_TEXT_MAX),
    }),
  });
}

const DISPOSABLE_REFUSAL = {
  signup: { en: enAuth.signup.disposable, "pt-BR": ptBRAuth.signup.disposable },
  change: { en: enAuth.changeEmail.disposable, "pt-BR": ptBRAuth.changeEmail.disposable },
} as const;

/**
 * An address on the disposable list is refused where the instance blocks
 * them, in the requester's language. On a change, an address some account
 * already holds is not new (the write is that account's own row), so an
 * account registered with one before the block keeps working. Sign-up
 * never asks: refusing a held address differently would tell anyone which
 * disposable addresses have accounts.
 */
async function assertPermanentAddress(
  db: Db,
  email: unknown,
  when: keyof typeof DISPOSABLE_REFUSAL,
  headers: Headers | undefined,
): Promise<void> {
  if (typeof email !== "string" || !disposableEmailsBlocked()) return;
  if (!(await disposableAddressTest(db))(email)) return;
  if (when === "change") {
    const [held] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, email.toLowerCase()))
      .limit(1);
    if (held) return;
  }
  throw new APIError("BAD_REQUEST", {
    code: "DISPOSABLE_EMAIL",
    message: DISPOSABLE_REFUSAL[when][localeFromHeaders(headers)],
  });
}

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
 * Authorization parameters with offline_access added to the scope, or
 * undefined when the request is not for the MCP resource or already asks
 * for it (or names no scope, which the provider fills with every scope).
 * MCP clients often ask only for the scopes their tools need, and without
 * offline_access the provider issues no refresh token, so the connection
 * would end with the first access token. PKCE is untouched: public clients
 * need it whatever the scope, and offline_access only widens where it is
 * required.
 */
function withOfflineAccess(params: unknown, mcpResource: string): object | undefined {
  if (!params || typeof params !== "object") return;
  const { scope, resource } = params as { scope?: unknown; resource?: unknown };
  if (typeof scope !== "string" || scope.split(" ").includes("offline_access")) return;
  if (![resource].flat().includes(mcpResource)) return;
  return { ...params, scope: `${scope} offline_access` };
}

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
 * so a grant past the lifetime picked at consent, or whose consent is gone,
 * gets no more tokens, and a member removed from the team stops getting them
 * at the next refresh. The bound lives on the consent row, which neither a
 * refresh nor a silent re-authorization moves. Strict membership check — no
 * fallback to another team, or a revoked member's token would silently rebind.
 */
export async function grantClaims(
  db: Db,
  user: { id: string } | null | undefined,
  referenceId: string | undefined,
  clientId: string,
): Promise<{ team_id: string; team_role?: string }> {
  const c = schema.oauthConsent;
  // A client that skips consent would have no row and get no tokens; none
  // can, as dynamic registration refuses skip_consent.
  const [consent] =
    user && referenceId
      ? await db
          .select({ expiresAt: c.expiresAt })
          .from(c)
          .where(
            and(eq(c.clientId, clientId), eq(c.userId, user.id), eq(c.referenceId, referenceId)),
          )
      : [];
  if (!consent || (consent.expiresAt && consent.expiresAt <= new Date())) {
    throw new APIError("BAD_REQUEST", {
      error: "invalid_grant",
      error_description: "The grant has ended. Authorize the app again.",
    });
  }
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

/**
 * Deletes a grant with every token issued under it, so a refresh token the
 * client still holds can neither outlive the grant nor work again once the
 * same grant is made anew.
 */
export async function endGrant(
  db: Db,
  grant: { id: string; clientId: string; userId: string; referenceId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const issued = (table: typeof schema.oauthRefreshToken | typeof schema.oauthAccessToken) =>
      and(
        eq(table.clientId, grant.clientId),
        eq(table.userId, grant.userId),
        eq(table.referenceId, grant.referenceId),
      );
    await tx.delete(schema.oauthAccessToken).where(issued(schema.oauthAccessToken));
    await tx.delete(schema.oauthRefreshToken).where(issued(schema.oauthRefreshToken));
    await tx.delete(schema.oauthConsent).where(eq(schema.oauthConsent.id, grant.id));
  });
}

/**
 * Ends the client's grants whose lifetime ran out. The provider skips the
 * consent screen while a consent row covers the request, so an expired row
 * left in place would skip it too, into a token exchange that is refused.
 */
async function endExpiredGrants(db: Db, clientId: string): Promise<void> {
  const c = schema.oauthConsent;
  const expired = await db
    .select({ id: c.id, clientId: c.clientId, userId: c.userId, referenceId: c.referenceId })
    .from(c)
    .where(and(eq(c.clientId, clientId), lte(c.expiresAt, new Date())));
  for (const grant of expired) {
    await endGrant(db, {
      ...grant,
      userId: grant.userId ?? "",
      referenceId: grant.referenceId ?? "",
    });
  }
}

/** The team holding the instance's account mail, if a team verified the sender's domain. */
async function accountMailTeam(db: Db) {
  const from = accountEmailFrom();
  return from ? findSenderDomainOwner(db, from) : null;
}

/**
 * Exported for tests, which inject a PGlite db, a captured mail sender and an
 * inline erasure (production hands the address to the worker queue).
 */
export function createAuth(
  db: Db = getDb(),
  mail?: SystemMailDeps,
  deps: { eraseRecipient?: (teamId: string, address: string) => Promise<unknown> } = {},
) {
  // env.ts leaves BETTER_AUTH_SECRET optional (api/worker don't need it);
  // the web process is the one that must refuse to run without it.
  if (!env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET is required to run the web app");
  }
  const baseURL = resolveBaseUrl(env.APP_BASE_URL);
  const mcpResource = mcpResourceUrl();
  const erase = deps.eraseRecipient ?? enqueueRecipientErase;
  /**
   * A proven account becomes a contact of the account-mail team. Proven:
   * the address is verified, or this instance cannot verify anyone (no
   * sender to send the link) and the account is all there is. An address
   * merely typed at sign-up may be someone else's inbox, so it waits for
   * the verification link. Every account the instance admits is welcomed
   * then; a self-host closed to sign-up has nobody to market to and does not
   * enroll, while the cloud enrolls whatever the flag says, since it closes
   * sign-up for reasons of its own. Best-effort: the account exists whatever
   * happens here.
   */
  const enrollAccount = async (
    user: { email: string; name: string; emailVerified: boolean },
    headers: Headers | undefined,
  ) => {
    try {
      if (emailVerificationEnabled() && !user.emailVerified) return;
      const locale = await accountMailLocale(db, user.email, headers);
      if (accountEmailFrom()) {
        sendAccountMail(buildWelcomeEmail({ to: user.email, name: user.name, locale }), mail);
      }
      if (!signupOpen() && !isCloudDeployment()) return;
      const owner = await accountMailTeam(db);
      if (!owner) return;
      await enrollSystemContact(db, owner.teamId, { email: user.email, name: user.name, locale });
    } catch (error) {
      console.error("Account-mail contact enrollment failed", error);
    }
  };
  /**
   * Stamps the consent just recorded with when it ends, from the lifetime
   * picked on the consent screen (validated in hooks.before). Not swallowed
   * like the receipt below: the request fails rather than leave the grant
   * unstamped, which would read as until disconnected.
   */
  const recordGrantLifetime = async (ctx: {
    body?: unknown;
    context: {
      returned?: unknown;
      session?: { user: { id: string }; session: Record<string, unknown> } | null;
    };
  }) => {
    const { accept, lifetime } = (ctx.body ?? {}) as { accept?: unknown; lifetime?: unknown };
    if (accept !== true || !isGrantLifetime(lifetime)) return;
    if (ctx.context.returned instanceof APIError) return;
    const session = ctx.context.session;
    const clientId = new URLSearchParams((await getOAuthProviderState())?.query).get("client_id");
    if (!session || !clientId) return;
    const { activeTeamId } = session.session;
    const referenceId = await grantTeamId(
      db,
      session.user.id,
      typeof activeTeamId === "string" ? activeTeamId : undefined,
    );
    if (!referenceId) return;
    const days = GRANT_LIFETIME_DAYS[lifetime];
    const c = schema.oauthConsent;
    await db
      .update(c)
      .set({ expiresAt: days === null ? null : new Date(Date.now() + days * DAY_MS) })
      .where(
        and(
          eq(c.clientId, clientId),
          eq(c.userId, session.user.id),
          eq(c.referenceId, referenceId),
        ),
      );
  };
  /**
   * A consent just granted to an MCP client is a receipt to its user: the
   * app can act in their name until the grant ends. The provider stamps a new
   * consent row with one instant for both dates and moves only updatedAt on
   * a re-consent, so a row whose dates differ is a repeat and stays silent.
   */
  const mailConsent = async (ctx: {
    body?: unknown;
    headers?: Headers | undefined;
    context: { returned?: unknown; session?: { user: { id: string; email: string } } | null };
  }) => {
    try {
      if (!accountEmailFrom()) return;
      if ((ctx.body as { accept?: unknown } | undefined)?.accept !== true) return;
      if (ctx.context.returned instanceof APIError) return;
      const user = ctx.context.session?.user;
      if (!user) return;
      const [consent] = await db
        .select({
          app: schema.oauthClient.name,
          scopes: schema.oauthConsent.scopes,
          referenceId: schema.oauthConsent.referenceId,
          createdAt: schema.oauthConsent.createdAt,
          updatedAt: schema.oauthConsent.updatedAt,
          expiresAt: schema.oauthConsent.expiresAt,
        })
        .from(schema.oauthConsent)
        .innerJoin(
          schema.oauthClient,
          eq(schema.oauthClient.clientId, schema.oauthConsent.clientId),
        )
        .where(eq(schema.oauthConsent.userId, user.id))
        .orderBy(desc(schema.oauthConsent.updatedAt))
        .limit(1);
      if (!consent || consent.createdAt?.getTime() !== consent.updatedAt?.getTime()) return;
      let team: string | "*" = "*";
      if (consent.referenceId && consent.referenceId !== ALL_TEAMS_GRANT) {
        const [row] = await db
          .select({ name: schema.teams.name })
          .from(schema.teams)
          .where(eq(schema.teams.id, consent.referenceId));
        if (!row) return;
        team = row.name;
      }
      sendAccountMail(
        buildMcpConnectedEmail({
          to: user.email,
          app: consent.app ?? "An app",
          team,
          scopes: consent.scopes,
          expiresAt: consent.expiresAt,
          locale: await accountMailLocale(db, user.email, ctx.headers),
        }),
        mail,
      );
    } catch (error) {
      console.error("Connected-app email skipped", error);
    }
  };
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
      // No Better Auth step-up: a signed-in session may do everything its
      // role allows, however old it is (Better Auth would otherwise re-prompt
      // for password changes and account deletion). Starting a support view
      // is the one exception: it asks for an emailed code, or the sign-in age
      // when none can be sent (server/console-code.ts).
      freshAge: 0,
      additionalFields: {
        activeTeamId: { type: "string", required: false, input: false },
      },
    },
    user: {
      additionalFields: {
        locale: { type: "string", required: false, input: false },
      },
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          await assertNotSoleOwner(db, user.id);
        },
        // The row is already gone; the contact copy and the address in the
        // account-mail team's history go with it — for a proven address
        // only, or deleting an account registered with someone else's
        // address would scrub that person's own account mail from the log.
        // Best-effort: nothing here may fail a deletion that has happened.
        afterDelete: async (user) => {
          try {
            if (emailVerificationEnabled() && !user.emailVerified) return;
            const owner = await accountMailTeam(db);
            if (owner) await removeSystemContact(db, owner.teamId, user.email, erase);
          } catch (error) {
            console.error("Account-mail contact removal failed", error);
          }
        },
      },
    },
    plugins: [
      // Turnstile on sign-in, sign-up, password reset and the verification
      // resend when the instance opts in; the forms send the token in
      // x-captcha-response. The plugin's default list lacks the resend.
      ...(env.TURNSTILE_SECRET_KEY
        ? [
            captcha({
              provider: "cloudflare-turnstile",
              secretKey: env.TURNSTILE_SECRET_KEY,
              endpoints: [
                "/sign-up/email",
                "/sign-in/email",
                "/request-password-reset",
                "/send-verification-email",
              ],
            }),
          ]
        : []),
      // Issuer is the bare APP_BASE_URL (not .../api/auth) so RFC 8414
      // discovery resolves at /.well-known/oauth-authorization-server
      // (app/.well-known/oauth-authorization-server/route.ts).
      jwt({ jwt: { issuer: baseURL } }),
      oauthProvider({
        loginPage: "/login",
        consentPage: "/oauth/consent",
        scopes: OAUTH_SCOPES,
        resources: [{ identifier: mcpResource, allowedScopes: [...MCP_SCOPES] }],
        // The seeded oauthResource row must track this config: token issuance
        // intersects requested scopes with the row's allowedScopes, so the
        // default insertOnly mode would freeze the scope list at first-boot —
        // every scope shipped later would be silently dropped from tokens.
        resourceSeedMode: "merge",
        clientRegistrationDefaultResources: [mcpResource],
        // MCP clients (Claude Code, Cursor) still self-register via RFC 7591.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // MCP clients omit application_type, which OIDC registration defaults
        // to web, yet register native callbacks: an http loopback (Claude
        // Code), or cursor://, https and loopback URIs together (Cursor, Grok
        // Bot). "infer" registers those as native, under the RFC 8252 rules.
        clientRegistrationDefaultApplicationType: "infer",
        // Access tokens are JWTs the API verifies offline, so revoking a grant
        // only bites at the next refresh; an hour bounds that window while a
        // client that cannot refresh still keeps a working session.
        accessTokenExpiresIn: 60 * 60,
        // How long a grant lasts is the user's pick at consent, enforced in
        // grantClaims; the provider's own refresh-token lifetime only has to
        // outlast "until I disconnect it".
        refreshTokenExpiresIn: 100 * 365 * 24 * 60 * 60,
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
        // An extension rather than customAccessTokenClaims: only the
        // extension input names the client, which the consent row is keyed by.
        extensions: [
          {
            claims: {
              accessToken: ({ user, referenceId, client }) =>
                grantClaims(db, user, referenceId, client.clientId),
            },
          },
        ],
      }),
    ],
    emailAndPassword: {
      enabled: true,
      // NIST floor: 8 with no composition rules — the signup form's strength
      // meter nudges toward longer, the server never blocks a valid 8+.
      minPasswordLength: 8,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_MINUTES * 60,
      // The receipt for a reset that went through: whoever holds the inbox
      // learns the password changed and can start a reset of their own.
      onPasswordReset: async ({ user }: { user: { email: string } }, request?: Request) => {
        if (!accountEmailFrom()) return;
        // Detached, language lookup included, so a slow lookup or a failed
        // send never delays or fails the reset; the other sessions are
        // already revoked when this runs.
        void accountMailLocale(db, user.email, request?.headers)
          .then((locale) =>
            sendAccountMail(buildPasswordChangedEmail({ to: user.email, locale }), mail),
          )
          .catch((error) => {
            console.error("password_changed email skipped", error);
          });
      },
      // A password sign-up gets no session until its address is verified;
      // an account from before this verifies at its next sign-in, where the
      // link is re-sent (sendOnSignIn). Gated like recovery: an instance
      // that cannot deliver the link cannot demand it.
      requireEmailVerification: emailVerificationEnabled(),
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
    ...(emailVerificationEnabled()
      ? {
          emailVerification: {
            sendVerificationEmail: async (
              data: { user: { email: string; name: string }; url: string },
              request?: Request,
            ) => {
              sendVerificationEmail(db, data, request, mail);
            },
            sendOnSignUp: true,
            sendOnSignIn: true,
            // No session from the link: whoever registered the address set
            // the password, and the address's real owner opening the link
            // must not land inside that account. They sign in — or reset the
            // password, which revokes the registrant's sessions.
            expiresIn: VERIFY_TOKEN_TTL_MINUTES * 60,
            afterEmailVerification: async (user, request) => {
              await enrollAccount(user, request?.headers);
            },
          },
        }
      : {}),
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
        "/send-verification-email": { window: 15 * 60, max: 3 },
        // Each sign-up mails a stranger's address with the registrant's name in it.
        "/sign-up/email": { window: 15 * 60, max: 10 },
        "/reset-password": { window: 15 * 60, max: 5 },
        "/reset-password/*": { window: 15 * 60, max: 5 },
        "/oauth2/register": { window: 15 * 60, max: 10 },
      },
    },
    // The provider's session endpoints for creating and editing clients: any
    // signed-in user could store consent-screen links that skip the
    // /oauth2/register checks in hooks.before. Clients here come only from
    // RFC 7591 registration.
    disabledPaths: ["/oauth2/create-client", "/oauth2/update-client"],
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
          // The account's language is the one its creating request reads in;
          // the dashboard and every account mail read it back from here on.
          // A creation with no request behind it stores none, and mail falls back.
          before: async (user, ctx) => {
            await assertSignupAllowed(db, signupOpen());
            const headers = ctx?.headers ?? ctx?.request?.headers;
            await assertPermanentAddress(db, user.email, "signup", headers);
            return { data: headers ? { ...user, locale: localeFromHeaders(headers) } : user };
          },
          // Runs after the row exists (after the adapter's transaction for a
          // social first sign-in). Social sign-ins arrive verified and enroll
          // here; a password sign-up enrolls from afterEmailVerification.
          // The sign-up's IP and browser are kept apart from the sessions,
          // which expire and go with the account.
          after: async (user, ctx) => {
            const headers = ctx?.headers ?? ctx?.request?.headers;
            await recordSignup(db, {
              userId: user.id,
              email: user.email,
              ip: headers
                ? forwardedClientIp(headers, {
                    cloud: isCloudDeployment(),
                    trustedProxies: trustedProxies(),
                  })
                : null,
              userAgent: headers?.get("user-agent") ?? null,
            });
            await enrollAccount(user, headers);
          },
        },
        update: {
          // Every path that changes an address writes it here.
          before: async (user, ctx) => {
            await assertPermanentAddress(
              db,
              user.email,
              "change",
              ctx?.headers ?? ctx?.request?.headers,
            );
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Refused here, ahead of the endpoint: thrown from inside user
        // creation, a 403 reads to better-auth as its own anti-enumeration
        // signal for an address already registered, and the caller is shown
        // "check your inbox" instead of the policy. The database hook below
        // still guards the paths that create users elsewhere (social sign-in).
        if (ctx.path === "/sign-up/email") {
          await assertSignupAllowed(db, signupOpen());
          assertPlainName(ctx.body, ctx.headers);
          await assertPermanentAddress(
            db,
            (ctx.body as { email?: unknown } | undefined)?.email,
            "signup",
            ctx.headers,
          );
          return;
        }
        if (ctx.path === "/update-user") {
          assertPlainName(ctx.body, ctx.headers);
          return;
        }
        // Expired grants end before the provider looks for a consent, and
        // every MCP connection gets a refresh token. A GET request carries
        // its parameters in the query, a form POST in the body.
        if (ctx.path === "/oauth2/authorize") {
          const clientId = ctx.query?.client_id ?? ctx.body?.client_id;
          if (typeof clientId === "string") await endExpiredGrants(db, clientId);
          const query = withOfflineAccess(ctx.query, mcpResource);
          const body = withOfflineAccess(ctx.body, mcpResource);
          if (!query && !body) return;
          return { context: { ...(query ? { query } : {}), ...(body ? { body } : {}) } };
        }
        // Refused before the provider records the consent, which the
        // lifetime is then stamped on (hooks.after).
        if (ctx.path === "/oauth2/consent") {
          const { accept, lifetime } = (ctx.body ?? {}) as { accept?: unknown; lifetime?: unknown };
          if (accept === true && !isGrantLifetime(lifetime)) {
            throw new APIError("BAD_REQUEST", {
              error: "invalid_request",
              error_description: `lifetime must be one of: ${Object.keys(GRANT_LIFETIME_DAYS).join(", ")}`,
            });
          }
          return;
        }
        if (ctx.path !== "/oauth2/register") return;
        const body = ctx.body as Record<string, unknown> | undefined;
        if (!body) return;
        if (JSON.stringify(body).length > MAX_REGISTRATION_JSON) {
          throw new APIError("BAD_REQUEST", {
            error: "invalid_client_metadata",
            error_description: "Client metadata is too large.",
          });
        }
        if (typeof body.client_name === "string") {
          body.client_name = Array.from(stripInvisible(body.client_name))
            .slice(0, CUSTOMER_TEXT_MAX)
            .join("")
            .trim();
        }
        const redirects = Array.isArray(body.redirect_uris)
          ? body.redirect_uris.filter((uri): uri is string => typeof uri === "string")
          : [];
        const unlisted = redirects.find(isUnlistedHostRedirect);
        if (unlisted) {
          throw new APIError("BAD_REQUEST", {
            error: "invalid_redirect_uri",
            error_description: `custom-scheme redirect URIs carry a host only for known apps: ${unlisted}`,
          });
        }
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
      }),
      // Registration persists a scope list (the client's own, or the server's
      // list as of that day) and authorization validates against it — which
      // would strand every registered MCP client with invalid_scope each time
      // a new scope ships. NULL defers to the live `scopes` config; per-user
      // consent remains the gate. drizzle/0007 does the same for clients
      // registered before this hook existed.
      after: createAuthMiddleware(async (ctx) => {
        // A new session carries the account's language to this browser, so
        // the dashboard reads in the language its mail is written in.
        const locale = ctx.context.newSession?.user.locale;
        if (isAppLocale(locale) && ctx.getCookie(LOCALE_COOKIE) !== locale) {
          ctx.setCookie(LOCALE_COOKIE, locale, {
            path: "/",
            maxAge: LOCALE_COOKIE_MAX_AGE,
            sameSite: "lax",
          });
        }
        if (ctx.path === "/oauth2/consent") {
          // In this order: the receipt reads the grant's end off the row.
          await recordGrantLifetime(ctx);
          await mailConsent(ctx);
          return;
        }
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
