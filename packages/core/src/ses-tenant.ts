import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull } from "drizzle-orm";
import { type AuditActor, recordAudit } from "./audit.js";

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

/** The customer-managed sending status a team's tenant follows: DISABLED while the team is suspended. */
export type TenantSendingStatus = "ENABLED" | "DISABLED";

export interface TenantStatusOutcome {
  status: TenantSendingStatus;
  /** Regions SES confirmed. */
  updated: string[];
  /** Regions whose call failed, by error name only: an AWS message carries ARNs and the account id. */
  failed: { region: string; error: string }[];
}

/**
 * Sets the team's SES tenant to DISABLED while the team is suspended and to
 * ENABLED otherwise, in every region the team has a domain in (a domain is
 * what creates the tenant there). The team is read at call time, so a late
 * retry applies the operator's latest decision. The SES call is injected
 * (core does not depend on the SES package) and one region's failure never
 * stops the others. Null when there is nothing to update.
 */
export async function syncTenantSendingStatus(
  db: Db,
  params: {
    teamId: string;
    setStatus: (region: string, status: TenantSendingStatus) => Promise<void>;
  },
): Promise<TenantStatusOutcome | null> {
  const [team] = await db
    .select({ suspendedAt: schema.teams.suspendedAt })
    .from(schema.teams)
    .where(eq(schema.teams.id, params.teamId));
  const domains = await db
    .selectDistinct({ region: schema.domains.region })
    .from(schema.domains)
    .where(eq(schema.domains.teamId, params.teamId))
    .orderBy(schema.domains.region);
  if (!team || domains.length === 0) return null;
  const status: TenantSendingStatus = team.suspendedAt ? "DISABLED" : "ENABLED";
  const results = await Promise.all(
    domains.map(async ({ region }) => {
      try {
        await params.setStatus(region, status);
        return { region, error: null };
      } catch (error) {
        console.warn(`ses tenant: ${status} failed for team ${params.teamId} in ${region}`, error);
        return { region, error: (error as { name?: string } | null)?.name ?? "Error" };
      }
    }),
  );
  return {
    status,
    updated: results.filter((r) => r.error === null).map((r) => r.region),
    failed: results.flatMap(({ region, error }) => (error === null ? [] : [{ region, error }])),
  };
}

/**
 * The audit row of one sync: the tenant updated everywhere, or failed
 * somewhere, which the caller has handed to the worker's tenant.status retry.
 */
export function recordTenantStatus(
  db: Db,
  params: { teamId: string; actor: AuditActor; outcome: TenantStatusOutcome },
): Promise<void> {
  const { outcome } = params;
  const failed = outcome.failed.length > 0;
  return recordAudit(db, {
    teamId: params.teamId,
    actor: params.actor,
    action: failed ? "team.ses_tenant_update_failed" : "team.ses_tenant_updated",
    target: { type: "team", id: params.teamId },
    metadata: {
      status: outcome.status,
      regions: outcome.updated.join(", "),
      ...(failed
        ? {
            failed: outcome.failed.map((f) => `${f.region} (${f.error})`).join(", "),
            retrying: true,
          }
        : {}),
    },
  });
}
