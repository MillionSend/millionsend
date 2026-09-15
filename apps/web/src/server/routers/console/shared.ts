import { accountEmailFrom } from "@millionsend/config";
import {
  type AccountMailKind,
  type AuditAction,
  listTeamOwners,
  type MailLocale,
  recordAudit,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { buildAccountEmail, sendAccountMail } from "../../system-mail";

/** What every console action has: the database and the operator behind it. */
export interface OperatorCtx {
  db: Db;
  operator: { id: string; email: string };
}

/** One audit row for an operator action on a team (or the instance when teamId is null). */
export function auditOperator(
  ctx: OperatorCtx,
  event: {
    teamId: string | null;
    action: AuditAction;
    target?: { type: string; id: string };
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  return recordAudit(ctx.db, { ...event, actor: { userId: ctx.operator.id } });
}

/** The team row an action targets; NOT_FOUND when there is none. */
export async function loadTeam(db: Db, teamId: string) {
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  if (!team) throw new TRPCError({ code: "NOT_FOUND" });
  return team;
}

/**
 * One account mail to every owner of the team, in their own language, sent
 * without holding the request (sendAccountMail logs a failure and moves on).
 */
export async function mailTeamOwners(
  db: Db,
  team: { id: string; name: string },
  kind: AccountMailKind,
  path: string,
  values: (locale: MailLocale) => Record<string, string>,
): Promise<void> {
  const owners = await listTeamOwners(db, team.id, accountEmailFrom(), kind);
  for (const owner of owners) {
    sendAccountMail(
      buildAccountEmail({
        to: owner.email,
        kind,
        locale: owner.locale,
        path,
        values: { team: team.name, ...values(owner.locale) },
      }),
    );
  }
}
