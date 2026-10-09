import {
  associateDomainTenant,
  isTeamSuspended,
  recordAudit,
  recordTenantStatus,
  syncTenantSendingStatus,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import {
  provisionDomainTenant,
  type SesIdentityClient,
  type SesTenantClient,
  setTenantSendingStatus,
} from "@millionsend/ses";
import { asc, isNull, or, sql } from "drizzle-orm";

export interface SyncTenantsDeps {
  clientForRegion: (region: string) => SesIdentityClient;
  /** The shared configuration set every send names; associated with each tenant. */
  configurationSet?: string | undefined;
  enabled: boolean;
  now?: Date;
}

/**
 * Hourly backfill: every domain not yet associated with its team's SES tenant
 * (rows created before tenants existed, or whose create-time association
 * failed), and every domain associated with a configuration set other than
 * the one in force now (SES_CONFIGURATION_SET changed after association — a
 * tenant send would name an unassociated set and be rejected), gets the
 * tenant created/adopted and its resources associated, then the marker
 * stamped. One domain's failure never blocks the rest.
 */
export async function syncTenants(
  db: Db,
  deps: SyncTenantsDeps,
): Promise<{ associated: number; failed: number }> {
  if (!deps.enabled) return { associated: 0, failed: 0 };
  const d = schema.domains;
  const pending = await db
    .select({ id: d.id, teamId: d.teamId, name: d.name, region: d.region })
    .from(d)
    .where(
      or(
        isNull(d.sesTenantAssociatedAt),
        sql`${d.sesTenantConfigSet} is distinct from ${deps.configurationSet ?? null}`,
      ),
    )
    .orderBy(asc(d.createdAt));
  let associated = 0;
  for (const domain of pending) {
    const ok = await associateDomainTenant(db, {
      domainId: domain.id,
      teamId: domain.teamId,
      name: domain.name,
      region: domain.region,
      configurationSet: deps.configurationSet,
      ...(deps.now ? { now: deps.now } : {}),
      provision: () =>
        provisionDomainTenant(deps.clientForRegion(domain.region), {
          teamId: domain.teamId,
          region: domain.region,
          domain: domain.name,
          configurationSet: deps.configurationSet,
        }),
    });
    if (ok) associated += 1;
  }
  return { associated, failed: pending.length - associated };
}

export interface TenantStatusDeps {
  clientForRegion: (region: string) => SesTenantClient;
  enabled: boolean;
}

/**
 * The tenant.status job: a team's tenant status the console could not set.
 * Throws while any region still fails, so pg-boss backs off and runs it
 * again; the audit row lands once SES has taken every region.
 */
export async function retryTenantStatus(
  db: Db,
  deps: TenantStatusDeps,
  teamId: string,
): Promise<void> {
  if (!deps.enabled) return;
  const outcome = await syncTenantSendingStatus(db, {
    teamId,
    setStatus: (region, status) =>
      setTenantSendingStatus(deps.clientForRegion(region), { tenantName: teamId, status }),
  });
  if (!outcome) return;
  if (outcome.failed.length > 0) {
    throw new Error(
      `tenant.status: ${outcome.status} still failing for team ${teamId} in ${outcome.failed.map((f) => f.region).join(", ")}`,
    );
  }
  // A suspend or reinstate that lands while these calls are in flight can be
  // overwritten by this run's older status; running again applies the newer one.
  if ((await isTeamSuspended(db, teamId)) !== (outcome.status === "DISABLED")) {
    throw new Error(
      `tenant.status: team ${teamId}'s standing changed mid-update; applying it again`,
    );
  }
  await recordTenantStatus(db, { teamId, actor: "system", outcome });
}

/** Retries exhausted: the team's audit says so; each attempt's AWS error is in the logs. */
export async function abandonTenantStatus(db: Db, teamId: string): Promise<void> {
  await recordAudit(db, {
    teamId,
    actor: "system",
    action: "team.ses_tenant_update_failed",
    target: { type: "team", id: teamId },
    metadata: { retrying: false },
  });
  console.error(
    `tenant.status: gave up on team ${teamId}; set its SES tenant status by hand once the cause is fixed`,
  );
}
