import { accountMailPhrase, errorSummary } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { mailOperator, type SystemMailer } from "../system-mail.js";

/**
 * One mail to the operator per new link between a team and a team
 * suspended for phishing. It names the kinds of evidence only: the values
 * (sender names, subjects, phone numbers) stay in the console, so our own
 * mail never carries a phisher's words. Claimed before it is sent, so two
 * workers never both mail; a send that fails is logged, not retried.
 */
export async function alertLinkedTeams(
  db: Db,
  deps: { mailer: SystemMailer; appBaseUrl?: string | undefined; now?: Date },
): Promise<number> {
  const l = schema.teamLinks;
  const pending = await db
    .select({
      teamId: l.teamId,
      team: schema.teams.name,
      linkedTeamId: l.linkedTeamId,
      linkedTeamName: l.linkedTeamName,
      matches: l.matches,
      held: l.held,
    })
    .from(l)
    .innerJoin(schema.teams, eq(schema.teams.id, l.teamId))
    .where(isNull(l.alertedAt))
    .orderBy(asc(l.createdAt));
  let sent = 0;
  for (const link of pending) {
    const [claimed] = await db
      .update(l)
      .set({ alertedAt: deps.now ?? new Date() })
      .where(
        and(eq(l.teamId, link.teamId), eq(l.linkedTeamId, link.linkedTeamId), isNull(l.alertedAt)),
      )
      .returning({ teamId: l.teamId });
    if (!claimed) continue;
    const kinds = [...new Set(link.matches.map((match) => match.kind))];
    try {
      const mailed = await mailOperator(
        db,
        deps.mailer,
        "monitor.team_linked",
        `/console/safety/${link.teamId}`,
        (locale) => ({
          team: link.team,
          linked: link.linkedTeamName,
          matches: new Intl.ListFormat(locale, { type: "conjunction" }).format(
            kinds.map((kind) =>
              accountMailPhrase({ locale, kind: "monitor.team_linked", key: kind }),
            ),
          ),
          held: accountMailPhrase({
            locale,
            kind: "monitor.team_linked",
            key: link.held ? "held" : "notHeld",
          }),
        }),
        deps.appBaseUrl,
      );
      if (mailed) sent += 1;
    } catch (err) {
      console.error(`linkage: operator mail for team ${link.teamId} failed: ${errorSummary(err)}`);
    }
  }
  return sent;
}
