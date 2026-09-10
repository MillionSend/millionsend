import { type BillingStripe, createStripe } from "@millionsend/billing";
import { accountEmailFrom, env, notificationsEmailFrom } from "@millionsend/config";
import {
  claimNotification,
  listTeamOwners,
  type PlanSnapshot,
  planMove,
  QUOTA_COLUMNS,
  type QuotaTeamRow,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { buildAccountEmail, sendAccountMail } from "./system-mail";

export const BILLING_PATH = "/settings/billing";

let client: BillingStripe | undefined;

/** Process-wide Stripe client; only reached on cloud paths, where boot validation guarantees the key. */
export function getStripe(): BillingStripe {
  client ??= createStripe(env.STRIPE_SECRET_KEY ?? "");
  return client;
}

/** The team's billing columns, from which a send derives its cap (teamQuota). */
export async function fetchQuotaRow(db: Db, teamId: string): Promise<QuotaTeamRow> {
  const [row] = await db
    .select(QUOTA_COLUMNS)
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  return row;
}

/**
 * Mails a plan move to the team's owners, claimed with the key every surface
 * computes alike (the Stripe webhook, the dashboard's own plan change, the
 * daily reconcile), so whichever notices first is the one that speaks. True
 * when it did.
 */
export async function mailPlanMove(
  db: Db,
  team: { id: string; name: string },
  before: PlanSnapshot,
  after: PlanSnapshot,
): Promise<boolean> {
  const from = notificationsEmailFrom();
  const move = planMove(before, after);
  if (!from || !move) return false;
  const claimed = await claimNotification(db, {
    teamId: team.id,
    kind: move.kind,
    periodKey: move.periodKey,
  });
  if (!claimed) return false;
  for (const owner of await listTeamOwners(db, team.id, accountEmailFrom(), move.kind)) {
    sendAccountMail(
      buildAccountEmail({
        from,
        to: owner.email,
        kind: move.kind,
        locale: owner.locale,
        path: BILLING_PATH,
        values: move.values(owner.locale, team.name),
      }),
    );
  }
  return true;
}
