import { isCloudDeployment } from "@millionsend/config";
import { createFixedWindowLimiter, forwardedClientIp, UPDATES_SOURCES } from "@millionsend/core";
import { getDb } from "@millionsend/db";
import { z } from "zod";
import { appBaseUrl } from "@/lib/api-base-url";
import { localeFromHeaders } from "@/server/locale";
import { trustedProxies } from "@/server/trusted-proxies";
import { requestUpdatesConfirmation } from "@/server/updates";

/**
 * Public opt-in for product updates: the /updates form on this instance and
 * the setup wizard of a self-hosted one (the operator's own, one-time
 * request — nothing on a self-hosted instance ever calls home by itself).
 * Sends a confirmation link and stores nothing until it is opened, so the
 * worst a stranger can do here is have one email sent to an address.
 * Any origin may post: the response carries no data and sets no cookie.
 */
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
const HOUR = 60 * 60 * 1000;
const perClient = createFixedWindowLimiter(5, HOUR);
const perInstance = createFixedWindowLimiter(200, HOUR);
// One address gets two confirmation mails an hour whoever asks; past that
// the request is acknowledged and nothing is sent, so nobody can have the
// account-mail domain bomb an inbox.
const perRecipient = createFixedWindowLimiter(2, HOUR);

const input = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  source: z.enum(UPDATES_SOURCES).default("updates"),
});

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(request: Request) {
  const form = (request.headers.get("content-type") ?? "").includes("form");
  const raw: unknown = form
    ? Object.fromEntries((await request.formData()).entries())
    : await request.json().catch(() => null);
  const parsed = input.safeParse(raw);
  const page = (query: string) => new URL(`/updates?${query}`, appBaseUrl());
  if (!parsed.success) {
    return form
      ? Response.redirect(page("error=invalid"), 303)
      : Response.json({ error: "invalid_email" }, { status: 422, headers: CORS });
  }
  const ip =
    forwardedClientIp(request.headers, {
      cloud: isCloudDeployment(),
      trustedProxies: trustedProxies(),
    }) ?? "unknown";
  if (perClient(ip) || perInstance("all")) {
    return form
      ? Response.redirect(page("error=rate"), 303)
      : Response.json({ error: "rate_limited" }, { status: 429, headers: CORS });
  }
  if (!perRecipient(parsed.data.email)) {
    await requestUpdatesConfirmation(getDb(), {
      ...parsed.data,
      locale: localeFromHeaders(request.headers),
    });
  }
  return form
    ? Response.redirect(page("sent=1"), 303)
    : Response.json({ ok: true }, { status: 202, headers: CORS });
}
