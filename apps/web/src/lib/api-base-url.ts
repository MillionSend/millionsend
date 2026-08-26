import { env } from "@millionsend/config";
import {
  apiBaseUrl as apiBaseUrlFor,
  mcpResourceUrl as mcpResourceUrlFor,
} from "@millionsend/core";

export function apiBaseUrl(): string {
  return apiBaseUrlFor(env.APP_BASE_URL);
}

/** Canonical RFC 8707 resource identifier OAuth access tokens are bound to. */
export function mcpResourceUrl(): string {
  return mcpResourceUrlFor(env.APP_BASE_URL);
}
