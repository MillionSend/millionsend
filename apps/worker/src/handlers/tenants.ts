import { associateDomainTenant } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { provisionDomainTenant, type SesIdentityClient } from "@millionsend/ses";
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
