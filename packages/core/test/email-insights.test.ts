import { describe, expect, it } from "vitest";
import {
  CHECKS,
  type CheckId,
  type EmailInsightsInput,
  evaluateEmailInsights,
  SCORE_VERSION,
  scoreBand,
} from "../src/email-insights.js";

const NOW = new Date("2026-08-30T12:00:00Z");
const fresh = () => new Date(NOW.getTime() - 60 * 60 * 1000);

const BODY =
  "<html><body><p>Hello there, thanks for reading this update from our team today.</p>" +
  '<a href="https://mail.acme.com/welcome">Welcome</a></body></html>';

const UNSUB_ANCHOR = '<a href="https://app.acme.com/unsubscribe/tok">Unsubscribe</a>';
const BODY_MKT = BODY.replace("</body>", `${UNSUB_ANCHOR}</body>`);

const UNSUB_HEADERS = {
  "List-Unsubscribe": "<https://app.acme.com/unsubscribe/tok>",
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
};

function input(over: Partial<EmailInsightsInput> = {}): EmailInsightsInput {
  return {
    html: BODY,
    preTrackingHtml: BODY,
    text: "Hello there, thanks for reading.",
    from: "Acme <hello@mail.acme.com>",
    senderDomain: "mail.acme.com",
    subject: "Welcome to Acme",
    finalHeaders: {},
    hasAttachments: false,
    replyTo: null,
    isBroadcast: false,
    hasTopic: false,
    tracking: {
      clickEnabled: false,
      openEnabled: false,
      brandedHostUsed: false,
      sharedFallbackUsed: false,
      shippedUntracked: false,
    },
    domainSnapshot: { dmarcPolicy: "reject", dmarcCheckedAt: fresh() },
    now: NOW,
    ...over,
  };
}

/** Marketing baseline: broadcast with our injected headers and a visible unsubscribe link. */
function mkt(over: Partial<EmailInsightsInput> = {}): EmailInsightsInput {
  return input({
    isBroadcast: true,
    finalHeaders: UNSUB_HEADERS,
    html: BODY_MKT,
    preTrackingHtml: BODY_MKT,
    ...over,
  });
}

function check(inp: EmailInsightsInput, id: CheckId) {
  const c = evaluateEmailInsights(inp).checks.find((r) => r.id === id);
  if (!c) throw new Error(`missing check ${id}`);
  return c;
}

describe("catalog contract", () => {
  it("freezes ids, severities, weights, applicability and order (wire names)", () => {
    expect(SCORE_VERSION).toBe(1);
    expect(CHECKS.map((c) => `${c.id}:${c.severity}:${c.weightHundredths}:${c.applies}`)).toEqual([
      "dmarc_record:critical:350:all",
      "auth_alignment:critical:350:all",
      "list_unsubscribe:major:150:marketing",
      "link_domains_match:major:125:all",
      "no_shorteners:major:125:all",
      "body_size:major:100:all",
      "plain_text:major:100:all",
      "visible_unsubscribe:major:100:marketing",
      "phishing_links:major:100:all",
      "no_reply_from:minor:50:marketing",
      "svg_images:minor:50:all",
      "attachments_marketing:minor:50:marketing",
      "image_text_ratio:minor:40:all",
      "tracking_unbranded:minor:40:all",
      "root_domain_send:minor:25:marketing",
      "insecure_links:minor:25:all",
      "subject_lint:minor:25:all",
      "image_alt_text:info:0:all",
      "images_offsite:info:0:all",
      "bimi_ready:info:0:all",
      "reply_to_present:info:0:all",
    ]);
  });

  it("emits results in catalog order", () => {
    const { checks } = evaluateEmailInsights(input());
    expect(checks.map((c) => c.id)).toEqual(CHECKS.map((c) => c.id));
  });
});

describe("marketing classification", () => {
  it("promotes on broadcast, topic, List-Unsubscribe header, or unsubscribe anchor", () => {
    expect(evaluateEmailInsights(input({ isBroadcast: true })).marketing).toBe(true);
    expect(evaluateEmailInsights(input({ hasTopic: true })).marketing).toBe(true);
    expect(
      evaluateEmailInsights(input({ finalHeaders: { "List-Unsubscribe": "<x>" } })).marketing,
    ).toBe(true);
    expect(evaluateEmailInsights(input({ preTrackingHtml: BODY_MKT })).marketing).toBe(true);
  });

  it("stays transactional when no marketing signal is present", () => {
    expect(evaluateEmailInsights(input()).marketing).toBe(false);
  });
});

describe("dmarc_record", () => {
  it("is unknown without a snapshot, without a check time, or when stale", () => {
    expect(check(input({ domainSnapshot: null }), "dmarc_record").status).toBe("unknown");
    expect(
      check(
        input({ domainSnapshot: { dmarcPolicy: "reject", dmarcCheckedAt: null } }),
        "dmarc_record",
      ).status,
    ).toBe("unknown");
    const stale = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    expect(
      check(
        input({ domainSnapshot: { dmarcPolicy: "reject", dmarcCheckedAt: stale } }),
        "dmarc_record",
      ).status,
    ).toBe("unknown");
  });

  it("fails on a fresh snapshot with no record", () => {
    const c = check(
      input({ domainSnapshot: { dmarcPolicy: null, dmarcCheckedAt: fresh() } }),
      "dmarc_record",
    );
    expect(c.status).toBe("fail");
    expect(c.penaltyHundredths).toBe(350);
  });

  it("passes with the policy in detail", () => {
    const c = check(
      input({ domainSnapshot: { dmarcPolicy: "none", dmarcCheckedAt: fresh() } }),
      "dmarc_record",
    );
    expect(c.status).toBe("pass");
    expect(c.detail).toEqual({ policy: "none" });
  });
});

describe("auth_alignment", () => {
  it("is always passed_by_design (verification gates sending)", () => {
    const c = check(input(), "auth_alignment");
    expect(c.status).toBe("passed_by_design");
    expect(c.detail).toEqual({ reason: "domain_verification_gates_sending" });
    expect(c.penaltyHundredths).toBe(0);
  });
});

describe("list_unsubscribe", () => {
  it("is not_applicable for transactional email", () => {
    expect(check(input(), "list_unsubscribe").status).toBe("not_applicable");
  });

  it("fails a broadcast missing the headers", () => {
    const c = check(input({ isBroadcast: true }), "list_unsubscribe");
    expect(c.status).toBe("fail");
    expect(c.penaltyHundredths).toBe(150);
  });

  it("is passed_by_design when our broadcast/topic injection supplied them", () => {
    expect(check(mkt(), "list_unsubscribe").status).toBe("passed_by_design");
    expect(check(mkt({ isBroadcast: false, hasTopic: true }), "list_unsubscribe").status).toBe(
      "passed_by_design",
    );
  });

  it("passes when the caller supplied both headers, case-insensitively", () => {
    const c = check(
      input({
        finalHeaders: {
          "list-unsubscribe": "<mailto:u@acme.com>",
          "LIST-UNSUBSCRIBE-POST": "List-Unsubscribe=One-Click",
        },
      }),
      "list_unsubscribe",
    );
    expect(c.status).toBe("pass");
  });

  it("fails when only List-Unsubscribe is present without -Post", () => {
    expect(
      check(input({ finalHeaders: { "List-Unsubscribe": "<x>" } }), "list_unsubscribe").status,
    ).toBe("fail");
  });
});

describe("link_domains_match", () => {
  it("is not_applicable without http(s) links", () => {
    expect(
      check(input({ preTrackingHtml: "<p>no links here at all</p>" }), "link_domains_match").status,
    ).toBe("not_applicable");
  });

  it("passes when ANY link shares the sender registrable domain", () => {
    const html = '<a href="https://other.example/x">a</a><a href="https://acme.com/y">b</a>';
    expect(check(input({ preTrackingHtml: html }), "link_domains_match").status).toBe("pass");
  });

  it("fails with unique registrable domains capped at 10", () => {
    const hosts = Array.from({ length: 12 }, (_, i) => `host${i}.example${i}.com`);
    const html = hosts.map((h) => `<a href="https://${h}/x">l</a>`).join("");
    const c = check(input({ preTrackingHtml: html }), "link_domains_match");
    expect(c.status).toBe("fail");
    expect(c.penaltyHundredths).toBe(125);
    expect(c.detail?.linkDomains).toEqual(Array.from({ length: 10 }, (_, i) => `example${i}.com`));
  });
});

describe("no_shorteners", () => {
  it("is not_applicable without links and passes on clean links", () => {
    expect(check(input({ preTrackingHtml: "<p>x</p>" }), "no_shorteners").status).toBe(
      "not_applicable",
    );
    expect(check(input(), "no_shorteners").status).toBe("pass");
  });

  it("fails on a shortener host, exact or subdomain", () => {
    const html = '<a href="https://bit.ly/x">a</a><a href="https://www.youtu.be/v">b</a>';
    const c = check(input({ preTrackingHtml: html }), "no_shorteners");
    expect(c.status).toBe("fail");
    expect(c.detail?.shorteners).toEqual(["bit.ly", "www.youtu.be"]);
    expect(c.detail?.note).toBeUndefined();
  });

  it("notes the double-redirect trap when click tracking is on", () => {
    const c = check(
      input({
        preTrackingHtml: '<a href="https://bit.ly/x">a</a>',
        tracking: {
          clickEnabled: true,
          openEnabled: false,
          brandedHostUsed: true,
          sharedFallbackUsed: false,
          shippedUntracked: false,
        },
      }),
      "no_shorteners",
    );
    expect(c.detail?.note).toBe("double_redirect_with_click_tracking");
  });
});

describe("body_size", () => {
  it("is not_applicable for text-only mail", () => {
    expect(check(input({ html: null, preTrackingHtml: null }), "body_size").status).toBe(
      "not_applicable",
    );
  });

  it("measures the FINAL html, not the pre-tracking one", () => {
    const big = `<p>${"x".repeat(103_000)}</p>`;
    const c = check(input({ html: big }), "body_size");
    expect(c.status).toBe("fail");
    expect(c.detail?.htmlSizeBytes).toBe(Buffer.byteLength(big, "utf8"));
  });

  it("passes under the clip limit with the size in detail", () => {
    const c = check(input(), "body_size");
    expect(c.status).toBe("pass");
    expect(c.detail?.htmlSizeBytes).toBe(Buffer.byteLength(BODY, "utf8"));
  });
});

describe("plain_text", () => {
  it("is not_applicable for text-only mail", () => {
    expect(check(input({ html: null, preTrackingHtml: null }), "plain_text").status).toBe(
      "not_applicable",
    );
  });

  it("fails on a missing or trivially short text part", () => {
    expect(check(input({ text: null }), "plain_text").status).toBe("fail");
    expect(check(input({ text: "  hi     " }), "plain_text").status).toBe("fail");
  });

  it("passes with a real text part", () => {
    expect(check(input(), "plain_text").status).toBe("pass");
  });
});

describe("visible_unsubscribe", () => {
  it("is not_applicable for transactional email and for html-less marketing email", () => {
    expect(check(input(), "visible_unsubscribe").status).toBe("not_applicable");
    expect(
      check(
        mkt({ html: null, preTrackingHtml: null, text: "hello there friend" }),
        "visible_unsubscribe",
      ).status,
    ).toBe("not_applicable");
  });

  it("passes via href match before the clip point", () => {
    const c = check(mkt(), "visible_unsubscribe");
    expect(c.status).toBe("pass");
    expect(c.detail).toEqual({ beforeClipPoint: true });
  });

  it("passes via visible text match (pt-BR included)", () => {
    const html = `${BODY.replace("</body>", '<a href="https://acme.com/x">Descadastre-se</a></body>')}`;
    expect(check(mkt({ preTrackingHtml: html }), "visible_unsubscribe").status).toBe("pass");
  });

  it("fails when absent", () => {
    const c = check(mkt({ preTrackingHtml: BODY }), "visible_unsubscribe");
    expect(c.status).toBe("fail");
    expect(c.penaltyHundredths).toBe(100);
  });

  it("fails when the link sits past the Gmail clip point", () => {
    const html = `<p>${"x".repeat(103_000)}</p>${UNSUB_ANCHOR}`;
    const c = check(mkt({ preTrackingHtml: html }), "visible_unsubscribe");
    expect(c.status).toBe("fail");
    expect(c.detail).toEqual({ beforeClipPoint: false });
  });
});

describe("phishing_links", () => {
  it("is not_applicable without links and passes clean anchors", () => {
    expect(check(input({ preTrackingHtml: "<p>x</p>" }), "phishing_links").status).toBe(
      "not_applicable",
    );
    expect(check(input(), "phishing_links").status).toBe("pass");
  });

  it("fails an IP-literal host (v4 and v6)", () => {
    const html =
      '<a href="https://192.168.1.10/login">Login</a><a href="http://[2001:db8::1]/x">x</a>';
    const c = check(input({ preTrackingHtml: html }), "phishing_links");
    expect(c.status).toBe("fail");
    expect(c.detail?.reasons).toContain("ip_literal_host");
  });

  it("fails when visible text shows a different domain than the href", () => {
    const html = '<a href="https://evil.example/x">acme.com</a>';
    const c = check(input({ preTrackingHtml: html }), "phishing_links");
    expect(c.status).toBe("fail");
    expect(c.detail?.reasons).toEqual(["text_domain_mismatch"]);
  });

  it("does not flag text naming the same registrable domain", () => {
    const html = '<a href="https://www.acme.com/x">acme.com</a>';
    expect(check(input({ preTrackingHtml: html }), "phishing_links").status).toBe("pass");
  });

  it("fails when text claims https over an http href", () => {
    const html = '<a href="http://acme.com/x">https secure checkout</a>';
    const c = check(input({ preTrackingHtml: html }), "phishing_links");
    expect(c.status).toBe("fail");
    expect(c.detail?.reasons).toContain("text_claims_https");
  });
});

describe("no_reply_from", () => {
  it("is not_applicable for transactional email", () => {
    expect(check(input({ from: "Acme <no-reply@acme.com>" }), "no_reply_from").status).toBe(
      "not_applicable",
    );
  });

  it("fails no-reply local parts (en and pt variants)", () => {
    for (const local of ["no-reply", "noreply", "do-not-reply", "donotreply", "nao-responda"]) {
      const c = check(mkt({ from: `Acme <${local}@mail.acme.com>` }), "no_reply_from");
      expect(c.status).toBe("fail");
      expect(c.penaltyHundredths).toBe(50);
    }
  });

  it("passes a human-replyable sender", () => {
    expect(check(mkt(), "no_reply_from").status).toBe("pass");
  });
});

describe("svg_images", () => {
  it("is not_applicable with no images and no inline svg", () => {
    expect(check(input(), "svg_images").status).toBe("not_applicable");
  });

  it("fails inline svg and svg-by-extension (query tolerated)", () => {
    const inline = check(
      input({ preTrackingHtml: `${BODY}<svg viewBox="0 0 1 1"></svg>` }),
      "svg_images",
    );
    expect(inline.status).toBe("fail");
    expect(inline.detail).toEqual({ inline: true, linked: false });

    const linked = check(
      input({ preTrackingHtml: `${BODY}<img src="https://acme.com/a.svg?v=2">` }),
      "svg_images",
    );
    expect(linked.status).toBe("fail");
    expect(linked.detail).toEqual({ inline: false, linked: true });
  });

  it("passes raster images", () => {
    expect(
      check(
        input({ preTrackingHtml: `${BODY}<img src="https://acme.com/a.png" alt="a">` }),
        "svg_images",
      ).status,
    ).toBe("pass");
  });
});

describe("attachments_marketing", () => {
  it("not_applicable transactional / fail marketing-with-attachments / pass otherwise", () => {
    expect(check(input({ hasAttachments: true }), "attachments_marketing").status).toBe(
      "not_applicable",
    );
    const c = check(mkt({ hasAttachments: true }), "attachments_marketing");
    expect(c.status).toBe("fail");
    expect(c.penaltyHundredths).toBe(50);
    expect(check(mkt(), "attachments_marketing").status).toBe("pass");
  });
});

describe("image_text_ratio", () => {
  const IMG = '<img src="https://mail.acme.com/a.png" alt="a">';

  it("is not_applicable without images", () => {
    expect(check(input(), "image_text_ratio").status).toBe("not_applicable");
  });

  it("fails an image-heavy body with under 100 visible chars", () => {
    const c = check(input({ preTrackingHtml: `<p>Sale!</p>${IMG}${IMG}` }), "image_text_ratio");
    expect(c.status).toBe("fail");
    expect(c.detail).toEqual({ visibleTextChars: 5, imageCount: 2 });
  });

  it("passes with enough visible text (style/script stripped from the count)", () => {
    const html = `<style>p{color:red}</style><p>${"word ".repeat(30)}</p>${IMG}`;
    expect(check(input({ preTrackingHtml: html }), "image_text_ratio").status).toBe("pass");
  });
});

describe("tracking_unbranded", () => {
  const t = (over: Partial<EmailInsightsInput["tracking"]>) =>
    input({
      tracking: {
        clickEnabled: true,
        openEnabled: true,
        brandedHostUsed: false,
        sharedFallbackUsed: false,
        shippedUntracked: false,
        ...over,
      },
    });

  it("passes when tracking is off", () => {
    const c = check(input(), "tracking_unbranded");
    expect(c.status).toBe("pass");
    expect(c.detail).toEqual({ tracking: "off" });
  });

  it("fails a send shipped untracked for want of a subdomain", () => {
    const c = check(t({ shippedUntracked: true }), "tracking_unbranded");
    expect(c.status).toBe("fail");
    expect(c.detail).toEqual({ reason: "no_tracking_subdomain" });
  });

  it("fails the shared fallback host", () => {
    const c = check(t({ sharedFallbackUsed: true }), "tracking_unbranded");
    expect(c.status).toBe("fail");
    expect(c.detail).toEqual({ reason: "shared_tracking_host" });
    expect(c.penaltyHundredths).toBe(40);
  });

  it("passes a branded host", () => {
    const c = check(t({ brandedHostUsed: true }), "tracking_unbranded");
    expect(c.status).toBe("pass");
    expect(c.detail).toEqual({ tracking: "branded" });
  });
});

describe("root_domain_send", () => {
  it("is not_applicable for transactional email", () => {
    expect(check(input({ senderDomain: "acme.com" }), "root_domain_send").status).toBe(
      "not_applicable",
    );
  });

  it("fails apex sends, multi-part suffixes included", () => {
    expect(check(mkt({ senderDomain: "acme.com" }), "root_domain_send").status).toBe("fail");
    expect(check(mkt({ senderDomain: "acme.com.br" }), "root_domain_send").status).toBe("fail");
  });

  it("passes subdomain sends", () => {
    expect(check(mkt(), "root_domain_send").status).toBe("pass");
    expect(check(mkt({ senderDomain: "news.acme.com.br" }), "root_domain_send").status).toBe(
      "pass",
    );
  });
});

describe("insecure_links", () => {
  it("not_applicable without links, fail on http, pass on https", () => {
    expect(check(input({ preTrackingHtml: "<p>x</p>" }), "insecure_links").status).toBe(
      "not_applicable",
    );
    const c = check(
      input({
        preTrackingHtml: '<a href="http://acme.com/a">a</a><a href="https://acme.com/b">b</a>',
      }),
      "insecure_links",
    );
    expect(c.status).toBe("fail");
    expect(c.detail).toEqual({ httpLinkCount: 1 });
    expect(check(input(), "insecure_links").status).toBe("pass");
  });
});

describe("subject_lint", () => {
  it("fails shouting subjects (8+ letters, >60% uppercase)", () => {
    expect(check(input({ subject: "LIMITED TIME OFFER NOW" }), "subject_lint").status).toBe("fail");
  });

  it("fails runs of !!! or ???", () => {
    expect(check(input({ subject: "Really?!" }), "subject_lint").status).toBe("pass");
    expect(check(input({ subject: "Wow!!!" }), "subject_lint").status).toBe("fail");
  });

  it("passes normal subjects and short all-caps ones", () => {
    expect(check(input(), "subject_lint").status).toBe("pass");
    expect(check(input({ subject: "OK GO" }), "subject_lint").status).toBe("pass");
  });
});

describe("image_alt_text", () => {
  it("not_applicable without images; fails missing or empty alt; passes real alt", () => {
    expect(check(input(), "image_alt_text").status).toBe("not_applicable");
    expect(
      check(input({ preTrackingHtml: '<img src="https://a.com/x.png">' }), "image_alt_text").status,
    ).toBe("fail");
    expect(
      check(input({ preTrackingHtml: '<img src="https://a.com/x.png" alt=" ">' }), "image_alt_text")
        .status,
    ).toBe("fail");
    expect(
      check(
        input({ preTrackingHtml: '<img src="https://a.com/x.png" alt="Chart">' }),
        "image_alt_text",
      ).status,
    ).toBe("pass");
  });
});

describe("images_offsite", () => {
  it("not_applicable without images", () => {
    expect(check(input(), "images_offsite").status).toBe("not_applicable");
  });

  it("fails offsite hosts with registrable domains in detail (max 5)", () => {
    const html = Array.from(
      { length: 7 },
      (_, i) => `<img src="https://cdn.host${i}.com/a.png" alt="a">`,
    ).join("");
    const c = check(input({ preTrackingHtml: html }), "images_offsite");
    expect(c.status).toBe("fail");
    expect(c.detail?.imageDomains).toEqual(Array.from({ length: 5 }, (_, i) => `host${i}.com`));
  });

  it("passes images on the sender registrable domain or without a host", () => {
    const html = '<img src="https://static.acme.com/a.png" alt="a"><img src="cid:inline1" alt="b">';
    expect(check(input({ preTrackingHtml: html }), "images_offsite").status).toBe("pass");
  });
});

describe("bimi_ready", () => {
  it("passes enforcing policies, fails p=none and no-record, unknown without a snapshot", () => {
    expect(
      check(
        input({ domainSnapshot: { dmarcPolicy: "quarantine", dmarcCheckedAt: fresh() } }),
        "bimi_ready",
      ).status,
    ).toBe("pass");
    expect(check(input(), "bimi_ready").status).toBe("pass");
    const none = check(
      input({ domainSnapshot: { dmarcPolicy: "none", dmarcCheckedAt: fresh() } }),
      "bimi_ready",
    );
    expect(none.status).toBe("fail");
    expect(none.detail).toEqual({ needs: "p=quarantine or p=reject" });
    expect(
      check(input({ domainSnapshot: { dmarcPolicy: null, dmarcCheckedAt: fresh() } }), "bimi_ready")
        .status,
    ).toBe("fail");
    expect(check(input({ domainSnapshot: null }), "bimi_ready").status).toBe("unknown");
  });
});

describe("reply_to_present", () => {
  it("is not_applicable unless no_reply_from failed", () => {
    expect(check(mkt(), "reply_to_present").status).toBe("not_applicable");
    expect(check(input({ from: "Acme <no-reply@acme.com>" }), "reply_to_present").status).toBe(
      "not_applicable",
    );
  });

  it("passes/fails on Reply-To when the From is no-reply", () => {
    const noReply = { from: "Acme <no-reply@mail.acme.com>" };
    expect(
      check(mkt({ ...noReply, replyTo: ["support@acme.com"] }), "reply_to_present").status,
    ).toBe("pass");
    expect(check(mkt(noReply), "reply_to_present").status).toBe("fail");
  });
});

describe("scoring", () => {
  const canonical = (dmarcPolicy: "reject" | null): EmailInsightsInput =>
    mkt({
      from: "Acme <no-reply@mail.acme.com>",
      replyTo: ["support@acme.com"],
      preTrackingHtml: BODY_MKT.replace("</body>", '<a href="https://bit.ly/x1">More</a></body>'),
      tracking: {
        clickEnabled: true,
        openEnabled: true,
        brandedHostUsed: false,
        sharedFallbackUsed: true,
        shippedUntracked: false,
      },
      domainSnapshot: { dmarcPolicy, dmarcCheckedAt: fresh() },
    });

  it("canonical worked vector: 1000-350-125-90 = 435 → 44 → at_risk", () => {
    const res = evaluateEmailInsights(canonical(null));
    const failed = res.checks.filter((c) => c.status === "fail");
    expect(failed.map((c) => [c.id, c.penaltyHundredths])).toEqual([
      ["dmarc_record", 350],
      ["no_shorteners", 125],
      ["no_reply_from", 50],
      ["tracking_unbranded", 40],
      ["bimi_ready", 0],
    ]);
    expect(res.scoreTenths).toBe(44);
    expect(scoreBand(res.scoreTenths)).toBe("at_risk");
  });

  it("same email with DMARC passing → 785 → 79 → good", () => {
    const res = evaluateEmailInsights(canonical("reject"));
    expect(res.scoreTenths).toBe(79);
    expect(scoreBand(res.scoreTenths)).toBe("good");
  });

  it("transactional OTP: marketing checks not_applicable, score stays 100", () => {
    const otp = input({
      from: "Acme Security <no-reply@acme.com>",
      senderDomain: "acme.com",
      subject: "Your login code",
      html: "<p>Your code is 123456. It expires in ten minutes.</p>",
      preTrackingHtml: "<p>Your code is 123456. It expires in ten minutes.</p>",
      text: "Your code is 123456. It expires in ten minutes.",
    });
    const res = evaluateEmailInsights(otp);
    expect(res.marketing).toBe(false);
    for (const id of [
      "list_unsubscribe",
      "visible_unsubscribe",
      "no_reply_from",
      "attachments_marketing",
      "root_domain_send",
    ] as const) {
      expect(res.checks.find((c) => c.id === id)?.status).toBe("not_applicable");
    }
    expect(res.checks.some((c) => c.status === "fail")).toBe(false);
    expect(res.scoreTenths).toBe(100);
    expect(scoreBand(res.scoreTenths)).toBe("excellent");
  });

  it("caps the minor tier at 150: eight minor fails → 850 → 85", () => {
    const allMinors = mkt({
      from: "Acme <no-reply@acme.com>",
      senderDomain: "acme.com",
      hasAttachments: true,
      subject: "LIMITED TIME OFFER!!!",
      html: BODY,
      preTrackingHtml:
        '<html><body><svg viewBox="0 0 1 1"></svg><img src="https://acme.com/pic.svg">' +
        '<a href="http://acme.com/unsubscribe/tok">Unsubscribe</a></body></html>',
      tracking: {
        clickEnabled: true,
        openEnabled: false,
        brandedHostUsed: false,
        sharedFallbackUsed: false,
        shippedUntracked: true,
      },
    });
    const res = evaluateEmailInsights(allMinors);
    const failedMinors = res.checks.filter((c) => c.status === "fail" && c.severity === "minor");
    expect(failedMinors.map((c) => c.id).sort()).toEqual([
      "attachments_marketing",
      "image_text_ratio",
      "insecure_links",
      "no_reply_from",
      "root_domain_send",
      "subject_lint",
      "svg_images",
      "tracking_unbranded",
    ]);
    expect(failedMinors.reduce((s, c) => s + c.penaltyHundredths, 0)).toBe(305);
    // No critical/major fails: only the capped 150 comes off.
    expect(res.checks.some((c) => c.status === "fail" && c.severity === "major")).toBe(false);
    expect(res.scoreTenths).toBe(85);
  });

  it("floors the score at 0 when penalties exceed 1000", () => {
    const disaster = input({
      isBroadcast: true,
      text: null,
      html: `<p>${"x".repeat(103_000)}</p><a href="http://bit.ly/x">https://acme-login.com</a>`,
      preTrackingHtml: `<p>${"x".repeat(103_000)}</p><a href="http://bit.ly/x">https://acme-login.com</a>`,
      domainSnapshot: { dmarcPolicy: null, dmarcCheckedAt: fresh() },
    });
    const res = evaluateEmailInsights(disaster);
    expect(res.scoreTenths).toBe(0);
    expect(scoreBand(res.scoreTenths)).toBe("at_risk");
  });

  it("rounds hundredths to tenths (435 → 44, 785 → 79)", () => {
    expect(evaluateEmailInsights(canonical(null)).scoreTenths).toBe(44);
    expect(evaluateEmailInsights(canonical("reject")).scoreTenths).toBe(79);
  });

  it("bands scoreTenths at 90/70/50", () => {
    expect(scoreBand(100)).toBe("excellent");
    expect(scoreBand(90)).toBe("excellent");
    expect(scoreBand(89)).toBe("good");
    expect(scoreBand(70)).toBe("good");
    expect(scoreBand(69)).toBe("needs_attention");
    expect(scoreBand(50)).toBe("needs_attention");
    expect(scoreBand(49)).toBe("at_risk");
    expect(scoreBand(0)).toBe("at_risk");
  });

  it("is deterministic: identical input yields deep-equal output", () => {
    const a = evaluateEmailInsights(canonical(null));
    const b = evaluateEmailInsights(canonical(null));
    expect(b).toEqual(a);
  });
});
