import { env } from "@millionsend/config";
import { getDb, schema } from "@millionsend/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

export type Auth = ReturnType<typeof createAuth>;

function createAuth() {
  // env.ts leaves BETTER_AUTH_SECRET optional (api/worker don't need it);
  // the web process is the one that must refuse to run without it.
  if (!env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET is required to run the web app");
  }
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
    baseURL: env.APP_BASE_URL ?? "http://localhost:3000",
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
