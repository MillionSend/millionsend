import { env, parseCommaList } from "@millionsend/config";

/** Under SKIP_ENV_VALIDATION the env proxy carries the raw string, not the parsed list. */
export function trustedProxies(): string[] {
  const raw: unknown = env.TRUSTED_PROXIES;
  if (Array.isArray(raw)) return raw;
  return parseCommaList(typeof raw === "string" ? raw : undefined) ?? ["127.0.0.1", "::1"];
}
