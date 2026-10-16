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
const { ReceivedEvents } = await import("@/app/(dashboard)/inboxes/received/[id]/received-email");
const { receivedEventLook } = await import("@/components/email-status-icon");
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

describe("a received email's events strip", () => {
  type StripEmail = Parameters<typeof ReceivedEvents>[0]["email"];
  const at = (ms: number) => new Date(Date.UTC(2026, 9, 16, 14, 32) + ms);
  const inbox: StripEmail["memberships"][number] = {
    inboxId: "i1",
    address: "support-desk@inbound.acme.test",
    kind: "agent",
    threadId: "t1",
    verdict: "clean",
    senderTrust: "external",
    quarantineReason: null,
    reasons: [],
    injectionScore: null,
    phishingScore: null,
    deliveredAt: at(1200),
    quarantinedAt: null,
    releasedAt: null,
    releasedByName: null,
  };
  const email: StripEmail = {
    createdAt: at(0),
    spam: { verdict: "pass", score: 1, reasons: [] },
    virus: { verdict: null, signature: null },
    memberships: [inbox],
    activity: [],
    webhook: null,
  };
  const render = (overrides: Partial<StripEmail> = {}) =>
    renderToStaticMarkup(createElement(ReceivedEvents, { email: { ...email, ...overrides } }));
  /** Each node's own markup, in strip order. */
  const nodes = (html: string) =>
    html
      .split('class="ms-events-node"')
      .slice(1)
      .map((node) => node.split('class="ms-events-gap"')[0] ?? "");
  /** Each connector's label, in strip order. */
  const gaps = (html: string) =>
    [...html.matchAll(/class="ms-events-gap"><span[^>]*>([^<]*)</g)].map((match) => match[1]);

  it("draws every step as the sent strip does: tile first, then pill, time and detail", () => {
    const [received, scanned, delivered] = nodes(render());
    for (const node of [received, scanned, delivered]) {
      // The tile leads, so phones keep the label column beside it.
      expect(node).toMatch(
        /^><span style="position:relative;display:inline-flex"><span[^>]*width:34px/,
      );
    }
    expect(received).toContain(">Received<");
    expect(received).toContain('title="2026-10-16 14:32:00.000 UTC"');
    // A scan keeps no time: a pill and its verdicts only.
    expect(scanned).toContain(">Scanned<");
    expect(scanned).not.toContain(" UTC");
    expect(scanned).toContain(">Not spam · Not scanned<");
  });

  it("names the inbox under a short Delivered pill, wrapping the address", () => {
    const delivered = nodes(render())[2] ?? "";
    expect(delivered).toContain("color:var(--ms-success)");
    expect(delivered).toMatch(/white-space:nowrap">Delivered</);
    const detail = /<span class="ms-mono"[^>]*>(.*?)<\/span>/.exec(delivered);
    expect(detail?.[0]).toContain("white-space:normal;overflow-wrap:anywhere");
    expect(detail?.[1]?.replaceAll("<wbr/>", "")).toBe("support-desk@inbound.acme.test");
  });

  it("tones spam amber, as the list's Spam badge, and malware red", () => {
    const spam = nodes(render({ spam: { verdict: "fail", score: 15, reasons: [] } }))[1] ?? "";
    expect(spam).toContain("color:var(--ms-warn)");
    expect(spam).not.toContain("var(--ms-danger)");
    const virus = nodes(
      render({ virus: { verdict: "fail", signature: "Eicar-Test-Signature" } }),
    )[1];
    expect(virus).toContain("color:var(--ms-danger)");
    expect(virus).toContain(">Not spam · Virus: Eicar-Test-Signature<");
  });

  it("times each gap from the last timed step, blank into an untimed or earlier one", () => {
    expect(gaps(render())).toEqual(["\u00a0", "+1.2 s"]);
    const html = render({
      activity: [{ action: "email.sent", at: at(301_200), by: "Ana" }],
      webhook: { status: "success", responseCode: 200, at: at(1210) },
    });
    // The webhook went out with the delivery, before the reply listed ahead of it.
    expect(gaps(html)).toEqual(["\u00a0", "+1.2 s", "+5 m", "\u00a0"]);
    // The pulse marks the newest step, the reply, not the last one listed.
    const pulsing = nodes(html).map((node) => node.includes("ms-pulse"));
    expect(pulsing).toEqual([false, false, false, true, false]);
  });

  it("names who released a held message under a short Released pill", () => {
    const html = render({
      memberships: [
        {
          ...inbox,
          verdict: "released",
          quarantineReason: "injection",
          injectionScore: 91,
          phishingScore: 4,
          quarantinedAt: at(2400),
          releasedAt: at(902_400),
          releasedByName: "Ana Souza",
          deliveredAt: at(902_580),
        },
      ],
    });
    const [, , screened, quarantined, released] = nodes(html);
    expect(screened).toContain(">injection 91 · phishing 4<");
    expect(quarantined).toContain(">prompt injection<");
    expect(released).toContain('white-space:nowrap">Released<');
    expect(released).toContain(">by Ana Souza<");
    expect(gaps(html)).toEqual(["\u00a0", "\u00a0", "+2.4 s", "+15 m", "+180 ms"]);
  });

  it("picks each step's tone and glyph by its verdict, a scan's first match first", () => {
    // shield-alert's mark; the spam octagon draws the same two strokes the other way round.
    const alert = 'd="M12 8v4"></path><path d="M12 16h.01"';
    const cases: [Parameters<typeof receivedEventLook>[0], string, string][] = [
      [{ type: "received" }, "muted", 'points="22 12 16 12 14 15 10 15 8 12 2 12"'],
      [{ type: "scanned", spam: "fail", virus: "fail" }, "danger", 'd="M14.12 3.88 16 2"'],
      [{ type: "scanned", spam: "fail", virus: "pass" }, "warn", 'd="M15.312 2'],
      [{ type: "scanned", spam: "gray", virus: "pass" }, "warn", alert],
      [{ type: "scanned", spam: "pass", virus: "processing_failed" }, "warn", alert],
      [{ type: "scanned", spam: "pass", virus: "pass" }, "muted", 'd="m9 12 2 2 4-4"'],
      [{ type: "scanned", spam: "pass", virus: null }, "muted", 'd="M12 22V2"'],
      [
        { type: "screened", verdict: "released", quarantineReason: "phishing" },
        "danger",
        'd="M18.944',
      ],
      [{ type: "screened", verdict: "suspicious", quarantineReason: null }, "warn", 'd="M18.944'],
      [{ type: "screened", verdict: "clean", quarantineReason: null }, "muted", 'd="M18.944'],
      [{ type: "quarantined" }, "danger", 'd="M7 11V7a5 5 0 0 1 10 0v4"'],
      [{ type: "released" }, "info", 'd="M7 11V7a5 5 0 0 1 9.9-1"'],
      [{ type: "delivered" }, "success", 'd="m5.2 8.2 2 2 3.6-4"'],
      [{ type: "replied" }, "info", 'd="m9 17-5-5 5-5"'],
      [{ type: "forwarded" }, "info", 'd="m15 17 5-5-5-5"'],
      [{ type: "webhook", status: "success" }, "success", 'd="M18 16.98'],
      [{ type: "webhook", status: "pending" }, "muted", 'd="M18 16.98'],
      [{ type: "webhook", status: "exhausted" }, "danger", 'd="M18 16.98'],
    ];
    for (const [step, tone, path] of cases) {
      const look = receivedEventLook(step);
      const svg = renderToStaticMarkup(createElement("span", null, look.glyph));
      const name = JSON.stringify(step);
      expect(look.color, name).toBe(`var(--ms-${tone})`);
      expect(svg, name).toContain(path);
      // Lucide's 24-unit glyphs sit at the weight of the 16-unit delivered check.
      expect(svg, name).toContain(
        step.type === "delivered"
          ? 'stroke-width="1.5"'
          : 'width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"',
      );
    }
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
