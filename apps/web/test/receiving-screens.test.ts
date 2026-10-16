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
    pending: false,
    quarantined: false,
    suspicious: false,
    createdAt: new Date(),
  };
  const render = (rows: ReceivedRow[]) =>
    renderToStaticMarkup(createElement(ReceivedEmailsTable, { rows }));
  /** A row's tile: the tooltip trigger holding the labelled tile, and its glyph. */
  const tile = (html: string, label: string) =>
    html.match(new RegExp(`<span role="img" aria-label="${label}"[^>]*>(.*?)</span>`))?.[1];

  it("shows who wrote, which address got it and what it is about, from its new home", () => {
    const html = render([row]);
    expect(html).toContain('href="/inboxes/received/r1"');
    expect(html).toContain(">+1<");
    expect(html).toContain("(no subject)");
    expect(html).not.toContain("/emails/receiving/");
  });

  it("keeps From and Inbox to one line each, the +N beside its address", () => {
    const html = render([row]);
    expect(html).not.toContain("ms-cell-wrap");
    expect(html).not.toContain("<wbr");
    const [from, inbox] = [...html.matchAll(/<td class="ms-cell-fill ms-mono">(.*?)<\/td>/g)].map(
      (match) => match[1] ?? "",
    );
    expect(from).toContain('class="ms-truncate">ana@sender.example<');
    // No tile and no link in the Inbox column: the address, then +N with the rest in its tooltip.
    expect(inbox).toMatch(
      /^<span class="ms-lead"><span class="ms-lead-value"><span class="ms-truncate">agent@inbound\.acme\.test<\/span><\/span><span class="ms-tooltip-trigger inline"[^>]*><span class="ms-lead-more">\+1<\/span><\/span><\/span>$/,
    );
  });

  it("names a found code or link without its value, and flags held, spam and virus mail", () => {
    const html = render([
      { ...row, id: "a", extractedKinds: ["code", "link"] },
      { ...row, id: "b", quarantined: true },
      { ...row, id: "c", spamVerdict: "fail" },
      { ...row, id: "d", virusVerdict: "fail", quarantined: true },
    ]);
    // Each chip in a tooltip saying what was found.
    expect(html).toMatch(/class="ms-tooltip-trigger inline"[^>]*><span class="ms-chip"[^>]*>code</);
    expect(html).toMatch(/class="ms-tooltip-trigger inline"[^>]*><span class="ms-chip"[^>]*>link</);
    expect(html).toContain('class="ms-badge ms-badge-danger">Quarantined<');
    expect(html).toContain('class="ms-badge ms-badge-warn">Spam<');
    // Malware outranks the hold it caused.
    expect(html).toContain('class="ms-badge ms-badge-danger">Virus<');
  });

  it("leads each row with a tile naming its state, the badge only where the mail is not clean", () => {
    const html = render([
      { ...row, id: "v", virusVerdict: "fail" },
      { ...row, id: "q", quarantined: true, pending: true },
      { ...row, id: "p", pending: true },
      { ...row, id: "s", spamVerdict: "fail", suspicious: true },
      { ...row, id: "x", suspicious: true },
      { ...row, id: "u", virusVerdict: "processing_failed" },
      { ...row, id: "c" },
    ]);
    for (const label of [
      "Virus",
      "Quarantined",
      "Being screened",
      "Spam",
      "Suspicious",
      "Not scanned (scanner unavailable)",
      "Clean",
    ]) {
      expect(
        html.match(new RegExp(`role="img" aria-label="${label.replace(/[()]/g, "\\$&")}"`, "g")),
        label,
      ).toHaveLength(1);
    }
    // Still being screened is not quarantined: a muted clock and its own word.
    expect(html).toContain('class="ms-badge ms-badge-neutral">Screening<');
    expect(html.match(/>Quarantined</g)).toHaveLength(1);
    expect(html).toContain('class="ms-badge ms-badge-warn">Suspicious<');
    expect(html).toContain('class="ms-badge ms-badge-neutral">Not scanned<');
    // Spam is a warning, not an alarm, on the tile as on the badge.
    expect(html).toMatch(/aria-label="Spam" style="[^"]*color:var\(--ms-warn\)/);
    expect(html).toMatch(/aria-label="Virus" style="[^"]*color:var\(--ms-danger\)/);
    // No virus verdict at all is no scanner, which reads as clean: no badge.
    expect(html.match(/class="ms-badge /g)).toHaveLength(6);
    expect(tile(html, "Clean")).toContain('viewBox="0 0 16 16"');
  });

  it("puts a paperclip before the attachment count, and says the count in words", () => {
    const html = render([row]);
    expect(html).toMatch(
      /<span role="img" aria-label="2 attachments" class="ms-mono"[^>]*><svg width="12" height="12"[^>]*stroke-width="2"[^>]*>.*?<\/svg>2<\/span>/,
    );
  });
});
