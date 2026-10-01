import { supportViewEnabled } from "@millionsend/config";
import { findLiveSupportView } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { httpOrigin } from "@/lib/http-url";
import { uploadsEnabled } from "./storage";

/**
 * Names the grant of a live support view. Like the team cookie it selects
 * nothing on its own: the grant must be the session user's and still live,
 * re-checked on every request, or the cookie is ignored.
 */
export const SUPPORT_VIEW_COOKIE = "ms_support_view";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SupportViewSession {
  grantId: string;
  teamId: string;
  teamName: string;
  logoUrl: string | null;
  expiresAt: Date;
}

/**
 * An event's data as a support view sees it. A click's link is a URL out of
 * the sent body, and its path or query can carry a reset or sign-in token, so
 * only its origin is kept.
 */
export function supportViewEventData<T>(data: T): T {
  if (typeof data !== "object" || data === null || !("click" in data)) return data;
  const { click } = data;
  if (typeof click !== "object" || click === null || !("link" in click)) return data;
  const { link, ...rest } = click;
  const origin = typeof link === "string" ? httpOrigin(link) : null;
  return { ...data, click: origin ? { ...rest, link: origin } : rest } as T;
}

/**
 * The view a request runs under, or null. The ONLY place the cookie is
 * read: the tRPC context, the dashboard layout and the export route all
 * resolve it here. A malformed, foreign, ended or expired id is "no view",
 * never an error, and the feature being off reads the same way.
 */
export async function resolveSupportView(
  db: Db,
  userId: string,
  cookieValue: string | undefined,
): Promise<SupportViewSession | null> {
  if (!cookieValue || !UUID.test(cookieValue) || !supportViewEnabled()) return null;
  const grant = await findLiveSupportView(db, cookieValue, userId);
  if (!grant) return null;
  const [team] = await db
    .select({ name: schema.teams.name, logoUrl: schema.teams.logoUrl })
    .from(schema.teams)
    .where(eq(schema.teams.id, grant.teamId));
  if (!team) return null;
  return {
    grantId: grant.id,
    teamId: grant.teamId,
    teamName: team.name,
    logoUrl: uploadsEnabled() ? team.logoUrl : null,
    expiresAt: grant.expiresAt,
  };
}
