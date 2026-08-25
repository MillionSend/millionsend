import { env } from "@millionsend/config";
import { type Db, getDb, schema } from "@millionsend/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
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
      },
    }),
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
