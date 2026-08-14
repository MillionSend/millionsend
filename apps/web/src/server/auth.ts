import { env } from "@millionsend/config";
import { type Db, getDb, schema } from "@millionsend/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";

export type Auth = ReturnType<typeof createAuth>;

/**
 * Better Auth rejects sign-ins from any origin outside its trusted set, so a
 * production deploy that silently fell back to localhost:3000 would 403 every
 * sign-in with nothing flagging the misconfiguration. Fail loudly instead;
 * the localhost default is for development only.
 */
/**
 * Unset APP_BASE_URL must never block the localhost quickstart (the Docker
 * image always runs NODE_ENV=production), so the default applies everywhere
 * and the real-host trap — sign-in silently rejected from any other origin —
 * is covered by one loud log line naming the variable instead.
 */
export function resolveBaseUrl(appBaseUrl: string | undefined): string {
  if (appBaseUrl) return appBaseUrl;
  console.warn(
    "APP_BASE_URL is not set: sign-in is only accepted from http://localhost:3000. Set APP_BASE_URL when deploying to a real host.",
  );
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

function createAuth() {
  // env.ts leaves BETTER_AUTH_SECRET optional (api/worker don't need it);
  // the web process is the one that must refuse to run without it.
  if (!env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET is required to run the web app");
  }
  const baseURL = resolveBaseUrl(env.APP_BASE_URL);
  return betterAuth({
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    emailAndPassword: { enabled: true },
    secret: env.BETTER_AUTH_SECRET,
    baseURL,
    ...(env.APP_BASE_URL ? { trustedOrigins: [env.APP_BASE_URL] } : {}),
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            await assertSignupAllowed(getDb(), env.ALLOW_SIGNUP);
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
