import { verifyClickToken } from "@millionsend/core";
import { getDb } from "@millionsend/db";
import { enqueueWebhookDeliveries } from "../../../../server/queue";
import { recordEngagement, trackingKey } from "../../record";

/**
 * Public click-tracking endpoint. The signed token IS the credential and it
 * carries the destination URL inside the signature, so the redirect can only
 * ever follow a URL WE signed at send time — a tampered or foreign token fails
 * verification and gets a 404, never an off-site redirect (no open redirect).
 *
 * Reachable on any host: a domain's custom tracking subdomain is CNAME'd to the
 * app, so this handler serves the branded links too.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const key = trackingKey();
  const parsed = key ? verifyClickToken(token, key) : null;
  // Only http(s) URLs are ever signed (link-tracking's isTrackableHref); this
  // guard keeps a malformed destination from reaching Response.redirect.
  if (!parsed || !/^https?:\/\//i.test(parsed.url)) return new Response(null, { status: 404 });

  // data mirrors the SES click payload shape ({ click: { link } }) so one
  // extractor serves both ingestion paths on the email detail page.
  await recordEngagement(getDb(), parsed.emailId, "clicked", enqueueWebhookDeliveries, {
    click: { link: parsed.url },
  });
  return Response.redirect(parsed.url, 302);
}
