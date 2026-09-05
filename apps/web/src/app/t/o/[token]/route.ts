import { verifyOpenToken } from "@millionsend/core";
import { getDb } from "@millionsend/db";
import { enqueueWebhookDeliveries } from "../../../../server/queue";
import { engagementHit, recordEngagement, trackingKey } from "../../record";

// 1x1 transparent GIF — the smallest valid image an email client will render.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/**
 * Public open-tracking endpoint. Verifies the signed open token and records
 * the fetch — as an open, or as a prefetch when a machine plausibly made it —
 * then always returns the pixel: an invalid/tampered token gets the same
 * blank 1x1 GIF silently (never an error a mail client would surface).
 * Reachable on any host, like the click endpoint.
 */
export async function GET(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const key = trackingKey();
  const parsed = key ? verifyOpenToken(token, key) : null;
  if (parsed) {
    await recordEngagement(
      getDb(),
      parsed.emailId,
      "opened",
      enqueueWebhookDeliveries,
      engagementHit(request),
    );
  }

  return new Response(PIXEL, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL.length),
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
    },
  });
}
