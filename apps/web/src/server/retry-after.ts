import { TRPCError } from "@trpc/server";

/** A refusal's cause when it knows when to try again: the tRPC route sends it as retry-after. */
export class RetryAfter extends Error {
  constructor(readonly seconds: number) {
    super(`retry after ${seconds}s`);
  }
}

/** A TOO_MANY_REQUESTS refusal that says when the caller may try again. */
export function tooManyRequests(retryAfterSec: number, message?: string): TRPCError {
  return new TRPCError({
    code: "TOO_MANY_REQUESTS",
    ...(message !== undefined ? { message } : {}),
    cause: new RetryAfter(retryAfterSec),
  });
}

/** The seconds a refusal asks the caller to wait, when it says. */
export function retryAfterSecOf(error: TRPCError): number | undefined {
  return error.cause instanceof RetryAfter ? error.cause.seconds : undefined;
}

/**
 * Better Auth's own limiter answers 429 with only the nonstandard
 * X-Retry-After; clients, SDKs and proxies read retry-after.
 */
export function withStandardRetryAfter(res: Response): Response {
  const seconds = res.status === 429 ? res.headers.get("x-retry-after") : null;
  if (seconds && !res.headers.has("retry-after")) res.headers.set("retry-after", seconds);
  return res;
}
