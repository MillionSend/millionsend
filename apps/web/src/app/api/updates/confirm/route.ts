import { getDb } from "@millionsend/db";
import { appBaseUrl } from "@/lib/api-base-url";
import { localeFromHeaders } from "@/server/locale";
import { confirmUpdatesSubscription } from "@/server/updates";

/** The confirm button on /updates/confirm: the one request that creates the contact. */
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const token = form?.get("token");
  const confirmed =
    typeof token === "string" && token
      ? await confirmUpdatesSubscription(getDb(), token, localeFromHeaders(request.headers))
      : null;
  return Response.redirect(
    new URL(confirmed ? "/updates/confirm?done=1" : "/updates/confirm?error=1", appBaseUrl()),
    303,
  );
}
