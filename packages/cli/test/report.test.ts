import { describe, expect, it } from "vitest";
import { printSummary, type Report, renderReportMd } from "../src/report.js";

const HOSTILE = "News\x1b]52;c;cHduZWQ=\x07\x1b[2J\x1b[31m";

const report: Report = {
  version: 1,
  finishedAt: "2026-09-01T00:00:00.000Z",
  source: "resend",
  sourceLabel: "Resend",
  target: { baseUrl: "https://api.millionsend.com", cloud: true, plan: "free" },
  counts: {},
  sourceReadOnly: true,
  freshWebhookSecrets: [],
  checklist: { done: [], left: [`review ${HOSTILE}`] },
  dns: [
    {
      domain: `example.com${HOSTILE}`,
      records: [
        { record: "DKIM", name: `resend._domainkey${HOSTILE}`, type: "TXT", value: HOSTILE },
      ],
    },
  ],
  apiKeys: [HOSTILE],
  manual: [{ title: `topics/${HOSTILE}`, detail: HOSTILE }],
  failures: [{ resource: "topics", key: HOSTILE, message: HOSTILE }],
  offer: {
    emailsLast30Days: 1,
    perDay: 1,
    domains: 1,
    plan: "free",
    fits: "free",
    url: "https://x",
    text: [HOSTILE],
  },
  trademark: "tm",
};

describe("printSummary / renderReportMd", () => {
  it("never let source-controlled text carry control sequences", async () => {
    const chunks: string[] = [];
    await printSummary({ write: (c: string) => chunks.push(String(c)) } as never, report);
    const text = chunks.join("");
    expect(text).toContain("  ! topics/News — News\n");
    expect(text).toContain("  ✗ topics/News — News\n");
    expect(text).toContain("resend._domainkeyNews");
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\x07");
    const md = renderReportMd(report);
    expect(md).toContain("- topics/News — News");
    expect(md).toContain("- News");
    expect(md).not.toContain("\x1b");
    expect(md).not.toContain("\x07");
  });
});
