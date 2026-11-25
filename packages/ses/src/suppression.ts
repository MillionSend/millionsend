import { DeleteSuppressedDestinationCommand } from "@aws-sdk/client-sesv2";

export type SuppressionCommand = DeleteSuppressedDestinationCommand;

export interface SesSuppressionClient {
  send(command: SuppressionCommand): Promise<unknown>;
}

/**
 * Drops `address` from the region's account-level suppression list (no
 * TenantName, so not a tenant's list). SES matches the address
 * case-sensitively. An address that was not listed reads as done.
 */
export async function deleteAccountSuppression(
  client: SesSuppressionClient,
  address: string,
): Promise<"removed" | "absent"> {
  try {
    await client.send(new DeleteSuppressedDestinationCommand({ EmailAddress: address }));
    return "removed";
  } catch (error) {
    if ((error as { name?: string }).name === "NotFoundException") return "absent";
    throw error;
  }
}
