import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDay, formatDayTime, formatRelative, formatStepDay, formatTime } from "@/lib/format";

const data = vi.hoisted(() => ({ email: undefined as unknown, locale: "en" as "en" | "pt-BR" }));

// The real catalogs, so the test reads what the timeline shows.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = {
    en: {
      emails: (await import("../messages/en/emails.json")).default,
      common: (await import("../messages/en/common.json")).default,
    },
    "pt-BR": {
      emails: (await import("../messages/pt-BR/emails.json")).default,
      common: (await import("../messages/pt-BR/common.json")).default,
    },
  };
  return {
    ...actual,
    useLocale: () => data.locale,
    useTranslations: (namespace: string) =>
      actual.createTranslator({
        locale: data.locale,
        messages: messages[data.locale],
        namespace: namespace as "emails",
      }),
  };
});
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "email-1" }) }));
// Every trpc helper answers with the procedure's path, so useQuery can tell them apart.
vi.mock("@/lib/trpc", () => {
  const at = (path: string[]): unknown =>
    new Proxy(() => ({ path: path.join(".") }), {
      get: (_target, key: string) => at([...path, key]),
      apply: () => ({ path: path.slice(0, -1).join(".") }),
    });
  return { useTRPC: () => at([]) };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { path: string }) => ({
    isPending: false,
    isError: false,
    data: options.path === "emails.get" ? data.email : undefined,
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/components/email-content-panel", () => ({ EmailContentPanel: () => null }));
vi.mock("@/components/api-sheet", () => ({ ApiDocsButton: () => null }));

const { default: EmailDetailPage } = await import("@/app/(dashboard)/emails/[id]/page");

function renderDelay(...delays: Record<string, unknown>[]): string {
  data.email = {
    id: "email-1",
    from: "sender@example.com",
    to: ["recipient@example.com"],
    cc: null,
    bcc: null,
    replyTo: null,
    subject: "Hello",
    tags: null,
    apiKeyName: null,
    broadcast: null,
    pending: null,
    latestStatus: "delivery_delayed",
    createdAt: new Date("2026-03-02T10:00:00.000Z"),
    sentAt: new Date("2026-03-02T10:00:01.000Z"),
    // Minutes apart at midday UTC: the same local day in every time zone.
    events: delays.map((deliveryDelay, i) => ({
      id: `ev-${i}`,
      type: "delivery_delayed",
      occurredAt: new Date(Date.UTC(2026, 2, 2, 12, i)),
      data: { eventType: "DeliveryDelay", deliveryDelay },
    })),
  };
  return renderToStaticMarkup(createElement(EmailDetailPage));
}

describe("a delivery delay on the email timeline", () => {
  it("says why, with the SMTP code and when SES stops retrying", () => {
    const html = renderDelay({
      delayType: "MailboxFull",
      expirationTime: "2026-03-03T00:15:00.000Z",
      delayedRecipients: [{ diagnosticCode: "smtp; 452 4.2.2 Mailbox full" }],
    });
    expect(html).toContain(
      `mailbox full · 452 4.2.2 · retries until ${formatDayTime("2026-03-03T00:15:00.000Z", "en")}`,
    );
  });

  it("shows an unknown delay type as SES sent it and skips a bad expiration", () => {
    const html = renderDelay({ delayType: "NewKindOfDelay", expirationTime: "not a date" });
    expect(html).toContain(">NewKindOfDelay<");
    expect(html).not.toContain("retries until");
  });

  it("reads a day's repeated delays from the latest, whose time the node shows", () => {
    const html = renderDelay(
      { delayType: "TransientCommunicationFailure" },
      { delayType: "MailboxFull" },
    );
    expect(html).toContain(">mailbox full<");
    expect(html).not.toContain("connection failure");
  });
});

describe("a row a warm-up holds", () => {
  const render = (kind: string) => {
    data.email = {
      id: "email-1",
      from: "news@example.com",
      to: ["recipient@example.com"],
      cc: null,
      bcc: null,
      replyTo: null,
      subject: "Hello",
      tags: null,
      apiKeyName: null,
      broadcast: { id: "broadcast-1", name: "October news" },
      pending: { kind },
      latestStatus: "queued_quota",
      createdAt: new Date("2026-03-02T10:00:00.000Z"),
      sentAt: null,
      events: [],
    };
    return renderToStaticMarkup(createElement(EmailDetailPage));
  };
  const WARMING = "This domain sends a little more each day, most active contacts first.";
  const PAUSED = "Waiting for the warm-up to resume";
  const NEW_DOMAIN = "Waiting for the daily limit";

  it("waits on the domain's own warm-up while it warms", () => {
    const html = render("warmup");
    expect(html).toContain(WARMING);
    expect(html).not.toContain(PAUSED);
    expect(html).not.toContain(NEW_DOMAIN);
  });

  it("waits for a paused warm-up to resume", () => {
    const html = render("warmupPaused");
    expect(html).toContain(PAUSED);
    expect(html).toContain("This email goes out after it resumes.");
    expect(html).not.toContain(WARMING);
  });

  it("never reads as the new domain limit", () => {
    for (const kind of ["warmup", "warmupPaused", "waiting"]) {
      expect(render(kind)).not.toContain(NEW_DOMAIN);
    }
  });
});

describe("an email the new domain limit holds", () => {
  const NOW = new Date("2026-10-20T21:31:00Z");
  const RESET = new Date("2026-10-21T00:00:00Z");
  const hold = (over: Record<string, unknown> = {}) => ({
    kind: "newDomainLimit",
    domainId: "d1",
    domain: "nova.example",
    cap: 300,
    used: 300,
    pool: null,
    ahead: 41,
    sendsAfter: RESET,
    resetsAt: RESET,
    ...over,
  });
  const render = (pending: Record<string, unknown>) => {
    data.email = {
      id: "email-1",
      from: "Nova <hello@nova.example>",
      to: ["rafael.n@example.org"],
      cc: null,
      bcc: null,
      replyTo: null,
      subject: "Confirm your email",
      tags: null,
      apiKeyName: "Production",
      broadcast: null,
      pending,
      sendingDomain: { id: "d1", name: "nova.example", cap: 300 },
      latestStatus: "queued_quota",
      createdAt: new Date(NOW.getTime() - 17 * 60_000),
      sentAt: null,
      events: [],
    };
    const html = renderToStaticMarkup(createElement(EmailDetailPage));
    return {
      html,
      text: html
        .replace(/<wbr\/>/g, "")
        .replace(/<[^>]+>/g, "|")
        .replaceAll("&#x27;", "'")
        .replaceAll("\u00a0", " ")
        .replace(/\|+/g, "|"),
    };
  };
  const time = formatTime(RESET, "en");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    data.locale = "en";
  });

  it("says what holds it, how far along the line it is and when it goes out", () => {
    const { html, text } = render(hold());
    // The subtitle's parts, each its own span.
    expect(text).toContain(
      `|Accepted ${formatRelative(new Date(NOW.getTime() - 17 * 60_000), "en")} ·| |goes out after ${time}|`,
    );
    expect(html).toContain('aria-label="Waiting for the daily limit"');
    expect(text).toContain("|Waiting for nova.example's daily limit.|");
    expect(text).toContain(
      `|It sent its 300 emails for today. This one goes out after 00:00 UTC, about ${time} your time. You don't need to do anything.|`,
    );
    expect(html).toContain('href="/domains/d1"');
    expect(text).toContain("|Sending domain|nova.example|300 a day for now|");
    expect(text).toContain(
      "|Waiting for the daily limit|300 of 300 sent today|nova.example is a new domain. 41 emails are ahead of this one.|",
    );
    expect(text).toContain(
      `|Expected send|estimate|after 00:00 UTC|About ${time} your time. Waiting mail goes out oldest first.|`,
    );
    // Only the expected send is an estimate: the hold itself is a fact.
    expect(html.match(/>estimate</g)).toHaveLength(1);
    expect(text).not.toContain("Upgrade");
  });

  it("names a later day once the line runs past the next reset", () => {
    const later = new Date(RESET.getTime() + 86_400_000);
    const { text } = render(hold({ sendsAfter: later, ahead: 1 }));
    expect(text).toContain(`goes out on ${formatDay(later, "en")}|`);
    expect(text).toContain(
      `This one goes out on ${formatDay(later, "en")}, about ${formatTime(later, "en")} your time.`,
    );
    expect(text).toContain("1 email is ahead of this one.");
    expect(text).toContain(`|Expected send|estimate|${formatStepDay(later, "en")}|`);
  });

  it("goes out in minutes once the day has room, and nothing ahead reads as nothing", () => {
    const { text } = render(hold({ used: 120, ahead: 0, sendsAfter: NOW }));
    expect(text).toContain("goes out in a few minutes|");
    expect(text).toContain(
      "|Waiting for nova.example's daily limit.|This one goes out in the next few minutes. You don't need to do anything.|",
    );
    expect(text).toContain("Nothing is ahead of this one.");
    expect(text).toContain(
      "|Expected send|estimate|in a few minutes|Waiting mail goes out oldest first.|",
    );
  });

  it("says the team's new domains share the day when that is what is spent", () => {
    const { text } = render(hold({ used: 120, pool: { cap: 300, used: 300, domains: 2 } }));
    expect(text).toContain("Your new domains sent the 300 emails they share for today.");
    expect(text).toContain("|300 of 300 sent today by your new domains|");
  });

  it("reads in Brazilian Portuguese", () => {
    data.locale = "pt-BR";
    const hora = formatTime(RESET, "pt-BR");
    const { text } = render(hold());
    expect(text).toContain("|Aguardando o limite diário de nova.example.|");
    expect(text).toContain(
      `Ele já enviou os 300 e-mails de hoje. Este sai depois das 00:00 UTC, por volta das ${hora} no seu horário. Você não precisa fazer nada.`,
    );
    expect(text).toContain(
      "|300 de 300 enviados hoje|nova.example é um domínio novo. 41 e-mails estão na frente deste.|",
    );
    expect(text).toContain("|Domínio de envio|nova.example|300 por dia por enquanto|");
  });
});
