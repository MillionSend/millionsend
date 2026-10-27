import { env, isCloudDeployment, parseCommaList } from "@millionsend/config";
import { forwardedClientIp } from "@millionsend/core";

/** Under SKIP_ENV_VALIDATION the env proxy carries the raw string, not the parsed list. */
export function trustedProxies(): string[] {
  const raw: unknown = env.TRUSTED_PROXIES;
  if (Array.isArray(raw)) return raw;
  return parseCommaList(typeof raw === "string" ? raw : undefined) ?? ["127.0.0.1", "::1"];
}

/**
 * A request's client address as auth reads it (createAuth's
 * advanced.ipAddress): a sign-up is counted against the same address it is
 * recorded under. On the cloud it is the peer Cloudflare saw, never a
 * forwarded chain: only tracking links come through a proxy of ours (the
 * edge), and a request a Cloudflare Worker relays arrives from a Cloudflare
 * address with whatever x-forwarded-for its author wrote.
 */
export function clientIp(headers: { get(name: string): string | null }): string | null {
  const cloud = isCloudDeployment();
  return forwardedClientIp(headers, { cloud, trustedProxies: cloud ? [] : trustedProxies() });
}
