import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { EmailsTable } = await import("@/components/emails-table");

describe("the Emails list", () => {
  const html = renderToStaticMarkup(
    createElement(EmailsTable, {
      rows: [
        {
          id: "e1",
          to: ["inbox-k3v9x2rq@fabrikam.example.com", "ops@example.com", "cto@example.com"],
          subject: "Welcome aboard",
          latestStatus: "delivered",
          createdAt: new Date(),
          sentAt: new Date(),
        },
      ],
    }),
  );

  it("keeps the first address and its +N on one line, the address cut before the +N", () => {
    expect(html).not.toContain("ms-cell-wrap");
    expect(html).not.toContain("<wbr");
    const to = html.match(/<td class="ms-cell-fill ms-mono">(.*?)<\/td>/)?.[1] ?? "";
    expect(to).toMatch(
      /^<span class="ms-lead"><span class="ms-tooltip-trigger inline"[^>]*><span role="img"[^>]*>.*?<\/span><\/span><a class="ms-lead-value" href="\/emails\/e1"><span class="ms-truncate">inbox-k3v9x2rq@fabrikam\.example\.com<\/span><\/a><span class="ms-tooltip-trigger inline"[^>]*><span class="ms-lead-more">\+2<\/span><\/span><\/span>$/,
    );
    expect(html).toContain('<th style="width:35%">To</th>');
    expect(html).toContain('<th style="width:14%">Status</th>');
  });

  it("names the status on the envelope tile in the badge's own words", () => {
    expect(html).toMatch(
      /role="img" aria-label="Delivered" style="[^"]*color:var\(--ms-success\)"/,
    );
    expect(html).toContain('class="ms-badge ms-badge-success">Delivered<');
  });
});
