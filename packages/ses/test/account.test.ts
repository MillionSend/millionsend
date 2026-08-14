import { GetAccountCommand } from "@aws-sdk/client-sesv2";
import { describe, expect, it } from "vitest";
import { getAccountOverview, type SesAccountClient } from "../src/account.js";

function fakeClient(response: unknown) {
  const calls: object[] = [];
  const client: SesAccountClient = {
    async send(command) {
      calls.push(command);
      return response;
    },
  };
  return { client, calls };
}

describe("getAccountOverview", () => {
  it("maps GetAccount to the overview shape", async () => {
    const { client, calls } = fakeClient({
      SendingEnabled: true,
      ProductionAccessEnabled: true,
      SendQuota: { Max24HourSend: 50000, SentLast24Hours: 1234, MaxSendRate: 14 },
    });
    expect(await getAccountOverview(client)).toEqual({
      sendingEnabled: true,
      productionAccess: true,
      quota: { max24h: 50000, sentLast24h: 1234, maxSendRate: 14 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeInstanceOf(GetAccountCommand);
  });

  it("reports sandbox as productionAccess false", async () => {
    const { client } = fakeClient({
      SendingEnabled: true,
      ProductionAccessEnabled: false,
      SendQuota: { Max24HourSend: 200, SentLast24Hours: 0, MaxSendRate: 1 },
    });
    expect(await getAccountOverview(client)).toEqual({
      sendingEnabled: true,
      productionAccess: false,
      quota: { max24h: 200, sentLast24h: 0, maxSendRate: 1 },
    });
  });

  it("defaults missing fields to disabled/zero", async () => {
    const { client } = fakeClient({});
    expect(await getAccountOverview(client)).toEqual({
      sendingEnabled: false,
      productionAccess: false,
      quota: { max24h: 0, sentLast24h: 0, maxSendRate: 0 },
    });
  });
});
