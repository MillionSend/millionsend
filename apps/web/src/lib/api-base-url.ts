import { env } from "@millionsend/config";

// ponytail: assumes the API listens on port 3001 of the dashboard host (the
// docker-compose default). Add a dedicated public-API-URL env when a reverse
// proxy serves the API elsewhere.
export function apiBaseUrl(): string {
  const url = new URL(env.APP_BASE_URL ?? "http://localhost:3000");
  return `${url.protocol}//${url.hostname}:3001`;
}
