import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The composer is a client component; a static render with the data hooks
// stubbed is enough to see which editor mounts and what the body shows.
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
  useParams: () => ({}),
  usePathname: () => "/broadcasts",
  useSearchParams: () => new URLSearchParams(),
}));
// The block editor never loads in tests: its loader is replaced by a marker.
vi.mock("next/dynamic", () => ({
  default: () => () => createElement("div", { "data-block-editor": "" }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
  useInfiniteQuery: () => ({ data: undefined, isPending: false, isError: false }),
  useMutation: () => ({
    mutateAsync: vi.fn(),
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), fetchQuery: vi.fn() }),
}));
// Any trpc.<path>.<helper>(...) call resolves to an inert options object.
vi.mock("@/lib/trpc", () => {
  // biome-ignore lint/suspicious/noExplicitAny: stand-in for the whole router proxy
  const proxy: any = new Proxy(() => ({}), { get: () => proxy, apply: () => ({}) });
  return { useTRPC: () => proxy };
});
// Portals cannot render statically; the dialog's frame is inlined instead.
vi.mock("@/components/modal", () => ({
  Modal: ({ open, title, children }: { open: boolean; title?: string; children: unknown }) =>
    open ? createElement("div", { role: "dialog" }, title, children as never) : null,
}));

const { BroadcastComposer } = await import("@/app/(dashboard)/broadcasts/composer");
const { PacingSteps, SendPlanSummary } = await import("@/app/(dashboard)/broadcasts/parts");
type SendPlanWarmup = import("@/app/(dashboard)/broadcasts/parts").SendPlanWarmup;

const MAILY_DOC = { type: "doc", content: [{ type: "paragraph" }] };
const HTML_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  topicId: null,
  segmentId: null,
  name: "Launch",
  from: "Ada <ada@news.example.com>",
  subject: "Hi",
  replyTo: null,
  html: '<table><tr><td style="padding:8px">Hi {{{FIRST_NAME|there}}}</td></tr></table>',
  text: null,
  document: null,
};

describe("broadcast composer body mode", () => {
  it("opens an html-authored draft on the preview with the banner and no block editor", () => {
    const out = renderToStaticMarkup(createElement(BroadcastComposer, { initial: HTML_ROW }));
    expect(out).not.toContain("data-block-editor");
    expect(out).toContain("templates.html.banner");
    expect(out).toContain("templates.html.editHtml");
    expect(out).toContain("templates.html.convert");
    // The stored html is what the preview shows, byte for byte.
    expect(out).toContain("<iframe");
    expect(out).toContain("padding:8px");
  });

  it("opens a block-authored draft in the block editor, with no html banner", () => {
    const out = renderToStaticMarkup(
      createElement(BroadcastComposer, { initial: { ...HTML_ROW, document: MAILY_DOC } }),
    );
    expect(out).toContain("data-block-editor");
    expect(out).not.toContain("templates.html.banner");
  });
});

describe("send dialog warm-up", () => {
  const offer = (over: Partial<SendPlanWarmup> = {}): SendPlanWarmup => ({
    status: "off",
    domain: "news.example.com",
    bestDay: 0,
    eligible: 9_000,
    inactive: 1_200,
    inactiveSince: new Date("2026-07-20T12:00:00Z"),
    skipInactive: true,
    risky: true,
    plan: {
      perDay: [
        { day: "2026-10-18", count: 1_500 },
        { day: "2026-10-19", count: 2_300 },
        { day: "2026-10-20", count: 4_000 },
      ],
      days: 3,
      finishesAt: new Date("2026-10-20T10:00:00Z"),
    },
    blocked: false,
    horizonDays: 24,
    ...over,
  });
  const render = (props: Partial<Parameters<typeof SendPlanSummary>[0]>) =>
    renderToStaticMarkup(
      createElement(SendPlanSummary, {
        count: 9_000,
        estimate: null,
        cloud: true,
        locale: "en",
        now: new Date("2026-10-18T09:00:00Z"),
        ...props,
      }),
    );

  it("offers a risky send a warm-up first: its plan, the inactive choice and why", () => {
    const out = render({ warmup: offer() });
    expect(out).toContain("broadcasts.guard.riskNoticeNew");
    expect(out).toContain("warmup.off.switch");
    expect(out).toContain("broadcasts.guard.recommended");
    expect(out).toContain("broadcasts.guard.optionNormal");
    expect(out).toContain('aria-label="broadcasts.guard.warmupPlan"');
    expect(out).toContain("broadcasts.guard.inactiveLabel");
    expect(out).toContain("broadcasts.guard.warmupReason");
    // With history, the notice names the domain's best day.
    expect(render({ warmup: offer({ bestDay: 840 }) })).toContain("broadcasts.guard.riskNotice<");
    // The normal pace drops the warm-up's rail and inactive row.
    const normal = render({ warmup: offer(), pace: "normal" });
    expect(normal).not.toContain("broadcasts.guard.warmupPlan");
    expect(normal).not.toContain("broadcasts.guard.inactiveLabel");
  });

  it("shows a warming domain's own plan with no choice, and a paused one's wait with no plan", () => {
    const warming = render({ warmup: offer({ status: "warming", risky: false }) });
    expect(warming).toContain("broadcasts.guard.warmingIntro");
    expect(warming).not.toContain("warmup.off.switch");
    expect(warming).toContain("broadcasts.guard.warmupPlan");
    const paused = render({
      warmup: offer({
        status: "paused",
        risky: false,
        plan: { perDay: [], days: 0, finishesAt: null },
      }),
    });
    expect(paused).toContain("broadcasts.guard.pausedIntro");
    expect(paused).not.toContain("broadcasts.guard.warmupPlan");
    expect(paused).not.toContain("ms-field-error");
  });

  it("paces by the new domain limit in its own words, never blaming capacity or other sends", () => {
    const reset = new Date("2026-10-19T00:00:00Z");
    const estimate = {
      first: 0,
      startsAt: reset,
      finishesAt: new Date("2026-10-20T00:30:00Z"),
      days: 2,
      blocked: false,
      releases: [
        { at: reset, endsAt: new Date("2026-10-19T00:20:00Z"), count: 300 },
        {
          at: new Date("2026-10-20T00:00:00Z"),
          endsAt: new Date("2026-10-20T00:30:00Z"),
          count: 300,
        },
      ],
      planHold: null,
      newDomainHold: { heldBack: 600, resumesAt: reset, domain: "nova.example", cap: 300 },
      planLabel: "Pro",
      planPeriod: "month" as const,
      rung: null,
      horizonDays: 24,
    };
    const out = render({ count: 600, estimate });
    expect(out).toContain("broadcasts.guard.limitReason");
    expect(out).toContain("broadcasts.guard.stepLimitDomain");
    expect(out).toContain("broadcasts.guard.stepFirstReset");
    expect(out).toContain("broadcasts.guard.stepLastReset");
    expect(out).not.toContain("broadcasts.guard.stepStarts");
    expect(out).not.toContain("broadcasts.guard.reason<");
    // Without the limit, the same plan reads as capacity's.
    expect(render({ count: 600, estimate: { ...estimate, newDomainHold: null } })).toContain(
      "broadcasts.guard.stepStarts",
    );
  });

  it("words a sending broadcast's days as the limit's resets while it paces them", () => {
    const rail = (resets: boolean) =>
      renderToStaticMarkup(
        createElement(PacingSteps, {
          sent: [{ at: new Date("2026-10-18T09:00:00Z"), count: 300 }],
          releases: [
            {
              at: new Date("2026-10-19T00:00:00Z"),
              endsAt: new Date("2026-10-19T00:20:00Z"),
              count: 300,
            },
            {
              at: new Date("2026-10-20T00:00:00Z"),
              endsAt: new Date("2026-10-20T00:20:00Z"),
              count: 300,
            },
            {
              at: new Date("2026-10-21T00:00:00Z"),
              endsAt: new Date("2026-10-21T00:20:00Z"),
              count: 100,
            },
          ],
          locale: "en",
          now: new Date("2026-10-18T09:30:00Z"),
          resets,
        }),
      );
    expect(rail(true)).toContain("broadcasts.guard.stepMoreReset");
    expect(rail(true)).toContain("broadcasts.guard.stepLastReset");
    expect(rail(true)).not.toContain("broadcasts.guard.stepMore<");
    expect(rail(false)).toContain("broadcasts.guard.stepMore");
  });

  it("refuses a warm-up past the horizon in place", () => {
    const out = render({ warmup: offer({ status: "warming", risky: false, blocked: true }) });
    expect(out).toContain("deliverability.sendGuard.warmupTooLong");
  });
});
