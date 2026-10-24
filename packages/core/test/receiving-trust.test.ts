import { describe, expect, it } from "vitest";
import type { InboxSafety } from "../src/inboxes/safety.js";
import { defaultSafety } from "../src/inboxes/safety.js";
import { extractLinks } from "../src/links.js";
import { automatedReason } from "../src/receiving/automated.js";
import { decideScreening } from "../src/receiving/inbound-rules.js";
import { type SpamInput, spamVerdict } from "../src/receiving/spam.js";
import { senderTrust } from "../src/receiving/trust.js";

const PASS = { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" };
const NONE = { spf: "none", dkim: "none", dmarc: "none", arc: "none" };
const base = {
  authentication: PASS,
  authDetail: null,
  mailFrom: "bounce@mail.stripe.com",
  from: "support@stripe.com",
  fromFields: 1,
  fromMailboxes: 1,
  owners: ["ana@gmail.example"],
  allowlist: [] as string[],
};

describe("senderTrust", () => {
  it("ranks aligned senders: owner, allowlisted, external", () => {
    expect(senderTrust(base)).toBe("external");
    expect(senderTrust({ ...base, allowlist: ["*@stripe.com"] })).toBe("allowlisted");
    expect(senderTrust({ ...base, allowlist: ["support@stripe.com"] })).toBe("allowlisted");
    expect(senderTrust({ ...base, from: "ana@gmail.example", mailFrom: "ana@gmail.example" })).toBe(
      "owner",
    );
  });

  it("rebuilds alignment from the folded verdicts: p=none with aligned SPF, never another org's SPF or a foreign DKIM", () => {
    expect(senderTrust({ ...base, authentication: { ...NONE, spf: "pass" } })).toBe("external");
    expect(
      senderTrust({
        ...base,
        mailFrom: "x@sendgrid.example",
        authentication: { ...NONE, spf: "pass" },
      }),
    ).toBe("unauthenticated");
    expect(
      senderTrust({ ...base, mailFrom: "", authentication: { ...NONE, dkim: "policy" } }),
    ).toBe("unauthenticated");
  });

  it("ranks failed first, so a spoofed owner never rides a lower rule (S16, S17)", () => {
    expect(senderTrust({ ...base, authentication: { ...NONE, spf: "fail", dmarc: "fail" } })).toBe(
      "failed",
    );
    expect(
      senderTrust({
        ...base,
        from: "ana@gmail.example",
        authentication: { ...NONE, spf: "softfail", dmarc: "fail" },
      }),
    ).toBe("failed");
  });

  it("fails an enforced DMARC failure even when this parser reads no routable From", () => {
    const rejected = {
      spf: { result: "fail", domain: "evil.example" },
      dkim: { aligned: [] },
      dmarc: { result: "fail", policy: "reject" as const, domain: "stripe.com" },
    };
    expect(senderTrust({ ...base, from: "", authentication: NONE, authDetail: rejected })).toBe(
      "failed",
    );
    expect(senderTrust({ ...base, from: "", authentication: { ...NONE, dmarc: "fail" } })).toBe(
      "failed",
    );
    expect(senderTrust({ ...base, from: "" })).toBe("unauthenticated");
  });

  it("needs alignment for an allowlist entry, and one From with one mailbox for any trust (S17)", () => {
    expect(senderTrust({ ...base, allowlist: ["*@stripe.com"], authentication: NONE })).toBe(
      "unauthenticated",
    );
    expect(senderTrust({ ...base, fromMailboxes: 2, allowlist: ["*@stripe.com"] })).toBe(
      "unauthenticated",
    );
    expect(senderTrust({ ...base, fromFields: 2, owners: ["support@stripe.com"] })).toBe(
      "unauthenticated",
    );
  });

  it("owns only member logins and configured owners: another address at a team domain is external (S16)", () => {
    expect(
      senderTrust({
        ...base,
        from: "intern@gmail.example",
        mailFrom: "intern@gmail.example",
        owners: ["ana@gmail.example"],
      }),
    ).toBe("external");
  });

  it("gives a proven thread's participant known_thread without alignment, never a stranger", () => {
    const thread = { proven: true, participants: ["maria@smallbiz.example.br"] };
    const maria = {
      ...base,
      from: "maria@smallbiz.example.br",
      mailFrom: "maria@smallbiz.example.br",
    };
    expect(senderTrust({ ...maria, authentication: NONE, thread })).toBe("known_thread");
    expect(
      senderTrust({ ...maria, authentication: NONE, thread: { ...thread, proven: false } }),
    ).toBe("unauthenticated");
    expect(
      senderTrust({
        ...base,
        from: "eve@other.example",
        mailFrom: "eve@other.example",
        authentication: NONE,
        thread,
      }),
    ).toBe("unauthenticated");
  });

  it("trusts the MX's verdicts only for the From domain it judged: a From read another way is unauthenticated", () => {
    const evil = {
      spf: { result: "pass", domain: "evil.example" },
      dkim: { aligned: ["evil.example"] },
      dmarc: { result: "pass", policy: "reject" as const, domain: "evil.example" },
    };
    const owner = { ...base, from: "ana@gmail.example", authDetail: evil };
    expect(senderTrust(owner)).toBe("unauthenticated");
    expect(
      senderTrust({ ...owner, thread: { proven: true, participants: ["ana@gmail.example"] } }),
    ).toBe("unauthenticated");
    expect(
      senderTrust({
        ...owner,
        authDetail: { ...evil, dmarc: { result: "none", policy: null, domain: null } },
      }),
    ).toBe("unauthenticated");
  });

  it("reads the MX's unfolded detail when present: p=none failures are unauthenticated, enforced ones failed", () => {
    const detail = (
      result: string,
      policy: "none" | "quarantine" | "reject" | null,
      aligned: string[] = [],
    ) => ({
      spf: { result: "pass", domain: "mail.stripe.com" },
      dkim: { aligned },
      dmarc: { result, policy, domain: "stripe.com" },
    });
    expect(senderTrust({ ...base, authentication: NONE, authDetail: detail("pass", "none") })).toBe(
      "external",
    );
    expect(
      senderTrust({
        ...base,
        authentication: { ...NONE, dmarc: "none" },
        authDetail: detail("fail", "none"),
      }),
    ).toBe("unauthenticated");
    expect(
      senderTrust({ ...base, authentication: NONE, authDetail: detail("fail", "reject") }),
    ).toBe("failed");
    // No DMARC record: an aligned DKIM signature or aligned SPF still aligns.
    expect(
      senderTrust({
        ...base,
        authentication: { ...NONE, spf: "pass" },
        authDetail: detail("none", null),
      }),
    ).toBe("external");
    expect(
      senderTrust({
        ...base,
        authentication: { ...NONE, spf: "fail" },
        authDetail: { ...detail("none", null), spf: { result: "fail", domain: "x.example" } },
      }),
    ).toBe("failed");
  });
});

describe("automatedReason (RFC 3834)", () => {
  const ok = { mailFrom: "m@x.example", from: "m@x.example", subject: "Re: order" };
  it("names each automated shape in order", () => {
    expect(automatedReason({ ...ok, headers: {} })).toBeNull();
    expect(automatedReason({ ...ok, headers: { "auto-submitted": "auto-replied" } })).toBe(
      "auto_submitted",
    );
    expect(automatedReason({ ...ok, headers: { "auto-submitted": "no" } })).toBeNull();
    expect(automatedReason({ ...ok, headers: { precedence: "bulk" } })).toBe("precedence");
    expect(automatedReason({ ...ok, headers: { "list-id": "<x.lists.example>" } })).toBe(
      "mailing_list",
    );
    expect(
      automatedReason({ ...ok, headers: { "x-auto-response-suppress": "OOF, AutoReply" } }),
    ).toBe("suppress_requested");
    expect(automatedReason({ ...ok, headers: { "x-autoreply": "" } })).toBe("auto_reply");
    expect(automatedReason({ ...ok, mailFrom: "", headers: {} })).toBe("null_sender");
    expect(
      automatedReason({
        ...ok,
        headers: { "content-type": "multipart/report; report-type=delivery-status" },
      }),
    ).toBe("report");
    expect(automatedReason({ ...ok, from: "no-reply@x.example", headers: {} })).toBe(
      "no_reply_address",
    );
    expect(automatedReason({ ...ok, subject: "Resposta automática: Pedido", headers: {} })).toBe(
      "auto_reply_subject",
    );
    expect(automatedReason({ ...ok, subject: "Automatic reply: hello", headers: {} })).toBe(
      "auto_reply_subject",
    );
    expect(automatedReason({ ...ok, subject: "Auto insurance quote", headers: {} })).toBeNull();
  });
});

const spam = (overrides: Partial<SpamInput> = {}) =>
  spamVerdict({
    tier: "external",
    authentication: PASS,
    helo: "mail.sender.example",
    mxHost: "mx.millionsend.example",
    recipientDomains: ["inbound.acme.example"],
    mailFrom: "bounces@sender.example",
    report: false,
    hasDate: true,
    hasMessageId: true,
    from: "billing@sender.example",
    fromName: "Sender Billing",
    replyTo: [],
    hiddenText: { chars: 0, preview_chars: 0, invisible_chars: 0, flags: [] },
    links: [],
    attachmentNames: [],
    ...overrides,
  });

describe("spamVerdict", () => {
  it("passes a clean, aligned transactional mail", () => {
    expect(spam()).toEqual({ verdict: "pass", score: 0, reasons: [] });
  });

  it("fails a forged brand with a failing SPF and an HTML attachment", () => {
    const r = spam({
      tier: "unauthenticated",
      authentication: { ...NONE, spf: "fail" },
      from: "x@evil.example",
      fromName: "support@paypal.example",
      attachmentNames: ["invoice.html"],
    });
    expect(r.verdict).toBe("fail");
    expect(r.reasons).toEqual(
      expect.arrayContaining(["spf_fail", "display_name_address", "dangerous_attachment"]),
    );
  });

  it("grays an unauthenticated newsletter linking through a shortener", () => {
    const r = spam({
      tier: "unauthenticated",
      authentication: NONE,
      links: extractLinks('<a href="https://bit.ly/abc">Read more</a>', null),
    });
    expect(r).toMatchObject({ verdict: "gray", reasons: ["no_auth", "shortener"] });
  });

  it("scores forged HELOs, null senders, missing headers, hidden text and link lures", () => {
    const r = spam({
      helo: "inbound.acme.example",
      mailFrom: "",
      hasDate: false,
      hasMessageId: false,
      replyTo: ["collect@other.example"],
      hiddenText: {
        chars: 450,
        preview_chars: 50,
        invisible_chars: 25,
        flags: ["alternative_mismatch"],
      },
      links: extractLinks(
        '<a href="https://203.0.113.9/login">paypal.example</a><a href="https://evil.example/x">paypal.example/account</a>',
        null,
      ),
    });
    expect(r.reasons).toEqual([
      "helo_forged",
      "null_sender",
      "no_date",
      "no_message_id",
      "reply_to_mismatch",
      "hidden_text",
      "invisible_chars",
      "alternative_mismatch",
      "ip_link",
      "anchor_domain_mismatch",
    ]);
    expect(r.verdict).toBe("fail");
    // A bounce is a report, not a null-sender red flag.
    expect(spam({ mailFrom: "", report: true }).reasons).not.toContain("null_sender");
    expect(spam({ helo: "localhost" }).reasons).toEqual(["helo_bare"]);
  });
});

const agent = (overrides: Partial<InboxSafety> = {}) => ({
  ...defaultSafety("agent", false),
  ...overrides,
});
const human = (overrides: Partial<InboxSafety> = {}) => ({
  ...defaultSafety("human", false),
  ...overrides,
});
const decide = (p: Partial<Parameters<typeof decideScreening>[0]>) =>
  decideScreening({
    kind: "agent",
    safety: agent(),
    tier: "external",
    spam: "pass",
    virus: "pass",
    judgeAvailable: true,
    forwardedContent: false,
    ...p,
  });

describe("decideScreening", () => {
  it("follows the agent table: accept_from by tier", () => {
    const table: [string, string, string, string?][] = [
      ["owner", "verified", "deliver"],
      ["allowlisted", "allowlist", "deliver"],
      ["known_thread", "allowlist", "deliver"],
      ["external", "anyone", "judge"],
      ["external", "verified", "judge"],
      ["external", "allowlist", "quarantine", "not_allowlisted"],
      ["unauthenticated", "anyone", "judge"],
      ["unauthenticated", "verified", "quarantine", "unauthenticated_sender"],
      ["unauthenticated", "allowlist", "quarantine", "not_allowlisted"],
      ["failed", "anyone", "quarantine", "failed_auth"],
      ["failed", "verified", "quarantine", "failed_auth"],
    ];
    for (const [tier, accept, action, reason] of table) {
      const d = decide({
        tier: tier as never,
        safety: agent({ accept_from: accept as InboxSafety["accept_from"] }),
      });
      expect([tier, accept, d.action, d.reason]).toEqual([tier, accept, action, reason]);
    }
    // A listed address that didn't prove itself is held for its own reason, never as unlisted.
    for (const [tier, reason] of [
      ["unauthenticated", "unauthenticated_sender"],
      ["failed", "failed_auth"],
    ] as const) {
      expect(
        decide({ tier, listed: true, safety: agent({ accept_from: "allowlist" }) }).reason,
      ).toBe(reason);
    }
  });

  it("quarantines a virus on every kind and tier (S18)", () => {
    for (const kind of ["agent", "human"] as const) {
      expect(
        decide({
          kind,
          safety: kind === "agent" ? agent() : human(),
          tier: "owner",
          virus: "fail",
        }),
      ).toEqual({
        action: "quarantine",
        reason: "virus",
        verdict: "quarantined",
      });
    }
  });

  it("judges forwarded content from owners, and delivers when screening is off or no judge runs", () => {
    expect(decide({ tier: "owner", forwardedContent: true }).action).toBe("judge");
    expect(
      decide({ tier: "owner", forwardedContent: true, safety: agent({ screening: false }) }).action,
    ).toBe("deliver");
    expect(decide({ judgeAvailable: false })).toEqual({ action: "deliver", verdict: "clean" });
    expect(decide({})).toEqual({ action: "judge", verdict: "pending" });
  });

  it("delivers anything to a people's inbox open to anyone, a failed sender into spam", () => {
    expect(decide({ kind: "human", safety: human(), tier: "failed" })).toEqual({
      action: "spam",
      verdict: "suspicious",
    });
    // A people's inbox never waits on the judge.
    expect(
      decide({ kind: "human", safety: human({ accept_from: "verified" }), tier: "external" })
        .action,
    ).toBe("deliver");
    expect(
      decide({ kind: "human", safety: human({ accept_from: "verified" }), tier: "failed" }).reason,
    ).toBe("failed_auth");
  });

  it("sends failing spam to the spam folder and marks doubtful mail suspicious", () => {
    expect(decide({ judgeAvailable: false, spam: "fail" })).toEqual({
      action: "spam",
      verdict: "suspicious",
    });
    expect(decide({ judgeAvailable: false, spam: "gray" }).verdict).toBe("suspicious");
    expect(decide({ judgeAvailable: false, virus: "processing_failed" }).verdict).toBe(
      "suspicious",
    );
    expect(
      decide({
        tier: "unauthenticated",
        safety: agent({ accept_from: "anyone" }),
        judgeAvailable: false,
      }).verdict,
    ).toBe("suspicious");
  });
});
