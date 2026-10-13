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

function renderDelay(deliveryDelay: Record<string, unknown>): string {
  const event = { eventType: "DeliveryDelay", deliveryDelay };
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
    events: [{ id: "ev-1", type: "delivery_delayed", occurredAt: new Date(), data: event }],
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
});
