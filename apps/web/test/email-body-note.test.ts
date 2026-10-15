import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { suppressedAtAccept } from "@/lib/email-events";

// The real English catalogs, so the test reads what a customer reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = {
    emails: (await import("../messages/en/emails.json")).default,
    common: (await import("../messages/en/common.json")).default,
  };
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace: keyof typeof messages) =>
      actual.createTranslator({ locale: "en", messages, namespace }),
  };
});

const { EmailContentPanel } = await import("@/components/email-content-panel");

type Event = { type: string; data: Record<string, unknown> | null };

function bodyNote(
  events: Event[],
  {
    hiddenBySupportView = false,
    bodyPurgedAt = new Date("2026-03-02T10:00:00.000Z"),
  }: { hiddenBySupportView?: boolean; bodyPurgedAt?: Date | null } = {},
): string {
  return renderToStaticMarkup(
    createElement(EmailContentPanel, {
      email: {
        id: "e1",
        subject: "Hi",
        html: null,
        text: null,
        insights: null,
        bodyPurgedAt,
        hiddenBySupportView,
        suppressedAtAccept: suppressedAtAccept(events),
      },
    }),
  );
}

describe("the body line of an email without a body", () => {
  const refused: Event[] = [
    { type: "suppressed", data: { source: "api", reason: "recipient_suppressed" } },
  ];

  it("says a send refused at accept never stored one, in a support view or unstamped too", () => {
    for (const html of [
      bodyNote(refused),
      bodyNote(refused, { hiddenBySupportView: true }),
      bodyNote(refused, { bodyPurgedAt: null }),
    ]) {
      expect(html).toContain("Not sent: every recipient is suppressed, so no content was stored.");
      expect(html).not.toContain("Body purged");
    }
  });

  it("keeps the retention purge for the worker's suppressions and everything else", () => {
    const others: Event[][] = [
      [{ type: "suppressed", data: { source: "worker", reason: "recipient_suppressed" } }],
      [{ type: "sent", data: null }],
      [],
    ];
    for (const events of others) {
      expect(bodyNote(events)).toContain("Body purged after retention window.");
    }
  });
});
