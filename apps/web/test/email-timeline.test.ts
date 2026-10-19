import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { formatDayTime } from "@/lib/format";

const data = vi.hoisted(() => ({ email: undefined as unknown }));

// The real English catalogs, so the test reads what the timeline shows.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = {
    emails: (await import("../messages/en/emails.json")).default,
    common: (await import("../messages/en/common.json")).default,
  };
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace: string) =>
      actual.createTranslator({ locale: "en", messages, namespace: namespace as "emails" }),
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
  const NEW_DOMAIN = "Newly registered domains send a little more each day.";

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

  it("waits on the new domain limit otherwise", () => {
    const html = render("newDomainLimit");
    expect(html).toContain(NEW_DOMAIN);
    expect(html).not.toContain(WARMING);
    expect(html).not.toContain(PAUSED);
  });
});
