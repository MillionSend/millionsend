import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// A static render of the detail page with each query answered from DATA by
// its tRPC path, enough to see what the warm-up and the provider table show.
vi.mock("next-intl", () => {
  const t = (ns: string) =>
    Object.assign((key: string) => `${ns}.${key}`, {
      rich: (key: string) => `${ns}.${key}`,
      raw: (key: string) => `${ns}.${key}`,
    });
  return { useTranslations: t, useLocale: () => "en" };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ id: BROADCAST_ID }),
  usePathname: () => "/broadcasts",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: string }) => ({
    data: DATA[options.queryKey],
    isError: FAILED.has(options.queryKey),
  }),
  useInfiniteQuery: () => ({ data: undefined, isSuccess: false }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/lib/trpc", () => {
  // trpc.a.b.queryOptions(...) answers { queryKey: "a.b" }.
  // biome-ignore lint/suspicious/noExplicitAny: stand-in for the whole router proxy
  const at = (path: string[]): any =>
    new Proxy(() => {}, {
      get: (_, key: string) => at([...path, key]),
      apply: () => ({ queryKey: path.slice(0, -1).join(".") }),
    });
  return { useTRPC: () => at([]) };
});
vi.mock("@/components/modal", () => ({ Modal: () => null }));

const BROADCAST_ID = "11111111-1111-4111-8111-111111111111";
const DOMAIN_ID = "22222222-2222-4222-8222-222222222222";
const DAY = 86_400_000;
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + DAY).toISOString().slice(0, 10);
const missedDelays = [
  { key: "delays", result: "missed", figure: 0.062, gmail: 0.062, other: 0.01 },
  { key: "hardBounces", result: "within", figure: 0.004, gmail: 0.003, other: 0.005 },
];
const WARMING = {
  status: "warming",
  domainId: DOMAIN_ID,
  domain: "news.example.com",
  volume: 1_500,
  latest: { day: yesterday, outcome: "held", signals: missedDelays },
  pauseSignals: null,
  checked: true,
  days: [{ day: yesterday, outcome: "held", signals: missedDelays }],
  perDay: [
    { day: today, count: 1_300 },
    { day: tomorrow, count: 1_700 },
  ],
  today: { startsAt: new Date(`${today}T00:00:00Z`), endsAt: new Date(`${today}T12:00:00Z`) },
};
const BROADCAST = {
  id: BROADCAST_ID,
  status: "sending",
  name: "October launch",
  subject: "New this month",
  from: "Acme <news@news.example.com>",
  segmentName: null,
  topicName: null,
  sentAt: null,
  scheduledAt: new Date(Date.now() - 2 * DAY),
  startedAt: new Date(Date.now() - 2 * DAY),
  finishesAt: new Date(Date.now() + DAY),
  releases: [],
  sent: [
    { at: new Date(`${yesterday}T10:00:00Z`), count: 1_500 },
    { at: new Date(`${today}T00:15:00Z`), count: 200 },
  ],
  sentCount: 1_700,
  parkedCount: 3_000,
  planHold: null,
  held: false,
  html: null,
  text: null,
  insights: null,
  hiddenBySupportView: false,
  warmupSkipped: 90,
  stats: {
    total: 4_700,
    delivered: 1_600,
    opened: 300,
    clicked: 20,
    prefetched: 0,
    bounced: 3,
    complained: 0,
    unsubscribed: 1,
  },
  warmup: WARMING,
};
const PROVIDERS = [
  {
    provider: "gmail",
    sent: 1_000,
    delivered: 980,
    opened: 49,
    clicked: 5,
    bounced: 2,
    delayed: 62,
    complained: 0,
    complaintSent: 0,
  },
  {
    provider: "microsoft",
    sent: 300,
    delivered: 300,
    opened: 30,
    clicked: 3,
    bounced: 0,
    delayed: 0,
    complained: 1,
    complaintSent: 300,
  },
];
const DATA: Record<string, unknown> = {
  "broadcasts.get": BROADCAST,
  "broadcasts.providers": PROVIDERS,
};
const FAILED = new Set<string>();

const { default: BroadcastDetailPage } = await import("@/app/(dashboard)/broadcasts/[id]/page");

describe("broadcast detail while the domain warms up", () => {
  it("names the warm-up, explains a held day, and rails this send's days", () => {
    const out = renderToStaticMarkup(createElement(BroadcastDetailPage));
    expect(out).toContain("warmup.status.warming");
    expect(out).toContain("broadcasts.detail.warmupOrderSkipped");
    expect(out).toContain("broadcasts.detail.warmupHeld");
    expect(out).toContain("broadcasts.detail.warmupHeldBody");
    // The held banner carries its mark, the level lines.
    expect(out).toContain('d="M5 7h14"');
    expect(out).toContain('aria-label="warmup.pace.label"');
    // Yesterday held with its reason, today with its meter, then the rest.
    expect(out).toContain("warmup.rail.held");
    expect(out).toContain("warmup.signalsShort.delays");
    expect(out).toContain("warmup.rail.todayLabel");
    expect(out).toContain("warmup.rail.todayWindow");
    expect(out).toContain('class="bar"');
    expect(out).toContain("broadcasts.guard.stepLast");
    expect(out).toContain("broadcasts.detail.warmupNote");
  });

  it("shows a paused warm-up as a banner that opens it, with no rail", () => {
    DATA["broadcasts.get"] = { ...BROADCAST, warmup: { ...WARMING, status: "paused" } };
    const out = renderToStaticMarkup(createElement(BroadcastDetailPage));
    DATA["broadcasts.get"] = BROADCAST;
    expect(out).toContain("warmup.status.paused");
    expect(out).toContain("warmup.row.pausedTitle");
    // The pause mark the domain page's banner carries.
    expect(out).toContain('d="M10 15V9"');
    expect(out).toContain(`href="/domains/${DOMAIN_ID}?tab=warmup"`);
    expect(out).not.toContain("warmup.pace.label");
  });

  it("breaks the sends down by provider: shares of sent, opens of delivered", () => {
    const out = renderToStaticMarkup(createElement(BroadcastDetailPage));
    expect(out).toContain("broadcasts.detail.providers.label");
    expect(out).toContain("broadcasts.detail.providers.gmail");
    // Delivered 980 of 1,000; opened 49 of 980 delivered; delayed 62 of 1,000.
    expect(out).toContain("98.0%");
    expect(out).toContain("5.0%");
    expect(out).toContain("6.2%");
  });

  it("puts complaints over what went to providers that report them, a dash where none do", () => {
    const out = renderToStaticMarkup(createElement(BroadcastDetailPage));
    expect(out).toContain("broadcasts.detail.providers.complained");
    // Microsoft: 1 complaint of 300; Gmail never reports one.
    expect(out).toContain("0.33%");
    expect(out).toContain(
      '<span class="ms-tooltip-trigger inline" tabindex="0"><span class="ms-mono" style="color:var(--ms-muted)">—</span></span>',
    );
  });

  it("holds the provider table's place while it loads, and offers a retry when it fails", () => {
    DATA["broadcasts.providers"] = undefined;
    const loading = renderToStaticMarkup(createElement(BroadcastDetailPage));
    FAILED.add("broadcasts.providers");
    const failed = renderToStaticMarkup(createElement(BroadcastDetailPage));
    FAILED.clear();
    DATA["broadcasts.providers"] = PROVIDERS;
    expect(loading).toContain("broadcasts.detail.providers.label");
    expect(loading).toMatch(/<table[^>]*>[\s\S]*ms-skeleton[\s\S]*<\/table>/);
    expect(failed).toContain("broadcasts.detail.providers.loadError");
    expect(failed).toContain("common.loadError.retry");
  });
});
