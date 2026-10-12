import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReceivedRow } from "@/app/(dashboard)/inboxes/received/received-list";

// The real English catalogs, so the test reads what a customer reads.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = {
    emails: (await import("../messages/en/emails.json")).default,
    common: (await import("../messages/en/common.json")).default,
    inboxes: (await import("../messages/en/inboxes.json")).default,
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
const { ReceivedEmailsTable } = await import("@/app/(dashboard)/inboxes/received/received-list");

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

describe("the All received list", () => {
  const row: ReceivedRow = {
    id: "r1",
    from: "ana@sender.example",
    fromName: "Ana",
    receivedFor: ["agent@inbound.acme.test", "other@inbound.acme.test"],
    subject: "",
    attachmentCount: 2,
    extractedKinds: [],
    spamVerdict: null,
    virusVerdict: null,
    held: false,
    createdAt: new Date(),
  };
  const render = (rows: ReceivedRow[]) =>
    renderToStaticMarkup(createElement(ReceivedEmailsTable, { rows }));

  it("shows who wrote, which address got it and what it is about, from its new home", () => {
    const html = render([row]);
    expect(html).toContain('href="/inboxes/received/r1"');
    expect(html).toContain(">+1<");
    expect(html).toContain("(no subject)");
    expect(html).not.toContain("/emails/receiving/");
  });

  it("names a found code or link without its value, and flags held, spam and virus mail", () => {
    const html = render([
      { ...row, id: "a", extractedKinds: ["code", "link"] },
      { ...row, id: "b", held: true },
      { ...row, id: "c", spamVerdict: "fail" },
      { ...row, id: "d", virusVerdict: "fail", held: true },
    ]);
    expect(html).toContain(">code<");
    expect(html).toContain(">link<");
    expect(html).toContain('class="ms-badge ms-badge-danger">Quarantined<');
    expect(html).toContain('class="ms-badge ms-badge-warn">Spam<');
    // Malware outranks the hold it caused.
    expect(html).toContain('class="ms-badge ms-badge-danger">Virus<');
  });
});
