import { isCloudDeployment } from "@millionsend/config";
import { effectivePlan, type Plan, planCanHidePoweredBy } from "@millionsend/core";

/**
 * Whether "Powered by MillionSend" is forced onto the team's hosted
 * unsubscribe page: a free plan on the cloud. Self-host answers to nobody.
 */
export function poweredByLocked(team: { plan: Plan; currentPeriodEnd: Date | null }): boolean {
  return (
    isCloudDeployment() && !planCanHidePoweredBy(effectivePlan(team.plan, team.currentPeriodEnd))
  );
}
