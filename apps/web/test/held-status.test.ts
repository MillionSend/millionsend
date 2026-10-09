import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The real English catalogs, so the test reads what a customer reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = {
    broadcasts: (await import("../messages/en/broadcasts.json")).default,
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { SendingStatus } = await import("@/app/(dashboard)/broadcasts/parts");
const { EmailsTable } = await import("@/components/emails-table");

const LINE = "Delivery is paused for now and resumes automatically.";

describe("a send waiting out a region hold", () => {
  it("reads as delayed on the broadcast, with the one line in place of the progress", () => {
    const html = renderToStaticMarkup(
      createElement(SendingStatus, {
        status: "sending",
        progress: { sentCount: 2, parkedCount: 4, recipients: 9, finishesAt: null },
        planHold: null,
        held: true,
        locale: "en",
      }),
    );
    expect(html).toContain(">Delayed</span>");
    expect(html).toContain(LINE);
    expect(html).not.toContain("waiting");
  });

  it("reads as delayed on its emails, and only on its own", () => {
    const row = {
      to: ["ada@example.com"],
      subject: "News",
      latestStatus: "queued_quota" as const,
      createdAt: new Date(),
      broadcastId: "b1",
    };
    const html = renderToStaticMarkup(
      createElement(EmailsTable, {
        rows: [
          { ...row, id: "e1", held: true },
          { ...row, id: "e2", held: false },
        ],
      }),
    );
    expect(html.match(/>Delayed</g)).toHaveLength(1);
    expect(html).toContain(">Queued in broadcast<");
  });
});
