import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull } from "drizzle-orm";

/**
 * Records that a domain's SES resources are associated with its team's tenant
 * (named by the team id): the send path starts passing TenantName, and the
 * backfill skips the row.
 */
export async function markDomainTenantAssociated(
  db: Db,
  params: { domainId: string; teamId: string; configurationSet?: string | undefined; now?: Date },
): Promise<void> {
  const now = params.now ?? new Date();
  await db
    .update(schema.domains)
    .set({ sesTenantAssociatedAt: now, sesTenantConfigSet: params.configurationSet ?? null })
    .where(eq(schema.domains.id, params.domainId));
  await db
    .update(schema.teams)
    .set({ sesTenantName: params.teamId })
    .where(and(eq(schema.teams.id, params.teamId), isNull(schema.teams.sesTenantName)));
}

/**
 * Runs the SES-side association (injected: core does not depend on the SES
 * package) and stamps the row on success. Best-effort by design: a failure
 * is logged and leaves the marker null, so domain creation never fails on it
 * and the hourly tenants.sync retries. Returns whether the row was stamped.
 */
export async function associateDomainTenant(
  db: Db,
  params: {
    domainId: string;
    teamId: string;
    name: string;
    region: string;
    /** The configuration set the provisioner associates; recorded on the row. */
    configurationSet?: string | undefined;
    provision: () => Promise<void>;
    now?: Date;
  },
): Promise<boolean> {
  try {
    await params.provision();
  } catch (error) {
    console.warn(
      `ses tenant: association failed for ${params.name} (${params.region}); tenants.sync retries hourly`,
      error,
    );
    return false;
  }
  await markDomainTenantAssociated(db, {
    domainId: params.domainId,
    teamId: params.teamId,
    configurationSet: params.configurationSet,
    ...(params.now ? { now: params.now } : {}),
  });
  return true;
}
