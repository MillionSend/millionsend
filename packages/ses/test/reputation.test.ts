import { GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { describe, expect, it } from "vitest";
import { getSesComplaintRate, type SesReputationClient } from "../src/reputation.js";

function fakeClient(response: unknown) {
  const calls: GetMetricDataCommand[] = [];
  const client: SesReputationClient = {
    async send(command) {
      calls.push(command);
      return response;
    },
  };
  return { client, calls };
}

const NOW = new Date("2026-10-11T12:00:00Z");

describe("getSesComplaintRate", () => {
  it("reads the newest hourly Reputation.ComplaintRate of the last week", async () => {
    const { client, calls } = fakeClient({
      MetricDataResults: [
        {
          Id: "complaints",
          // Newest first, as ScanBy TimestampDescending returns them.
          Timestamps: [new Date("2026-10-11T11:00:00Z"), new Date("2026-10-11T10:00:00Z")],
          Values: [0.0025, 0.0033],
          StatusCode: "Complete",
        },
      ],
    });
    expect(await getSesComplaintRate(client, NOW)).toBe(0.0025);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeInstanceOf(GetMetricDataCommand);
    expect(calls[0]?.input).toEqual({
      StartTime: new Date("2026-10-04T12:00:00Z"),
      EndTime: NOW,
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
    });
  });

  it("is null when SES published no reading", async () => {
    expect(
      await getSesComplaintRate(
        fakeClient({ MetricDataResults: [{ Id: "complaints", Timestamps: [], Values: [] }] })
          .client,
        NOW,
      ),
    ).toBeNull();
    expect(await getSesComplaintRate(fakeClient({}).client, NOW)).toBeNull();
  });
});
