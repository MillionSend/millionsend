import { afterEach, describe, expect, it } from "vitest";
import { dnsCards, idRows, printSummary, type Report, renderReportMd } from "../src/report.js";
import { setColorMode } from "../src/theme.js";

async function summary(r: Report): Promise<string> {
  const chunks: string[] = [];
  await printSummary({ write: (c: string) => chunks.push(String(c)) } as never, r);
  return chunks.join("");
}

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
  ids: [{ resource: "topics", name: HOSTILE, sourceId: "src-id", targetId: "dst-id" }],
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

const UUID = "546492dd-3b56-4e7c-be10-0954661a052c";
const manual = [
  { title: "broadcasts/A", detail: "from domain x is not verified here" },
  { title: "broadcasts/B", detail: "from domain x is not verified here" },
  { title: "broadcasts/C", detail: "from domain x is not verified here" },
  { title: "broadcasts/D", detail: "from domain x is not verified here" },
  { title: "topics/T", detail: "from domain x is not verified here" },
  { title: "broadcasts/E", detail: "something else" },
];
const full: Report = {
  ...report,
  counts: {
    contacts: { created: 721, updated: 0, unchanged: 0, skipped: 0, manual: 0, failed: 0 },
    templates: { created: 0, updated: 0, unchanged: 0, skipped: 0, manual: 0, failed: 0 },
  },
  freshWebhookSecrets: [{ endpoint: "https://hook.example", secret: "whsec_abc" }],
  checklist: { done: ["contacts", "topics"], left: ["add DNS records for news.example.com"] },
  dns: [
    {
      domain: "news.example.com",
      records: [
        { record: "DKIM", name: "ms._domainkey.news.example.com", type: "TXT", value: "v=DKIM1" },
        { record: "MX", name: "news.example.com", type: "MX", value: "mx.example", priority: 10 },
      ],
    },
  ],
  ids: [
    {
      resource: "topics",
      name: "Product updates",
      sourceId: "05cda767-1111-4222-8333-444455556666",
      targetId: UUID,
    },
  ],
  manual,
  failures: [],
  offer: {
    emailsLast30Days: 41208,
    perDay: 1374,
    domains: 1,
    plan: "free",
    fits: "pro",
    url: "https://app.example.test:3000/settings/billing",
    text: [
      "On Resend you sent 41,208 emails in the last 30 days (~1,374/day).",
      "Free allows 100/day; Pro (3,000/day, 20 domains) fits. Upgrade: https://app.example.test:3000/settings/billing",
    ],
  },
};

describe("printSummary layout", () => {
  afterEach(() => setColorMode("auto"));

  it("is plain text with the Done heading, cards and vertical id rows when piped", async () => {
    setColorMode("never");
    const text = await summary(full);
    expect(text).not.toContain("\x1b");
    expect(text).toContain("\nDone\n────");
    expect(text).toContain("721  contacts created\n");
    expect(text).not.toContain("templates");
    expect(text).toContain("\nResend was only read; nothing there was changed.\n");
    expect(text).toContain("  https://hook.example  whsec_abc\n");
    expect(text).toContain(
      "\n2 of 3 steps done — left:\n  [ ] add DNS records for news.example.com\n",
    );
    expect(text).toContain(
      "\nDNS records for news.example.com:\n  TXT  ms._domainkey.news.example.com\n    v=DKIM1\n\n  MX  news.example.com  priority 10\n    mx.example\n",
    );
    expect(text).toContain(
      `\nId map (Resend → MillionSend; full pairs in migrate-report.md):\n  topics/Product updates\n    05cda767… → ${UUID}\n`,
    );
    expect(text).toContain(
      "\nManual notes:\n  ! topics/T — from domain x is not verified here\n  ! 4 broadcasts — from domain x is not verified here\n    A, B … and 2 more\n  ! broadcasts/E — something else\n",
    );
    // Prose wraps at the layout width (80 here); the words and their order are what matter.
    const prose = text.replace(/\n/g, " ");
    expect(prose).toContain(
      " Run `millionsend migrate --from resend` again right before cutover to sync new contacts. ",
    );
    expect(prose).toContain("Upgrade: https://app.example.test:3000/settings/billing ");
    for (const l of text.split("\n")) expect(l.length).toBeLessThanOrEqual(80);
  });

  it("bolds only the numbers and the copy targets when colored", async () => {
    setColorMode("always");
    const text = await summary(full);
    expect(text).toContain("\x1b[1mDone\x1b[22m\n\x1b[2m────");
    expect(text).toContain("\x1b[1m721\x1b[22m  contacts created\n");
    expect(text).toContain("\x1b[2mResend was only read; nothing there was changed.\x1b[22m");
    expect(text).toContain("  https://hook.example  \x1b[1mwhsec_abc\x1b[22m\n");
    expect(text).toContain(
      "\x1b[1m2\x1b[22m of 3 steps done — left:\n  \x1b[2m[\x1b[22m \x1b[2m]\x1b[22m add DNS",
    );
    expect(text).toContain(
      "  \x1b[36mTXT\x1b[39m  ms._domainkey.news.example.com\n    \x1b[1mv=DKIM1\x1b[22m\n",
    );
    expect(text).toContain("  \x1b[36mMX\x1b[39m  news.example.com\x1b[2m  priority 10\x1b[22m\n");
    expect(text).toContain(`    \x1b[2m05cda767…\x1b[22m → \x1b[1m${UUID}\x1b[22m\n`);
    expect(text).toContain("  \x1b[35m!\x1b[39m 4 broadcasts — from domain x");
    expect(text).toContain("\x1b[2mA, B … and 2 more\x1b[22m");
    expect(text).toContain(
      "sent \x1b[1m41,208\x1b[22m emails in the last \x1b[1m30\x1b[22m days (~\x1b[1m1,374\x1b[22m/day).",
    );
    // A URL is copied whole: no styling inside it, even with digits in the port.
    expect(text.replace(/\n/g, " ")).toContain(
      "Upgrade: https://app.example.test:3000/settings/billing",
    );
  });

  it("wraps long lines at the layout width with a hanging indent", async () => {
    setColorMode("never");
    const detail = "word ".repeat(30).trim();
    const text = await summary({ ...report, manual: [{ title: "topics/T", detail }] });
    const lines = text.split("\n").filter((l) => l.includes("word"));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toMatch(/^ {2}! topics\/T — word/);
    for (const l of lines.slice(1)) expect(l).toMatch(/^ {4}word/);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(80);
  });
});

describe("report render helpers", () => {
  it("dnsCards and idRows never shorten a value", () => {
    setColorMode("never");
    const long = "p=".padEnd(400, "x");
    expect(dnsCards([{ record: "DKIM", name: "n", type: "TXT", value: long }])).toEqual([
      "  TXT  n",
      `    ${long}`,
    ]);
    expect(idRows([{ resource: "segments", name: "S", sourceId: "src", targetId: UUID }])).toEqual([
      "  segments/S",
      `    src → ${UUID}`,
    ]);
  });
});
