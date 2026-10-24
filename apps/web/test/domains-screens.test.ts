import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// What the list query answers, and the page's query string.
const h = vi.hoisted(() => ({
  list: [] as unknown[],
  search: "",
}));

// The real English catalogs, so the test reads what a customer reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = {
    domains: (await import("../messages/en/domains.json")).default,
    common: (await import("../messages/en/common.json")).default,
    warmup: (await import("../messages/en/warmup.json")).default,
  };
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace: keyof typeof messages) =>
      actual.createTranslator({ locale: "en", messages, namespace }),
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(h.search),
}));
// Each procedure's options name its path.
vi.mock("@/lib/trpc", () => {
  const at = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_, key: string) =>
        key.endsWith("Options") ? () => ({ path: path.join(".") }) : at([...path, key]),
    });
  return { useTRPC: () => at([]) };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ path }: { path: string }) =>
    path === "domains.list"
      ? {
          data: h.list,
          isPending: false,
          isError: false,
          isSuccess: true,
        }
      : { data: undefined, isPending: true, isError: false, isSuccess: false },
  useMutation: () => ({ mutate: () => {}, isPending: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }),
}));
// Dialogs and drawers portal to document.body, which a server render does not have.
vi.mock("@/components/modal", () => ({ Modal: () => null }));
vi.mock("@/components/api-sheet", () => ({ ResourceApiButton: () => null }));

const { DomainsView } = await import("@/app/(dashboard)/domains/domains-table");
const { formatStepTime } = await import("@/lib/format");
const { WarmupStatus, WarmupTab } = await import("@/app/(dashboard)/domains/[id]/warmup-tab");

const own = (name: string, status: string) => ({
  id: name,
  name,
  region: "us-east-1",
  status,
  createdAt: new Date(),
  trackingPending: false,
});
function page(p: { list: unknown[]; search?: string }) {
  h.list = p.list;
  h.search = p.search ?? "";
  const html = renderToStaticMarkup(createElement(DomainsView, { awsBanner: null }));
  const rows = html.match(/<tbody>.*<\/tbody>/s)?.[0].match(/<tr>.*?<\/tr>/gs) ?? [];
  return { html, rows };
}

describe("the Domains page", () => {
  const owned = [own("mail.acme.example", "verified"), own("news.acme.example", "pending")];

  it("lists the team's own domains, each with a link and a menu, and counts them", () => {
    const { html, rows } = page({ list: owned });
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toContain('aria-label="More actions"');
    expect(rows[0]).toContain('href="/domains/mail.acme.example"');
    expect(html).toContain("Page 1 – 1 of 2 domains");
  });

  it("keeps each row on one line, the name ending in an ellipsis inside its column", () => {
    const { html } = page({ list: owned });
    expect(html).not.toContain("ms-cell-wrap");
    expect(html).not.toContain("<wbr");
    expect(html).toContain(
      '<a class="ms-lead-value" href="/domains/mail.acme.example"><span class="ms-truncate">mail.acme.example</span></a>',
    );
  });

  it("shows the no-match card alone when the filters match no domain", () => {
    const { html, rows } = page({ list: owned, search: "q=agents" });
    expect(rows).toHaveLength(0);
    expect(html).not.toContain("<table");
    expect(html).toContain("None of your domains match the filters.");
    expect(html).not.toContain("Page 1 –");
  });

  it("shows the empty state alone when the team has no domain", () => {
    const { html } = page({ list: [] });
    expect(html).not.toContain("<table");
    expect(html).toContain("No domains of your own yet.");
    expect(html).toContain('href="/domains/new"');
    // Nothing to filter.
    expect(html).not.toContain('class="ms-filter-row"');
  });
});

type Warmup = Parameters<typeof WarmupStatus>[0]["data"];

/** What a reader sees: tags dropped, entities and no-break spaces read back. */
function visible(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("\u00a0", " ");
}

const signals = (over: Partial<Record<string, object>> = {}) =>
  [
    { key: "delays", result: "within", figure: 0.018, gmail: 0.018, other: 0.004 },
    { key: "opens", result: "within", figure: 0.82, gmail: 0.146, other: 0.178 },
    { key: "hardBounces", result: "within", figure: 0.005, gmail: 0.003, other: 0.007 },
    { key: "mailboxFull", result: "within", figure: 0, gmail: 0, other: 0 },
    { key: "complaints", result: "within", figure: 0.0002, gmail: null, other: 0.0002 },
  ].map((s) => ({ ...s, ...over[s.key] })) as Warmup["health"] extends infer H
    ? H extends { signals: infer S }
      ? S
      : never
    : never;

function warmup(over: Partial<Warmup> = {}): Warmup {
  return {
    status: "off",
    settings: {
      dailyTarget: 50_000,
      startVolume: 1_500,
      orderByEngagement: true,
      orderByTransactional: true,
      orderProperty: null,
      skipInactive: true,
    },
    volume: 1_500,
    sendingDays: 0,
    startedAt: null,
    pausedAt: null,
    doneAt: null,
    today: null,
    days: [],
    projection: [],
    waiting: 0,
    bestDay: 400,
    audience: { total: 12_000, inactive: 3_000, withProperty: null },
    openTracking: true,
    pauseSignals: null,
    health: null,
    todayWindow: null,
    resumeVolume: 750,
    preview: null,
    properties: [
      {
        key: "last_login_at",
        declared: true,
        dated: 1_204,
        latest: new Date("2026-10-17T09:12:00Z"),
      },
      { key: "renewal", declared: false, dated: 0, latest: null },
    ],
    limits: {
      dailyTarget: { min: 1_000, max: 10_000_000 },
      startVolume: { min: 100, max: 1_000_000 },
    },
    waitingExpiresAt: null,
    canManage: true,
    ...over,
  };
}

const tab = (data: Warmup) =>
  renderToStaticMarkup(
    createElement(WarmupTab, {
      id: "d1",
      query: { data, isError: false } as never,
      live: data.status === "warming" || data.status === "paused",
    }),
  );

describe("the domain Warm-up tab", () => {
  it("while off, previews a send to everyone and offers the switch and every setting", () => {
    const html = tab(
      warmup({
        preview: [
          { day: "2026-10-18", count: 1_500 },
          { day: "2026-10-19", count: 2_300 },
          { day: "2026-10-20", count: 3_500 },
          { day: "2026-10-21", count: 1_700 },
        ],
      }),
    );
    const text = visible(html);
    expect(text).toContain("Not warming up · most sent in a day so far: 400");
    expect(text).toContain("A broadcast to all 12,000 contacts would go out like this");
    expect(text).toContain("Day 11,500 go out · most active first");
    expect(text).toContain("last 1,700 · every active contact reached");
    expect(text).toContain(
      "9,000 active contacts in about 4 sending days, most active first. 3,000 with no activity in 90+ days are skipped.",
    );
    expect(html).toMatch(/role="switch" aria-checked="false" aria-label="Warm up this domain"/);
    for (const title of ["Most active contacts first", "Inactive contacts", "Daily target"]) {
      expect(text).toContain(title);
    }
    expect(text).toContain("Starting volume");
    expect(text).toContain(
      "Pick a date that moves when people use your product, like the last login.",
    );
    expect(visible(tab(warmup({ properties: [] })))).toContain(
      "None of your contact properties hold dates yet. Add a date property in Audience.",
    );
  });

  it("while warming, shows today's pace, the checked days and the delivery health", () => {
    const html = tab(
      warmup({
        status: "warming",
        volume: 4_800,
        sendingDays: 2,
        startedAt: new Date("2026-10-16T12:00:00Z"),
        today: { day: "2026-10-18", allowance: 4_800, sent: 1_200, checked: true },
        todayWindow: {
          startsAt: new Date("2026-10-18T07:00:00Z"),
          endsAt: new Date("2026-10-18T19:00:00Z"),
        },
        days: [
          {
            day: "2026-10-18",
            allowance: 4_800,
            sent: 1_200,
            outcome: null,
            signals: null,
            checkedAt: null,
          },
          {
            day: "2026-10-17",
            allowance: 3_200,
            sent: 3_200,
            outcome: "held",
            signals: signals({ delays: { result: "missed", figure: 0.062, gmail: 0.062 } }),
            checkedAt: new Date("2026-10-18T00:05:00Z"),
          },
          {
            day: "2026-10-16",
            allowance: 2_100,
            sent: 2_100,
            outcome: "grew",
            signals: signals(),
            checkedAt: new Date("2026-10-17T00:05:00Z"),
          },
        ],
        projection: [
          { day: "2026-10-19", volume: 7_200 },
          { day: "2026-10-20", volume: 10_800 },
        ],
        waiting: 30_000,
        health: {
          day: "2026-10-17",
          sent: 3_200,
          checkedAt: new Date("2026-10-18T00:05:00Z"),
          signals: signals({ delays: { result: "missed", figure: 0.062, gmail: 0.062 } }),
          yesterday: true,
        },
        openTracking: false,
      }),
    );
    const text = visible(html);
    // Stat figures roll on the odometer, which reads out as its label.
    for (const figure of ["1,200", "3", "6,500", "50,000"]) {
      expect(html).toContain(`aria-label="${figure}"`);
    }
    expect(text).toContain("of 4,800 · until about");
    expect(text).toContain("of about 5");
    expect(text).toContain("2,100 sentMost active first");
    expect(text).toContain("3,200 sent · heldGmail delayed 6.2% of it");
    expect(text).toContain("4,800 go out · 1,200 sent so far");
    expect(text).toContain("10,800 · full volume");
    expect(text).toContain("Delivery health · yesterday");
    expect(text).toContain("Delivery delaysMissed6.2%0.4%under 5%");
    // The side it is judged on carries the result's color.
    expect(html).toContain('style="color:var(--ms-warn)">6.2%');
    expect(text).toContain("Turn on open tracking to see this signal.");
    expect(text).toContain("not reported");
    expect(text).toContain("0.02%");
    expect(html).toContain('href="https://postmaster.google.com/"');
    expect(text).toContain("Pause warm-up");
    // Day 1 is behind it, so the starting volume no longer applies.
    expect(text).not.toContain("Starting volume");
  });

  it("while paused, says what to check and resumes at half the volume", () => {
    const data = warmup({
      status: "paused",
      volume: 1_500,
      sendingDays: 1,
      startedAt: new Date("2026-10-16T12:00:00Z"),
      pausedAt: new Date("2026-10-17T06:00:00Z"),
      today: { day: "2026-10-18", allowance: 1_500, sent: 0, checked: true },
      waiting: 2,
      waitingExpiresAt: new Date("2026-11-15T12:00:00Z"),
      pauseSignals: signals({
        delays: { result: "severe", figure: 0.38, gmail: 0.38 },
        mailboxFull: { result: "missed", figure: 0.031, gmail: 0.031 },
      }),
      health: {
        day: "2026-10-16",
        sent: 1_500,
        checkedAt: new Date("2026-10-17T06:00:00Z"),
        signals: signals({
          delays: { result: "severe", figure: 0.38, gmail: 0.38 },
          mailboxFull: { result: "missed", figure: 0.031, gmail: 0.031 },
        }),
        yesterday: false,
      },
    });
    const html = tab(data);
    const text = visible(html);
    expect(html).toContain('aria-label="2"');
    expect(text).toContain("emails from broadcasts");
    expect(text).toContain("after day 1");
    expect(text).toContain(
      "25% of your contacts haven't been active in 90+ days. Start again with the most active.",
    );
    expect(text).toContain("Dead addresses");
    expect(text).toContain("Starts again at 750 a day. The waiting mail keeps its order");
    expect(text).toContain("Resume at 750/day");
    const banner = visible(renderToStaticMarkup(createElement(WarmupStatus, { data })));
    expect(banner).toBe(
      "Warm-up paused.Gmail delayed 38% of the day's mail. 3.1% of mailboxes were full or inactive. 2 emails are waiting until you resume.",
    );
  });

  it("when the team paused it, says so instead of a health table", () => {
    const text = visible(
      tab(
        warmup({
          status: "paused",
          pausedAt: new Date("2026-10-17T12:00:00Z"),
          startedAt: new Date("2026-10-16T12:00:00Z"),
          today: { day: "2026-10-18", allowance: 1_500, sent: 0, checked: true },
        }),
      ),
    );
    expect(text).toContain("Your team paused this warm-up on");
    // Paused before its first check: no day behind it to name.
    expect(text).not.toContain("after day");
    expect(text).not.toContain("Delivery health");
    expect(text).not.toContain("Dead addresses");
    expect(text).toContain("Starts again at 750 a day.Resume");
  });

  it("when done, shows the history and offers to warm up again", () => {
    const data = warmup({
      status: "done",
      volume: 50_000,
      doneAt: new Date("2026-10-18T00:05:00Z"),
      startedAt: new Date("2026-10-08T12:00:00Z"),
      days: [
        {
          day: "2026-10-17",
          allowance: 50_000,
          sent: 50_000,
          outcome: "done",
          signals: signals(),
          checkedAt: new Date("2026-10-18T00:05:00Z"),
        },
      ],
    });
    const text = visible(tab(data));
    expect(text).toContain("Warm-up done on");
    expect(text).toContain("50,000 sent");
    expect(text).toContain("far more than 50,000 a day");
    expect(text).toContain("Warm up again");
    expect(visible(renderToStaticMarkup(createElement(WarmupStatus, { data })))).toMatch(
      /^Warm-up done · 50,000\/day since/,
    );
  });

  it("rounds the end of today's window up to the quarter hour, as every forecast reads", () => {
    const text = visible(
      tab(
        warmup({
          status: "warming",
          sendingDays: 2,
          startedAt: new Date("2026-10-16T12:00:00Z"),
          today: { day: "2026-10-18", allowance: 4_800, sent: 1_200, checked: true },
          todayWindow: {
            startsAt: new Date("2026-10-18T07:00:00Z"),
            endsAt: new Date("2026-10-18T18:52:00Z"),
          },
        }),
      ),
    );
    const about = formatStepTime(new Date("2026-10-18T19:00:00Z"), "en").replaceAll("\u00a0", " ");
    // The stat under Today and the rail's today row.
    expect(text.split(`until about ${about}`)).toHaveLength(3);
  });

  it("leaves every control disabled for members", () => {
    const html = tab(warmup({ canManage: false, preview: [{ day: "2026-10-18", count: 9_000 }] }));
    const controls = html.match(/<(button|input)[^>]*>/g) ?? [];
    const enabled = controls.filter(
      (tag) => !tag.includes("disabled") && !tag.includes("ms-tooltip-trigger"),
    );
    expect(enabled).toEqual([]);
  });
});
