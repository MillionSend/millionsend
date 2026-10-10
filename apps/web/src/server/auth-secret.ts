import { env } from "@millionsend/config";
import { TRPCError } from "@trpc/server";

/** BETTER_AUTH_SECRET, which the web app cannot run without. */
export function requireAuthSecret(): string {
  if (!env.BETTER_AUTH_SECRET) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "BETTER_AUTH_SECRET is required",
    });
  }
  return env.BETTER_AUTH_SECRET;
}
