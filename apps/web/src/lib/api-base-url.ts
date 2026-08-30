import { env } from "@millionsend/config";
import {
  apiBaseUrl as apiBaseUrlFor,
  mcpResourceUrl as mcpResourceUrlFor,
} from "@millionsend/core";

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
 * Public URL of this dashboard. Every absolute URL the app emits (redirects,
 * emailed links) must derive from it — never from the request's Host, which a
 * reverse proxy may rewrite to its upstream address.
 */
export function appBaseUrl(): string {
  return resolveBaseUrl(env.APP_BASE_URL);
}

/** Origin of {@link appBaseUrl}, for comparing against a request's Origin header. */
export function appOrigin(): string {
  return new URL(appBaseUrl()).origin;
}

export function apiBaseUrl(): string {
  return apiBaseUrlFor(env.APP_BASE_URL, env.PUBLIC_API_URL);
}

/** Canonical RFC 8707 resource identifier OAuth access tokens are bound to. */
export function mcpResourceUrl(): string {
  return mcpResourceUrlFor(env.APP_BASE_URL, env.PUBLIC_API_URL);
}
