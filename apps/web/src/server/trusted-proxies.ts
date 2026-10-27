import { env, isCloudDeployment, parseCommaList } from "@millionsend/config";
import { forwardedClientIp } from "@millionsend/core";

/** Under SKIP_ENV_VALIDATION the env proxy carries the raw string, not the parsed list. */
export function trustedProxies(): string[] {
  const raw: unknown = env.TRUSTED_PROXIES;
  if (Array.isArray(raw)) return raw;
  return parseCommaList(typeof raw === "string" ? raw : undefined) ?? ["127.0.0.1", "::1"];
}

/**
 * A request's client address, the one way the web app reads it: a sign-up
 * is counted against the same address it is recorded under.
 */
export function clientIp(headers: { get(name: string): string | null }): string | null {
  return forwardedClientIp(headers, {
    cloud: isCloudDeployment(),
    trustedProxies: trustedProxies(),
  });
}
