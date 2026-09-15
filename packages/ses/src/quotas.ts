import {
  RequestServiceQuotaIncreaseCommand,
  ServiceQuotasClient,
} from "@aws-sdk/client-service-quotas";

/** Service Quotas code of SES "Sending quota" — emails per 24 hours, per region. */
export const SES_DAILY_QUOTA_CODE = "L-804C8AE8";

/** Structural subset of ServiceQuotasClient so tests inject a fake. */
export interface QuotaRequestClient {
  send(command: RequestServiceQuotaIncreaseCommand): Promise<unknown>;
}

export function createQuotaRequestClient(options: {
  region: string;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
}): QuotaRequestClient {
  const { region, accessKeyId, secretAccessKey } = options;
  return new ServiceQuotasClient({
    region,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
}

export type QuotaRequestResult =
  | { ok: true; requestId: string | null; status: string | null }
  | { ok: false; kind: "access_denied" | "error"; message: string };

/**
 * Files a raise of the SES daily sending quota. AWS auto-approves small
 * steps and opens a support case for the rest; an IAM policy without
 * servicequotas:RequestServiceQuotaIncrease comes back as access_denied so
 * the caller can fall back to the copyable request text.
 */
export async function requestSesDailyQuota(
  client: QuotaRequestClient,
  desired: number,
): Promise<QuotaRequestResult> {
  try {
    const out = (await client.send(
      new RequestServiceQuotaIncreaseCommand({
        ServiceCode: "ses",
        QuotaCode: SES_DAILY_QUOTA_CODE,
        DesiredValue: desired,
      }),
    )) as { RequestedQuota?: { Id?: string; Status?: string } };
    return {
      ok: true,
      requestId: out.RequestedQuota?.Id ?? null,
      status: out.RequestedQuota?.Status ?? null,
    };
  } catch (err) {
    const name = (err as { name?: string }).name ?? "";
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      kind: /AccessDenied|UnrecognizedClient|InvalidSignature|NoAccess/i.test(`${name} ${message}`)
        ? "access_denied"
        : "error",
      message,
    };
  }
}
