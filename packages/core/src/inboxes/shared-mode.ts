import type { MonitorSettings } from "../monitor-settings.js";
import { type Plan, paidPlan } from "../plans.js";

/** What a team's addresses on the shared inbox domain may send. */
export interface SharedSending {
  mode: "open" | "reply_only" | "receive_only";
  /** What holds the team below open: the instance's switches or its plan; null when open. */
  cause: "plan" | "instance" | null;
}

/**
 * The shared domain's sending mode for one team. Open sending needs both
 * operator switches, a configured judge with the auto-hold on (pre-SES
 * screening runs only then, and open mail is never unscreened) and a paid
 * plan, checked in that order so the instance is named whenever it is what
 * holds the team back. `plan` is the effective plan.
 */
export function sharedSendMode(p: {
  settings: Pick<MonitorSettings, "sharedInboxSend" | "sharedInboxOpen" | "autoHold">;
  plan: Plan;
  isCloud: boolean;
  judgeConfigured: boolean;
}): SharedSending {
  if (!p.settings.sharedInboxSend) return { mode: "receive_only", cause: "instance" };
  if (!p.settings.sharedInboxOpen || !p.judgeConfigured || !p.settings.autoHold) {
    return { mode: "reply_only", cause: "instance" };
  }
  if (!paidPlan(p.plan, p.isCloud)) return { mode: "reply_only", cause: "plan" };
  return { mode: "open", cause: null };
}
