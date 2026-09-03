import {
  CreateTenantCommand,
  type CreateTenantCommandOutput,
  CreateTenantResourceAssociationCommand,
  DeleteTenantCommand,
  DeleteTenantResourceAssociationCommand,
  GetTenantCommand,
  type GetTenantCommandOutput,
} from "@aws-sdk/client-sesv2";

/**
 * SES tenant management: one tenant per team so SES tracks reputation and
 * suppression per customer instead of per account. A send that names a
 * tenant only succeeds when its identity AND configuration set are
 * associated with it, so association is a precondition, not a nicety.
 *
 * Reputation policies are not attached here: SES-managed defaults apply to
 * each identity. UpdateReputationEntityPolicy on the identity ARN is the
 * follow-up if a stricter per-customer policy is wanted.
 */

export type TenantCommand =
  | CreateTenantCommand
  | GetTenantCommand
  | DeleteTenantCommand
  | CreateTenantResourceAssociationCommand
  | DeleteTenantResourceAssociationCommand;

export interface SesTenantClient {
  send(command: TenantCommand): Promise<unknown>;
}

const errorName = (error: unknown): string | undefined => (error as { name?: string }).name;

/** Account id is the 5th segment of any SES ARN: arn:aws:ses:<region>:<account>:… */
function accountIdFromArn(arn: string | undefined): string {
  const accountId = arn?.split(":")[4];
  if (!accountId) throw new Error("SES tenant response carried no ARN");
  return accountId;
}

export const identityArn = (region: string, accountId: string, identity: string): string =>
  `arn:aws:ses:${region}:${accountId}:identity/${identity}`;
export const configurationSetArn = (region: string, accountId: string, name: string): string =>
  `arn:aws:ses:${region}:${accountId}:configuration-set/${name}`;

/** Creates the tenant, or adopts the existing one; either way returns the account id. */
export async function ensureTenant(
  client: SesTenantClient,
  params: { tenantName: string },
): Promise<{ accountId: string }> {
  try {
    const out = (await client.send(
      new CreateTenantCommand({ TenantName: params.tenantName }),
    )) as CreateTenantCommandOutput;
    return { accountId: accountIdFromArn(out.TenantArn) };
  } catch (error) {
    if (errorName(error) !== "AlreadyExistsException") throw error;
    const out = (await client.send(
      new GetTenantCommand({ TenantName: params.tenantName }),
    )) as GetTenantCommandOutput;
    return { accountId: accountIdFromArn(out.Tenant?.TenantArn) };
  }
}

/** Associates the domain identity and (when set) the shared configuration set. */
export async function associateTenantResources(
  client: SesTenantClient,
  params: {
    tenantName: string;
    accountId: string;
    region: string;
    identity: string;
    configurationSet?: string | undefined;
  },
): Promise<void> {
  const arns = [
    identityArn(params.region, params.accountId, params.identity),
    ...(params.configurationSet
      ? [configurationSetArn(params.region, params.accountId, params.configurationSet)]
      : []),
  ];
  for (const ResourceArn of arns) {
    try {
      await client.send(
        new CreateTenantResourceAssociationCommand({ TenantName: params.tenantName, ResourceArn }),
      );
    } catch (error) {
      if (errorName(error) !== "AlreadyExistsException") throw error;
    }
  }
}

/** ensureTenant + associateTenantResources for one domain of one team. */
export async function provisionDomainTenant(
  client: SesTenantClient,
  params: { teamId: string; region: string; domain: string; configurationSet?: string | undefined },
): Promise<void> {
  const { accountId } = await ensureTenant(client, { tenantName: params.teamId });
  await associateTenantResources(client, {
    tenantName: params.teamId,
    accountId,
    region: params.region,
    identity: params.domain,
    configurationSet: params.configurationSet,
  });
}

/** Drops the identity's association; a tenant or association already gone is fine. */
export async function disassociateIdentity(
  client: SesTenantClient,
  params: { tenantName: string; region: string; identity: string },
): Promise<void> {
  try {
    const out = (await client.send(
      new GetTenantCommand({ TenantName: params.tenantName }),
    )) as GetTenantCommandOutput;
    await client.send(
      new DeleteTenantResourceAssociationCommand({
        TenantName: params.tenantName,
        ResourceArn: identityArn(
          params.region,
          accountIdFromArn(out.Tenant?.TenantArn),
          params.identity,
        ),
      }),
    );
  } catch (error) {
    if (errorName(error) !== "NotFoundException") throw error;
  }
}

export async function deleteTenant(
  client: SesTenantClient,
  params: { tenantName: string },
): Promise<void> {
  try {
    await client.send(new DeleteTenantCommand({ TenantName: params.tenantName }));
  } catch (error) {
    if (errorName(error) !== "NotFoundException") throw error;
  }
}
