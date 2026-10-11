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

const { EmailContentPanel } = await import("@/components/email-content-panel");
const { ReceivedEmailsTable } = await import("@/app/(dashboard)/emails/received-list");

describe("a received email's content panel", () => {
  const html = renderToStaticMarkup(
    createElement(EmailContentPanel, {
      email: {
        id: "e1",
        subject: "Hi",
        html: '<p>Hi <img src="https://tracker.example/pixel.gif"></p>',
        text: "Hi",
        insights: null,
      },
      received: { headers: { from: "Ana <ana@sender.example>", received: "from a\nfrom b" } },
    }),
  );

  it("renders the stranger's HTML in a frame that runs nothing and loads nothing", () => {
    const frame = /<iframe[^>]*>/.exec(html)?.[0] ?? "";
    // No allow-scripts, no allow-same-origin, no allow-forms: an opaque, inert origin.
    expect(frame).toContain('sandbox="allow-popups allow-popups-to-escape-sandbox"');
    expect(frame).toMatch(
      /srcdoc="&lt;meta http-equiv=&quot;Content-Security-Policy&quot; content=&quot;default-src &#x27;none&#x27;; img-src data:;/i,
    );
  });

  it("offers its headers where a sent email offers insights", () => {
    expect(html).toContain(">Headers<");
    expect(html).not.toContain(">Insights<");
  });
});

describe("the Receiving list", () => {
  it("shows who wrote, which address got it, and how it checked out", () => {
    const html = renderToStaticMarkup(
      createElement(ReceivedEmailsTable, {
        rows: [
          {
            id: "r1",
            from: "ana@sender.example",
            receivedFor: ["agent@inbound.acme.test", "other@inbound.acme.test"],
            subject: "",
            authentication: { spf: "pass", dkim: "none", dmarc: "fail", arc: "none" },
            attachmentCount: 2,
            createdAt: new Date(),
          },
        ],
      }),
    );
    expect(html).toContain('href="/emails/receiving/r1"');
    expect(html).toContain(">+1<");
    expect(html).toContain("(no subject)");
    expect(html).toContain('aria-label="SPF pass" class="ms-badge ms-badge-success"');
    expect(html).toContain('aria-label="DMARC fail" class="ms-badge ms-badge-danger"');
    expect(html).toContain('aria-label="DKIM none" class="ms-badge ms-badge-neutral"');
    expect(html).not.toContain('aria-label="ARC');
  });
});
