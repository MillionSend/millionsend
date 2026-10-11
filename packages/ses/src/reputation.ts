import {
  CloudWatchClient,
  GetMetricDataCommand,
  type GetMetricDataCommandOutput,
} from "@aws-sdk/client-cloudwatch";
import { PROBE_REQUEST_HANDLER } from "./account.js";

/** Structural subset of CloudWatchClient so callers inject a fake in tests. */
export interface SesReputationClient {
  send(command: GetMetricDataCommand): Promise<unknown>;
}

/** CloudWatch in one region: SES publishes each region's reputation metrics there. */
export function createSesReputationClient(options: {
  region: string;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
}): SesReputationClient {
  const { region, accessKeyId, secretAccessKey } = options;
  return new CloudWatchClient({
    region,
    requestHandler: PROBE_REQUEST_HANDLER,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
}

// SES publishes a reading only while it has a rate for the account; the
// newest one stands until the next, so a quiet week still has a rate.
const LOOKBACK_MS = 7 * 24 * 3_600_000;

/**
 * SES's own complaint rate for the account in the client's region, as a
 * fraction: Reputation.ComplaintRate, the rate behind SES's review and pause
 * lines. It counts only the mailbox providers that report complaints, so it
 * runs well above a count over all mail. Null when SES published none in the
 * last week.
 */
export async function getSesComplaintRate(
  client: SesReputationClient,
  now: Date = new Date(),
): Promise<number | null> {
  const out = (await client.send(
    new GetMetricDataCommand({
      StartTime: new Date(now.getTime() - LOOKBACK_MS),
      EndTime: now,
      ScanBy: "TimestampDescending",
      MetricDataQueries: [
        {
          Id: "complaints",
          MetricStat: {
            Metric: { Namespace: "AWS/SES", MetricName: "Reputation.ComplaintRate" },
            Period: 3_600,
            Stat: "Average",
          },
        },
      ],
    }),
  )) as GetMetricDataCommandOutput;
  return out.MetricDataResults?.[0]?.Values?.[0] ?? null;
}
