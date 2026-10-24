import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatDay,
  formatDayTime,
  formatHoursMinutes,
  formatStepDay,
  formatTime,
} from "@/lib/format";
import type { LimitTranslate } from "@/lib/new-domain-limit";

const catalogs = {
  en: {
    emails: (await import("../messages/en/emails.json")).default,
    common: (await import("../messages/en/common.json")).default,
    domains: (await import("../messages/en/domains.json")).default,
    broadcasts: (await import("../messages/en/broadcasts.json")).default,
  },
  "pt-BR": {
    emails: (await import("../messages/pt-BR/emails.json")).default,
    common: (await import("../messages/pt-BR/common.json")).default,
    domains: (await import("../messages/pt-BR/domains.json")).default,
    broadcasts: (await import("../messages/pt-BR/broadcasts.json")).default,
  },
};
const h = vi.hoisted(() => ({ locale: "en" as "en" | "pt-BR", domains: [] as unknown[] }));

// The real catalogs, so the test reads what a customer reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  return {
    ...actual,
    useLocale: () => h.locale,
    useTranslations: (namespace: string) =>
      actual.createTranslator({
        locale: h.locale,
        messages: catalogs[h.locale],
        namespace: namespace as "emails",
      }),
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
// The hover text set inline, so a static render carries it.
vi.mock("@/components/tooltip", () => ({
  Tooltip: ({ text, children }: { text: string; children: unknown }) =>
    createElement("span", { "data-tip": text }, children as never),
}));
vi.mock("@/lib/trpc", () => {
  const at = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get: (_, key: string) =>
        key.endsWith("Options") || key === "queryKey"
          ? () => ({ path: path.join(".") })
          : at([...path, key]),
    });
  return { useTRPC: () => at([]) };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ path }: { path: string }) =>
    path === "domains.list"
      ? { data: h.domains, isPending: false, isError: false, isSuccess: true }
      : { data: undefined, isPending: true, isError: false, isSuccess: false },
  useMutation: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }),
}));
vi.mock("@/components/api-sheet", () => ({ ResourceApiButton: () => null }));

const { EmailsTable } = await import("@/components/emails-table");
const { LimitBanner } = await import("@/app/(dashboard)/emails/limit-banner");
const { LimitSection, LimitWaitingBanner } = await import(
  "@/app/(dashboard)/domains/[id]/limit-section"
);
const { DomainsView } = await import("@/app/(dashboard)/domains/domains-table");
const { TestSendNote } = await import("@/app/(dashboard)/broadcasts/parts");

const DAY = 86_400_000;
const NOW = new Date("2026-10-20T18:00:00Z");
const RESET = new Date("2026-10-21T00:00:00Z");
const REGISTERED = new Date(NOW.getTime() - 3 * DAY - 3_600_000);
const STEP = new Date(REGISTERED.getTime() + 7 * DAY);
const FULL = new Date(REGISTERED.getTime() + 30 * DAY);

const nova = {
  domainId: "d1",
  name: "nova.example",
  cap: 300,
  used: 300,
  pool: null as { cap: number; used: number; domains: number } | null,
  waiting: 214,
  resetsAt: RESET,
  registeredAt: REGISTERED as Date | null,
  steps: [
    { from: NOW, cap: 300 as number | null },
    { from: STEP, cap: 2000 },
    { from: FULL, cap: null },
  ],
  fullAt: FULL as Date | null,
};
type Limit = typeof nova;
const limit = (over: Partial<Limit> = {}): Limit => ({ ...nova, ...over });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  h.locale = "en";
});

/** What a reader sees: tags dropped, entities and no-break spaces read back. */
const decode = (text: string) =>
  text
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll(" ", " ");
const visible = (html: string) => decode(html.replace(/<[^>]+>/g, ""));
const tips = (html: string) =>
  [...html.matchAll(/data-tip="([^"]*)"/g)].map((m) => decode(m[1] ?? ""));
const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => {
  const html = renderToStaticMarkup(element);
  return { html, text: visible(html), tips: tips(html) };
};

describe("an Emails list row a hold waits for", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "e1",
    to: ["ada@example.com"],
    subject: "Confirm your email",
    latestStatus: "queued_quota" as const,
    createdAt: NOW,
    domainId: "d1",
    ...over,
  });
  const table = (rows: ReturnType<typeof row>[], limits?: Limit[]) =>
    render(createElement(EmailsTable, { rows, limits }));
  const time = formatTime(RESET, "en");

  it("names the daily limit, its domain and when it goes out, in your time", () => {
    const { html, text, tips } = table([row({ waitingFor: "domain_limit" })], [nova]);
    expect(html).toContain('class="ms-badge ms-badge-neutral">Waiting · daily limit<');
    expect(html).toContain('aria-label="Waiting · daily limit"');
    expect(tips).toContain(
      `nova.example sent its 300 emails for today. This one goes out after 00:00 UTC, at ${time} your time.`,
    );
    expect(text).toContain(`after ${time}`);
  });

  it("says the team's new domains share the day when that is what is spent", () => {
    const shared = limit({ used: 120, pool: { cap: 300, used: 300, domains: 2 } });
    const { tips } = table([row({ waitingFor: "domain_limit" })], [shared]);
    expect(tips).toContain(
      `Your new domains sent the 300 emails they share for today. This one goes out after 00:00 UTC, at ${time} your time.`,
    );
  });

  it("goes out within minutes once the day has room again", () => {
    const { text, tips } = table([row({ waitingFor: "domain_limit" })], [limit({ used: 10 })]);
    expect(tips).toContain(
      "nova.example has room again today, so this one goes out within minutes.",
    );
    expect(text).not.toContain("after ");
    expect(text).toContain("Waiting");
  });

  it("goes out on a later day when older mail fills the next reset, by its own place in line", () => {
    const later = new Date("2026-10-23T00:00:00Z");
    const { text, tips } = table([row({ waitingFor: "domain_limit", sendsAfter: later })], [nova]);
    expect(text).toContain(`after ${formatDayTime(later, "en")}`);
    expect(text).not.toContain(`after ${time}`);
    expect(tips).toContain(
      `nova.example sent its 300 emails for today. Older mail goes first, so this one goes out on ${formatDay(later, "en")}, about ${formatTime(later, "en")} your time.`,
    );
    h.locale = "pt-BR";
    expect(table([row({ waitingFor: "domain_limit", sendsAfter: later })], [nova]).text).toContain(
      `depois de ${formatDayTime(later, "pt-BR")}`,
    );
  });

  it("says a paused warm-up waits for it to resume, under the warm-up's own pill", () => {
    const { html, tips } = table([row({ waitingFor: "warmup_paused", broadcastId: "b1" })]);
    expect(html).toContain(">Waiting · warm-up<");
    expect(tips).toContain("The domain's warm-up is paused. This one goes out after it resumes.");
  });

  it("reads as a plain wait once its domain is out from under the limit", () => {
    const { html, tips } = table([row({ waitingFor: "domain_limit" })], []);
    expect(html).toContain('class="ms-badge ms-badge-neutral">Waiting<');
    expect(html).not.toContain("daily limit");
    // The tile's hover names the status, the When cell's the creation time: no reason.
    expect(tips.filter((tip) => tip !== "Waiting" && !tip.startsWith("Created"))).toEqual([]);
  });

  it("keeps the reason while the limits load, without the parts it needs them for", () => {
    const { html, text } = table([row({ waitingFor: "domain_limit" })]);
    expect(html).toContain(">Waiting · daily limit<");
    expect(text).not.toContain("after ");
  });

  it("names a broadcast copy's own warm-up and the plan's limit, with when it renews", () => {
    const resumes = new Date("2026-11-01T00:00:00Z");
    const { html, tips } = table(
      [
        row({ id: "w", waitingFor: "warmup", broadcastId: "b1" }),
        row({ id: "p", waitingFor: "plan", resumesAt: resumes }),
        row({ id: "c", waitingFor: "domain_limit", broadcastId: "b1" }),
      ],
      [nova],
    );
    expect(html).toContain(">Waiting · warm-up<");
    expect(html).toContain(">Waiting · plan limit<");
    // A copy the daily limit holds says so, not just "Queued in broadcast".
    expect(html.match(/>Waiting · daily limit</g)).toHaveLength(1);
    expect(html).not.toContain("Queued in broadcast");
    expect(tips).toContain(
      "The domain's warm-up sends a little more each day. This one goes out as the warm-up allows.",
    );
    expect(tips).toContain(
      `Your plan's limit is reached. This one goes out when it renews, ${formatDayTime(resumes, "en")}.`,
    );
  });

  it("keeps capacity and every silent hold a plain wait, with no reason or time", () => {
    const { html, text, tips } = table(
      [row({ id: "a", waitingFor: null }), row({ id: "b", waitingFor: null, broadcastId: "b1" })],
      [nova],
    );
    expect(html.match(/ms-badge-neutral">Waiting</g)).toHaveLength(1);
    expect(html).toContain('ms-badge-neutral">Queued in broadcast<');
    for (const word of ["daily limit", "warm-up", "plan", "review", "after "]) {
      expect(text).not.toContain(word);
    }
    expect(
      tips.every(
        (tip) => ["Waiting", "Queued in broadcast"].includes(tip) || tip.startsWith("Created"),
      ),
    ).toBe(true);
  });

  it("reads in Brazilian Portuguese", () => {
    h.locale = "pt-BR";
    const { html, text, tips } = table([row({ waitingFor: "domain_limit" })], [nova]);
    const hora = formatTime(RESET, "pt-BR");
    expect(html).toContain(">Aguardando · limite diário<");
    expect(text).toContain(`depois das ${hora}`);
    expect(tips).toContain(
      `nova.example já enviou os 300 e-mails de hoje. Este sai depois das 00:00 UTC, às ${hora} no seu horário.`,
    );
  });
});

describe("the Emails list's daily limit banner", () => {
  const banner = (limits: Limit[]) => render(createElement(LimitBanner, { limits }));
  const duration = formatHoursMinutes(RESET.getTime() - NOW.getTime());

  it("names the one domain holding mail, says when it goes out and that nothing broke", () => {
    const { html, text } = banner([
      nova,
      limit({ domainId: "d2", name: "idle.example", waiting: 0 }),
    ]);
    expect(text).toContain("214 emails are waiting for nova.example's daily limit.");
    expect(text).toContain(
      `It's a new domain, so it sends up to 300 emails a day for now. They go out on their own after 00:00 UTC, in ${duration}. Nothing is broken.`,
    );
    expect(html).toContain('href="/domains/d1"');
    expect(text).toContain("See the limit →");
    expect(text).not.toContain("Upgrade");
  });

  it("counts one email in the singular", () => {
    const { text } = banner([limit({ waiting: 1 })]);
    expect(text).toContain("1 email is waiting for nova.example's daily limit.");
    expect(text).toContain("The email goes out on its own after 00:00 UTC");
  });

  it("counts the domains when several hold mail, and links to all of them", () => {
    const { html, text } = banner([
      nova,
      limit({ domainId: "d2", name: "mail.example", waiting: 6 }),
    ]);
    expect(text).toContain("220 emails are waiting for the daily limits of 2 new domains.");
    expect(text).toContain("New domains send a limited number of emails a day for now.");
    expect(html).toContain('href="/domains"');
    expect(text).toContain("See the limits →");
  });

  it("says the team's new domains share the day when that is what is spent", () => {
    const pool = { cap: 2000, used: 2000, domains: 3 };
    const { text } = banner([limit({ used: 120, cap: 2000, pool })]);
    expect(text).toContain("214 emails are waiting for the daily limit your 3 new domains share.");
    expect(text).toContain("Together they send up to 2,000 emails a day for now.");
  });

  it("says minutes once the day has room again, and shows nothing while nothing waits", () => {
    expect(banner([limit({ used: 12 })]).text).toContain(
      "in the next few minutes. Nothing is broken.",
    );
    expect(banner([limit({ waiting: 0 })]).html).toBe("");
  });

  it("reads in Brazilian Portuguese", () => {
    h.locale = "pt-BR";
    const { text } = banner([nova]);
    expect(text).toContain("214 e-mails estão esperando o limite diário de nova.example.");
    expect(text).toContain("Eles saem sozinhos depois das 00:00 UTC");
    expect(text).toContain("Está tudo funcionando.");
  });
});

describe("the domain page's new domain limit", () => {
  const section = (
    over: Partial<Limit> = {},
    extra: Partial<Parameters<typeof LimitSection>[0]> = {},
  ) =>
    render(
      createElement(LimitSection, {
        domainId: "d1",
        domain: "nova.example",
        limit: limit(over),
        request: null,
        canManage: true,
        ...extra,
      }),
    );

  it("shows today's figures, the schedule ahead and the way to ask, in volumes and dates", () => {
    const { html, text } = section();
    expect(text).toContain("New domain limit");
    expect(text).toContain("Registered 3 days ago");
    expect(html).toContain('aria-label="300"');
    expect(text).toContain(`of 300 · resets at ${formatTime(RESET, "en")}`);
    expect(html).toContain('aria-label="214"');
    expect(text).toContain("go out after 00:00 UTC");
    expect(text).toContain(`From ${formatStepDay(STEP, "en")}`);
    expect(html).toContain('aria-label="2,000"');
    expect(text).toContain(`No limit from${formatDay(FULL, "en")}in 27 days, or sooner`);
    expect(text).toContain("How the limit grows");
    expect(text).toContain("300 go out · 300 sent214 more go out after 00:00 UTC");
    expect(text).toContain("up to 300 a dayThe 214 waiting go first");
    expect(text).toContain(`${formatStepDay(STEP, "en")}up to 2,000 a day`);
    expect(text).toContain(`${formatStepDay(FULL, "en")}No limit`);
    expect(text).toContain(
      "New domains start small because inbox providers are wary of mail from them. The limit grows on its own, and steady clean sending lifts it sooner. Mail over the day's limit waits and goes out the next day. A higher plan doesn't change it.",
    );
    expect(text).toContain("Moving mail you already send elsewhere?");
    expect(html).toContain(">Ask for a higher limit</button>");
    for (const word of ["tier", "Upgrade", "50"]) expect(text).not.toContain(word);
  });

  it("knows only today's cap for an unknown age, and says so plainly", () => {
    const { html, text } = section({ registeredAt: null, steps: [], fullAt: null });
    expect(text).not.toContain("Registered");
    expect(text).not.toContain("How the limit grows");
    expect(text).not.toContain("No limit from");
    expect(html).not.toContain("ms-steps");
    expect(text).toContain(
      "We couldn't find when this domain was registered, so steady clean sending is what lifts the limit.",
    );
  });

  it("says the team's new domains share the day, and counts against that once it binds", () => {
    const { text } = section({ used: 120, pool: { cap: 2000, used: 2000, domains: 2 } });
    expect(text).toContain(
      "Your team's 2 new domains share up to 2,000 emails a day between them.",
    );
    expect(text).toContain(
      `of 2,000 your new domains share · resets at ${formatTime(RESET, "en")}`,
    );
  });

  it("leaves the button to owners and admins, and shows a sent or declined request instead", () => {
    expect(section({}, { canManage: false }).html).not.toContain("<button");
    const asked = new Date("2026-10-19T12:00:00Z");
    const open = section({}, { request: { status: "open", createdAt: asked, resolvedAt: null } });
    expect(open.text).toContain(
      `Request sent ${formatDay(asked, "en")}. We'll email you when it's reviewed.`,
    );
    expect(open.html).not.toContain("<button");
    const declined = section(
      {},
      { request: { status: "declined", createdAt: asked, resolvedAt: NOW } },
    );
    expect(declined.text).toContain(
      `We reviewed your request from ${formatDay(asked, "en")} and kept the limit for now. If something changed, you can ask again.`,
    );
    expect(declined.html).toContain(">Ask for a higher limit</button>");
  });

  it("counts none, one and many apart", () => {
    expect(section({ waiting: 0 }).text).toContain("nothing is waiting");
    expect(section({ waiting: 1 }).text).toContain("1 more goes out after 00:00 UTC");
    expect(section({ waiting: 1 }).text).toContain("The 1 waiting goes first");
    expect(section({ registeredAt: new Date(NOW.getTime() - 3_600_000) }).text).toContain(
      "Registered today",
    );
  });

  it("reads in Brazilian Portuguese", () => {
    h.locale = "pt-BR";
    const { text } = section();
    expect(text).toContain("Limite de domínio novo");
    expect(text).toContain("Registrado há 3 dias");
    expect(text).toContain("Como o limite cresce");
    expect(text).toContain("Os 214 que estão esperando saem primeiro");
    expect(text).toContain("Um plano maior não muda isso.");
    expect(text).toContain("Pedir um limite maior");
  });

  it("warns while mail waits, and links to it", () => {
    const duration = formatHoursMinutes(RESET.getTime() - NOW.getTime());
    const { html, text } = render(createElement(LimitWaitingBanner, { limit: nova }));
    expect(text).toContain("214 emails waiting.");
    expect(text).toContain(
      `Today's 300 are sent. The rest go out after 00:00 UTC, in ${duration}, oldest first.`,
    );
    expect(html).toContain(
      'href="/emails?domain=d1&amp;status=queued_quota&amp;source=all&amp;range=all"',
    );
    expect(
      visible(
        renderToStaticMarkup(createElement(LimitWaitingBanner, { limit: limit({ waiting: 1 }) })),
      ),
    ).toContain(
      `1 email waiting.Today's 300 are sent. It goes out after 00:00 UTC, in ${duration}.`,
    );
    expect(
      renderToStaticMarkup(createElement(LimitWaitingBanner, { limit: limit({ waiting: 0 }) })),
    ).toBe("");
  });
});

describe("a limited domain on the Domains list", () => {
  const own = (name: string, over: Record<string, unknown> = {}) => ({
    id: name,
    name,
    region: "us-east-1",
    status: "verified",
    createdAt: NOW,
    trackingPending: false,
    limit: null,
    ...over,
  });
  const rows = () => {
    const html = renderToStaticMarkup(createElement(DomainsView, { awsBanner: null }));
    return (html.match(/<tbody>.*<\/tbody>/s)?.[0].match(/<tr>.*?<\/tr>/gs) ?? []).map((row) => ({
      text: visible(row),
      tips: tips(row),
    }));
  };

  it("tails its badge with today's cap and what waits, both and the schedule on hover", () => {
    h.domains = [
      own("nova.example", { limit: nova }),
      own("ageless.example", { limit: limit({ waiting: 0, steps: [], fullAt: null }) }),
      own("old.example"),
    ];
    const [limited, ageless, old] = rows();
    expect(limited?.text).toContain("Verified300 a day for now·214 waiting");
    // The tail may end in an ellipsis before what waits, so the hover leads with it.
    expect(limited?.tips).toContain(
      `214 waiting\nNew domain limit. Up to 300 emails a day until ${formatDay(STEP, "en")}, then 2,000 a day until ${formatDay(FULL, "en")}, then no limit. Mail over the limit waits for the next day.`,
    );
    expect(ageless?.text).toContain("300 a day for now");
    expect(ageless?.text).not.toContain("waiting");
    expect(ageless?.tips).toContain(
      "New domain limit. Up to 300 emails a day for now. Mail over the limit waits for the next day.",
    );
    expect(old?.text).not.toContain("a day for now");
  });

  it("reads in Brazilian Portuguese", () => {
    h.locale = "pt-BR";
    h.domains = [own("nova.example", { limit: nova })];
    const [limited] = rows();
    expect(limited?.text).toContain("300 por dia por enquanto·214 esperando");
    expect(limited?.tips).toContain(
      `214 esperando\nLimite de domínio novo. Até 300 e-mails por dia até ${formatDay(STEP, "pt-BR")}, depois 2.000 por dia até ${formatDay(FULL, "pt-BR")}, depois sem limite. O que passar do limite espera o dia seguinte.`,
    );
  });
});

describe("the composer's test send note", () => {
  const note = (result: Parameters<typeof TestSendNote>[0]["result"]) =>
    render(createElement(TestSendNote, { result })).text;

  it("never says sent while the test waits, naming only the daily limit", () => {
    expect(note({ kind: "sent", to: "ana@nova.example" })).toBe("✓ Test sent to ana@nova.example");
    expect(note({ kind: "queued", domain: "nova.example" })).toBe(
      "Test queued. nova.example's daily limit is used up, so it goes out after 00:00 UTC.",
    );
    expect(note({ kind: "queued", domain: null })).toBe(
      "Test queued. It goes out as soon as it can.",
    );
    h.locale = "pt-BR";
    expect(note({ kind: "queued", domain: "nova.example" })).toBe(
      "Teste na fila. O limite diário de nova.example acabou, então ele sai depois das 00:00 UTC.",
    );
  });
});

describe("how the limit grows, row by row", () => {
  const rail = async (over: Partial<Limit>) => {
    const { createTranslator } = await import("next-intl");
    const { limitRailSteps } = await import("@/lib/new-domain-limit");
    const t = createTranslator({
      locale: "en",
      messages: catalogs.en,
      namespace: "domains",
    }) as unknown as LimitTranslate;
    return limitRailSteps(limit(over), t, "en").map((row) =>
      [row.when, row.what, row.sub].filter(Boolean).join(" | "),
    );
  };

  it("gives the next reset its own row only while mail waits for it", async () => {
    expect(await rail({ waiting: 0 })).toEqual([
      "Today | 300 go out · 300 sent",
      `${formatStepDay(STEP, "en")} | up to 2,000 a day`,
      `${formatStepDay(FULL, "en")} | No limit`,
    ]);
  });

  it("puts a step that starts before the reset ahead of it, at the cap it brings", async () => {
    const soon = new Date(NOW.getTime() + 3_600_000);
    expect(
      await rail({
        steps: [
          { from: NOW, cap: 300 },
          { from: soon, cap: 2000 },
          { from: FULL, cap: null },
        ],
      }),
    ).toEqual([
      "Today | 300 go out · 300 sent | 214 more go out after 00:00 UTC",
      `${formatStepDay(soon, "en")} | up to 2,000 a day`,
      `${formatStepDay(new Date("2026-10-21T12:00:00Z"), "en")} | up to 2,000 a day | The 214 waiting go first`,
      `${formatStepDay(FULL, "en")} | No limit`,
    ]);
  });

  it("lets the waiting go at the next drain while today has room, with no reset row", async () => {
    expect(await rail({ used: 10 })).toEqual([
      "Today | 300 go out · 10 sent | The 214 waiting go out in a few minutes",
      `${formatStepDay(STEP, "en")} | up to 2,000 a day`,
      `${formatStepDay(FULL, "en")} | No limit`,
    ]);
  });

  it("folds a step that starts on the reset's UTC day into the reset's row, so each date shows once", async () => {
    expect(
      await rail({
        steps: [
          { from: NOW, cap: 300 },
          { from: new Date("2026-10-21T15:00:00Z"), cap: 2000 },
          { from: FULL, cap: null },
        ],
      }),
    ).toEqual([
      "Today | 300 go out · 300 sent | 214 more go out after 00:00 UTC",
      `${formatStepDay(new Date("2026-10-21T12:00:00Z"), "en")} | up to 2,000 a day | The 214 waiting go first`,
      `${formatStepDay(FULL, "en")} | No limit`,
    ]);
  });

  it("goes from the last capped step straight to no limit", async () => {
    expect(
      await rail({
        cap: 2000,
        used: 2000,
        steps: [
          { from: NOW, cap: 2000 },
          { from: FULL, cap: null },
        ],
      }),
    ).toEqual([
      "Today | 2,000 go out · 2,000 sent | 214 more go out after 00:00 UTC",
      `${formatStepDay(new Date("2026-10-21T12:00:00Z"), "en")} | up to 2,000 a day | The 214 waiting go first`,
      `${formatStepDay(FULL, "en")} | No limit`,
    ]);
  });
});
