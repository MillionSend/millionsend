import { isCloudDeployment } from "@millionsend/config";
import {
  escapeHtml,
  fetchTeamStanding,
  fillTemplate,
  linksDisabled,
  verifyClickToken,
} from "@millionsend/core";
import { type Db, getDb, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import en from "../../../../../messages/en/common.json";
import ptBR from "../../../../../messages/pt-BR/common.json";
import { localeFromHeaders } from "../../../../server/locale";
import { enqueueWebhookDeliveries } from "../../../../server/queue";
import { trackingHostIs } from "../../../../server/tracking-host";
import { engagementHit, recordEngagement, trackingKey } from "../../record";

const MESSAGES = { en: en.trackedLink, "pt-BR": ptBR.trackedLink } as const;

/**
 * Public click-tracking endpoint. The signed token IS the credential and it
 * carries the destination URL inside the signature, so the redirect can only
 * ever follow a URL WE signed at send time — a tampered or foreign token fails
 * verification and gets a 404, never an off-site redirect (no open redirect).
 *
 * The redirect also needs the sender to stand behind its mail still: while the
 * team's links are disabled (core linksDisabled) the reader gets a page saying
 * so, never the destination; with no team left to ask (a token from before the
 * team was signed whose email row aged out, or a deleted team) a page names
 * the destination's host and leaves the click to the reader.
 *
 * Reachable on any host: a domain's custom tracking subdomain is CNAME'd to the
 * app, so this handler serves the branded links too, each only for its own team.
 */
export async function GET(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const key = trackingKey();
  const parsed = key ? verifyClickToken(token, key) : null;
  // Only http(s) URLs are ever signed (link-tracking's isTrackableHref); this
  // guard keeps a malformed destination from reaching Response.redirect.
  if (!parsed || !/^https?:\/\//i.test(parsed.url) || !URL.canParse(parsed.url)) {
    return new Response(null, { status: 404 });
  }
  // The host a reader's click came in on, as the tracking edge names it.
  const trackingHost = request.headers.get("x-tracking-host")?.trim() || null;
  // SECURITY: the cloud mints a team's links only on its branded host (the
  // worker's requireBrandedHost), and every branded click reaches the app
  // through the tracking edge. A token that names its team and arrives
  // without the edge's header was built by hand on the app's own host:
  // refused, nothing recorded. A token from before links named their team
  // keeps the checks below, as mail already in inboxes may point it here.
  if (parsed.teamId && !trackingHost && isCloudDeployment()) {
    return new Response(null, { status: 404 });
  }

  const db = getDb();
  const teamId = await senderTeam(db, parsed.emailId, parsed.teamId);
  if (teamId && trackingHost && !(await hostServesTeam(db, trackingHost, teamId))) {
    return new Response(null, { status: 404 });
  }
  // Recorded whatever the page answers: the reader clicked either way.
  await recordEngagement(
    db,
    parsed.emailId,
    "clicked",
    enqueueWebhookDeliveries,
    engagementHit(request, parsed.url),
  );
  const standing = teamId ? await fetchTeamStanding(db, teamId) : null;
  if (standing && !linksDisabled(standing)) return Response.redirect(parsed.url, 302);
  return linkPage(request, standing ? null : new URL(parsed.url));
}

/**
 * The team on the email row, else the team the token signed once the row
 * has aged out; null when there is no team to ask.
 */
async function senderTeam(
  db: Db,
  emailId: string,
  signedTeamId: string | null,
): Promise<string | null> {
  // Non-uuid ids can't be minted by us, but a raw string must never reach a
  // uuid column — Postgres would 500 instead of answering.
  const uuid = z.uuid();
  const [email] = uuid.safeParse(emailId).success
    ? await db
        .select({ teamId: schema.emails.teamId })
        .from(schema.emails)
        .where(eq(schema.emails.id, emailId))
        .limit(1)
    : [];
  return email?.teamId ?? (uuid.safeParse(signedTeamId).success ? signedTeamId : null);
}

/**
 * SECURITY: a branded tracking host redirects only for the team holding its
 * domain; otherwise any team's token would redirect from another team's
 * domain. A host no team holds verified is not judged here.
 */
async function hostServesTeam(db: Db, host: string, teamId: string): Promise<boolean> {
  const holders = await db
    .select({ teamId: schema.domains.teamId })
    .from(schema.domains)
    .where(and(eq(schema.domains.status, "verified"), trackingHostIs(host)));
  return holders.length === 0 || holders.some((holder) => holder.teamId === teamId);
}

const STYLE = [
  ":root{color-scheme:dark light;background:#000;color:#f4f1ea;font:15px/1.5 system-ui,sans-serif}",
  "body{margin:0}",
  "main{box-sizing:border-box;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;text-align:center}",
  'h1{margin:0;font:500 28px/1.1 Georgia,"Times New Roman",serif;letter-spacing:-0.02em}',
  "p{margin:0;max-width:440px;color:#918f89}",
  "strong{color:#f4f1ea;overflow-wrap:anywhere}",
  "a{margin-top:8px;padding:8px 14px;border-radius:6px;background:#f4f1ea;color:#050505;font-weight:600;text-decoration:none;overflow-wrap:anywhere}",
  "@media (prefers-color-scheme:light){:root{background:#faf8f4;color:#21201c}p{color:#6e6c66}strong{color:#21201c}a{background:#21201c;color:#f4f1ea}}",
].join("");

/**
 * A click that does not redirect lands here. Self-contained: a branded host's
 * tracking edge proxies only /t/c and /t/o, so none of the app's stylesheets
 * would load beside it. No destination reads as disabled; one is named by its
 * host and linked on.
 */
function linkPage(request: Request, destination: URL | null): Response {
  const locale = localeFromHeaders(request.headers);
  const m = MESSAGES[locale];
  const title = escapeHtml(destination ? m.confirmTitle : m.disabledTitle);
  const host = destination ? escapeHtml(destination.host) : "";
  const body = destination
    ? `<p>${fillTemplate(escapeHtml(m.confirmBody), { host: `<strong>${host}</strong>` })}</p>` +
      `<a href="${escapeHtml(destination.href)}">${fillTemplate(escapeHtml(m.confirmCta), { host })}</a>`
    : `<p>${escapeHtml(m.disabledBody)}</p>`;
  return new Response(
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex"><title>${title}</title><style>${STYLE}</style>` +
      `</head><body><main><h1>${title}</h1>${body}</main></body></html>`,
    {
      status: destination ? 200 : 410,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
}
