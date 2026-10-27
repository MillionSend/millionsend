import { createFixedWindowLimiter, UPDATES_SOURCES } from "@millionsend/core";
import { getDb } from "@millionsend/db";
import { z } from "zod";
import { appBaseUrl } from "@/lib/api-base-url";
import { localeFromHeaders } from "@/server/locale";
import { clientIp } from "@/server/trusted-proxies";
import { verifyTurnstile } from "@/server/turnstile";
import { requestUpdatesConfirmation } from "@/server/updates";

/**
 * Opt-in for product updates, posted by this instance's /updates form. No
 * CORS headers, so another site can't read an answer; its posts (a plain
 * form, or JSON sent as text/plain) still arrive, and where the instance
 * has Turnstile keys a post must carry the page widget's token
 * (cf-turnstile-response). Sends a confirmation link and stores nothing
 * until it is opened, so the worst a stranger can do here is have one email
 * sent to an address.
 */
const HOUR = 60 * 60 * 1000;
const perClient = createFixedWindowLimiter(5, HOUR);
const perInstance = createFixedWindowLimiter(20, HOUR);
// One address gets two confirmation mails an hour whoever asks; past that
// the request is acknowledged and nothing is sent, so nobody can have the
// account-mail domain bomb an inbox.
const perRecipient = createFixedWindowLimiter(2, HOUR);

const input = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  source: z.enum(UPDATES_SOURCES).default("updates"),
});

export async function POST(request: Request) {
  const form = (request.headers.get("content-type") ?? "").includes("form");
  const raw: unknown = form
    ? Object.fromEntries((await request.formData()).entries())
    : await request.json().catch(() => null);
  const parsed = input.safeParse(raw);
  // The form's round trip keeps its source, so a retry is tagged like the first try.
  const source = UPDATES_SOURCES.find((s) => s === (raw as { source?: unknown } | null)?.source);
  const back = source && source !== "updates" ? `&source=${source}` : "";
  const page = (query: string) => new URL(`/updates?${query}${back}`, appBaseUrl());
  if (!parsed.success) {
    return form
      ? Response.redirect(page("error=invalid"), 303)
      : Response.json({ error: "invalid_email" }, { status: 422 });
  }
  const rateLimited = () =>
    form
      ? Response.redirect(page("error=rate"), 303)
      : Response.json({ error: "rate_limited" }, { status: 429 });
  if (perClient(clientIp(request.headers) ?? "unknown")) return rateLimited();
  // Between the two limits: the client's own bounds the verifications one
  // client can cause, and a refused post never spends the instance's.
  const token = (raw as Record<string, unknown> | null)?.["cf-turnstile-response"];
  if (!(await verifyTurnstile(typeof token === "string" ? token : undefined))) {
    return form
      ? Response.redirect(page("error=captcha"), 303)
      : Response.json({ error: "captcha" }, { status: 403 });
  }
  if (perInstance("all")) return rateLimited();
  if (!perRecipient(parsed.data.email)) {
    await requestUpdatesConfirmation(getDb(), {
      ...parsed.data,
      locale: localeFromHeaders(request.headers),
    });
  }
  return form
    ? Response.redirect(page("sent=1"), 303)
    : Response.json({ ok: true }, { status: 202 });
}
