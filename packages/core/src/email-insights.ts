import { ANCHOR_HREF } from "./link-tracking.js";
import { isRootDomainSend, registrableDomain } from "./org-domain.js";
import { parseMailbox } from "./sender-address.js";

/**
 * Pure email-insights check/score engine. No I/O, no DB, no clock — staleness
 * math uses the caller-supplied `now`. Check ids, severities and weights are
 * frozen wire names shared with the API and UI.
 *
 * PRIVACY INVARIANT: check `detail` payloads may carry bare hostnames, counts,
 * sizes, booleans and policy strings ONLY — never full URLs, paths, query
 * strings, or content excerpts. Insights rows outlive the encrypted body
 * purge; anything richer would become a retention bypass.
 */
export const SCORE_VERSION = 1;

export type CheckStatus = "pass" | "fail" | "passed_by_design" | "not_applicable" | "unknown";
export type CheckSeverity = "critical" | "major" | "minor" | "info";

/** Single source of truth for the check catalog, ordered by severity then weight. */
export const CHECKS = [
  { id: "dmarc_record", severity: "critical", weightHundredths: 350, applies: "all" },
  { id: "auth_alignment", severity: "critical", weightHundredths: 350, applies: "all" },
  { id: "list_unsubscribe", severity: "major", weightHundredths: 150, applies: "marketing" },
  { id: "link_domains_match", severity: "major", weightHundredths: 125, applies: "all" },
  { id: "no_shorteners", severity: "major", weightHundredths: 125, applies: "all" },
  { id: "body_size", severity: "major", weightHundredths: 100, applies: "all" },
  { id: "plain_text", severity: "major", weightHundredths: 100, applies: "all" },
  { id: "visible_unsubscribe", severity: "major", weightHundredths: 100, applies: "marketing" },
  { id: "phishing_links", severity: "major", weightHundredths: 100, applies: "all" },
  { id: "no_reply_from", severity: "minor", weightHundredths: 50, applies: "marketing" },
  { id: "svg_images", severity: "minor", weightHundredths: 50, applies: "all" },
  { id: "attachments_marketing", severity: "minor", weightHundredths: 50, applies: "marketing" },
  { id: "image_text_ratio", severity: "minor", weightHundredths: 40, applies: "all" },
  { id: "tracking_unbranded", severity: "minor", weightHundredths: 40, applies: "all" },
  { id: "root_domain_send", severity: "minor", weightHundredths: 25, applies: "marketing" },
  { id: "insecure_links", severity: "minor", weightHundredths: 25, applies: "all" },
  { id: "subject_lint", severity: "minor", weightHundredths: 25, applies: "all" },
  { id: "image_alt_text", severity: "info", weightHundredths: 0, applies: "all" },
  { id: "images_offsite", severity: "info", weightHundredths: 0, applies: "all" },
  { id: "bimi_ready", severity: "info", weightHundredths: 0, applies: "all" },
  { id: "reply_to_present", severity: "info", weightHundredths: 0, applies: "all" },
] as const satisfies readonly {
  id: string;
  severity: CheckSeverity;
  weightHundredths: number;
  applies: "all" | "marketing";
}[];

export type CheckId = (typeof CHECKS)[number]["id"];

export interface EmailCheckResult {
  id: CheckId;
  severity: CheckSeverity;
  status: CheckStatus;
  penaltyHundredths: number;
  detail?: Record<string, unknown>;
}

/** Link-shortener hosts (matched exact or as a parent of the link host). */
export const SHORTENER_HOSTS = new Set([
  "youtu.be",
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "buff.ly",
  "is.gd",
  "rb.gy",
  "cutt.ly",
  "tiny.cc",
  "rebrand.ly",
  "shorturl.at",
  "s.id",
]);

export interface EmailInsightsInput {
  /** FINAL html (post unsubscribe-substitution AND post tracking-rewrite) — used ONLY for body_size. */
  html: string | null;
  /**
   * Post-substitution, PRE tracking-rewrite — used for all link/image/text
   * analysis (the final hrefs the recipient resolves, before our wrapper).
   */
  preTrackingHtml: string | null;
  text: string | null;
  /** Raw From header value. */
  from: string;
  /** Lowercased sender domain from parseSingleSender. */
  senderDomain: string;
  subject: string;
  /**
   * Merged transport headers as sent (includes our injected List-Unsubscribe
   * when applied); keys are treated case-insensitively.
   */
  finalHeaders: Record<string, string>;
  hasAttachments: boolean;
  replyTo: string[] | null;
  isBroadcast: boolean;
  hasTopic: boolean;
  tracking: {
    clickEnabled: boolean;
    openEnabled: boolean;
    brandedHostUsed: boolean;
    sharedFallbackUsed: boolean;
    shippedUntracked: boolean;
  };
  domainSnapshot: {
    dmarcPolicy: "none" | "quarantine" | "reject" | null;
    dmarcCheckedAt: Date | null;
  } | null;
  /** Reference instant for staleness math (never Date.now — determinism). */
  now: Date;
}

/** Gmail clips messages whose HTML exceeds ~100KB (community-measured). */
const GMAIL_CLIP_BYTES = 102400;
const DMARC_STALE_MS = 24 * 60 * 60 * 1000;
const MINOR_CAP_HUNDREDTHS = 150;

const UNSUB_TEXT = /unsubscrib|opt[ -]?out|descadastr|cancelar (a )?inscri/i;
const DOMAIN_TOKEN = /(https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

/**
 * Final labels that make a bare dotted token in anchor text read as a domain
 * claim (vs 'Node.js' or 'report.pdf'). False negatives on exotic TLDs are
 * acceptable for a heuristic; false positives are not.
 */
const COMMON_TLDS = new Set(
  "com net org io co dev app ai me info biz edu gov br uk de fr es it nl pt pl se ch at be dk no fi ie cz gr ro hu jp cn in ru ca au us mx ar cl il za kr tw hk sg th ph my vn tr nz id sa ae eg ng ke".split(
    " ",
  ),
);
const NO_REPLY_LOCAL = /^(no-?reply|do-?not-?reply|nao-?responda)/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

interface Anchor {
  href: string;
  /** Visible inner text, tags stripped, whitespace collapsed. */
  text: string;
  /** Char offset of the anchor in preTrackingHtml (clip-point math). */
  index: number;
}

interface Link extends Anchor {
  /** Lowercase hostname ('[..]'-bracketed for IPv6 literals, as URL yields). */
  host: string;
  protocol: string;
}

function visibleText(html: string): string {
  return html
    .replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAnchors(html: string): Anchor[] {
  const lower = html.toLowerCase();
  const anchors: Anchor[] = [];
  for (const m of html.matchAll(ANCHOR_HREF)) {
    const openEnd = html.indexOf(">", m.index + m[0].length);
    if (openEnd === -1) continue;
    const close = lower.indexOf("</a", openEnd + 1);
    const inner = html.slice(openEnd + 1, close === -1 ? html.length : close);
    anchors.push({ href: m[3] as string, text: visibleText(inner), index: m.index });
  }
  return anchors;
}

function toLink(a: Anchor): Link | null {
  if (!/^https?:\/\//i.test(a.href)) return null;
  try {
    const u = new URL(a.href);
    return { ...a, host: u.hostname, protocol: u.protocol };
  } catch {
    return null;
  }
}

const IMG_TAG = /<img\b[^>]*>/gi;

function extractImages(html: string): { src: string | null; alt: string | null }[] {
  return [...html.matchAll(IMG_TAG)].map((m) => ({
    src: m[0].match(/\ssrc\s*=\s*(["'])(.*?)\1/i)?.[2] ?? null,
    alt: m[0].match(/\salt\s*=\s*(["'])(.*?)\1/i)?.[2] ?? null,
  }));
}

function isIpLiteral(host: string): boolean {
  return IPV4.test(host) || host.startsWith("[");
}

type Verdict = { status: CheckStatus; detail?: Record<string, unknown> };

export function evaluateEmailInsights(input: EmailInsightsInput): {
  checks: EmailCheckResult[];
  scoreTenths: number;
  marketing: boolean;
} {
  const html = input.preTrackingHtml;
  const anchors = html === null ? [] : extractAnchors(html);
  const links = anchors.map(toLink).filter((l): l is Link => l !== null);
  const images = html === null ? [] : extractImages(html);
  const bodyText = html === null ? "" : visibleText(html);
  const senderReg = registrableDomain(input.senderDomain);

  const headerKeys = new Set(Object.keys(input.finalHeaders).map((k) => k.toLowerCase()));
  const hasListUnsub = headerKeys.has("list-unsubscribe");
  const hasListUnsubPost = headerKeys.has("list-unsubscribe-post");

  const unsubAnchor = anchors.find(
    (a) => a.href.includes("/unsubscribe") || UNSUB_TEXT.test(a.text),
  );

  // Classification rests only on send shape and body content. A caller
  // List-Unsubscribe header deliberately does NOT promote: header-based
  // promotion punished partial compliance — a mailto-only header pushed a
  // transactional send into the very list_unsubscribe check it then failed,
  // scoring worse than omitting the header. Absence never demotes either:
  // the classifier must not eat its own check.
  const marketing = input.isBroadcast || input.hasTopic || unsubAnchor !== undefined;

  const snap = input.domainSnapshot;
  const dmarcKnown =
    snap !== null &&
    snap.dmarcCheckedAt !== null &&
    input.now.getTime() - snap.dmarcCheckedAt.getTime() <= DMARC_STALE_MS;

  const mailbox = parseMailbox(input.from);
  const fromLocal = mailbox ? mailbox.address.slice(0, mailbox.address.lastIndexOf("@")) : "";
  const noReplyFrom = NO_REPLY_LOCAL.test(fromLocal);

  const inlineSvg = html !== null && /<svg\b/i.test(html);
  const linkedSvg = images.some(
    (i) => i.src !== null && /\.svg$/i.test(i.src.split(/[?#]/)[0] as string),
  );

  const evaluate = (id: CheckId): Verdict => {
    switch (id) {
      case "dmarc_record": {
        if (!dmarcKnown || snap === null) return { status: "unknown" };
        if (snap.dmarcPolicy === null) return { status: "fail" };
        return { status: "pass", detail: { policy: snap.dmarcPolicy } };
      }
      case "auth_alignment":
        // SPF + BYODKIM verification is a hard gate before any send.
        return {
          status: "passed_by_design",
          detail: { reason: "domain_verification_gates_sending" },
        };
      case "list_unsubscribe": {
        if (!(hasListUnsub && hasListUnsubPost)) return { status: "fail" };
        // Broadcast/topic sends carry these headers via our own injection —
        // guaranteed by the transport, not caller diligence.
        return { status: input.isBroadcast || input.hasTopic ? "passed_by_design" : "pass" };
      }
      case "link_domains_match": {
        if (links.length === 0) return { status: "not_applicable" };
        const matches = links.some(
          (l) => l.host === input.senderDomain || registrableDomain(l.host) === senderReg,
        );
        if (matches) return { status: "pass" };
        const linkDomains = [...new Set(links.map((l) => registrableDomain(l.host)))].slice(0, 10);
        return { status: "fail", detail: { linkDomains } };
      }
      case "no_shorteners": {
        if (links.length === 0) return { status: "not_applicable" };
        const found = [
          ...new Set(
            links
              .map((l) => l.host)
              .filter((h) => [...SHORTENER_HOSTS].some((s) => h === s || h.endsWith(`.${s}`))),
          ),
        ];
        // youtu.be is YouTube's own share domain and only harmful when our
        // click tracking actually wraps it (shortener + wrapper = double
        // redirect, the documented Gmail phishing trigger); generic
        // shorteners are opaque and abused, so they fail regardless.
        const wrapped =
          input.tracking.clickEnabled &&
          (input.tracking.brandedHostUsed || input.tracking.sharedFallbackUsed);
        const failing = found.filter(
          (h) => wrapped || !(h === "youtu.be" || h.endsWith(".youtu.be")),
        );
        if (failing.length === 0) {
          return found.length > 0
            ? { status: "pass", detail: { note: "prefer_full_youtube_watch_urls" } }
            : { status: "pass" };
        }
        return {
          status: "fail",
          detail: {
            shorteners: failing,
            ...(input.tracking.clickEnabled ? { note: "double_redirect_with_click_tracking" } : {}),
          },
        };
      }
      case "body_size": {
        if (input.html === null) return { status: "not_applicable" };
        const htmlSizeBytes = Buffer.byteLength(input.html, "utf8");
        return {
          status: htmlSizeBytes > GMAIL_CLIP_BYTES ? "fail" : "pass",
          detail: { htmlSizeBytes },
        };
      }
      case "plain_text": {
        if (html === null) return { status: "not_applicable" };
        if (input.text === null || input.text.trim().length < 10) return { status: "fail" };
        return { status: "pass" };
      }
      case "visible_unsubscribe": {
        if (html === null) return { status: "not_applicable" };
        if (!unsubAnchor) return { status: "fail" };
        // Gmail clips on BYTES; multibyte content shifts the boundary left of
        // the char index, so measure the prefix in utf8 bytes.
        const beforeClipPoint =
          Buffer.byteLength(html.slice(0, unsubAnchor.index), "utf8") < GMAIL_CLIP_BYTES;
        return { status: beforeClipPoint ? "pass" : "fail", detail: { beforeClipPoint } };
      }
      case "phishing_links": {
        if (links.length === 0) return { status: "not_applicable" };
        const reasons = new Set<string>();
        for (const l of links) {
          if (isIpLiteral(l.host)) {
            reasons.add("ip_literal_host");
          } else {
            for (const t of l.text.matchAll(DOMAIN_TOKEN)) {
              const scheme = t[1];
              const claimed = scheme === undefined ? t[0] : t[0].slice(scheme.length);
              // Only URL-like tokens are domain claims: a scheme or www.
              // prefix, or a common-TLD final label.
              const urlLike = scheme !== undefined || claimed.toLowerCase().startsWith("www.");
              const lastLabel = claimed.slice(claimed.lastIndexOf(".") + 1).toLowerCase();
              if (!urlLike && !COMMON_TLDS.has(lastLabel)) continue;
              if (registrableDomain(claimed) !== registrableDomain(l.host)) {
                reasons.add("text_domain_mismatch");
                break;
              }
            }
          }
          if (l.protocol === "http:" && /https/i.test(l.text)) reasons.add("text_claims_https");
        }
        if (reasons.size === 0) return { status: "pass" };
        return { status: "fail", detail: { reasons: [...reasons] } };
      }
      case "no_reply_from":
        return { status: noReplyFrom ? "fail" : "pass" };
      case "svg_images": {
        if (images.length === 0 && !inlineSvg) return { status: "not_applicable" };
        if (inlineSvg || linkedSvg) {
          return { status: "fail", detail: { inline: inlineSvg, linked: linkedSvg } };
        }
        return { status: "pass" };
      }
      case "attachments_marketing":
        return { status: input.hasAttachments ? "fail" : "pass" };
      case "image_text_ratio": {
        if (images.length === 0) return { status: "not_applicable" };
        if (bodyText.length < 100) {
          return {
            status: "fail",
            detail: { visibleTextChars: bodyText.length, imageCount: images.length },
          };
        }
        return { status: "pass" };
      }
      case "tracking_unbranded": {
        // Text-only body: nothing is wrapped or pixeled, whatever the flags say.
        if (html === null) return { status: "not_applicable" };
        const t = input.tracking;
        if (!t.clickEnabled && !t.openEnabled)
          return { status: "pass", detail: { tracking: "off" } };
        if (t.shippedUntracked)
          return { status: "fail", detail: { reason: "no_tracking_subdomain" } };
        if (t.sharedFallbackUsed)
          return { status: "fail", detail: { reason: "shared_tracking_host" } };
        if (t.brandedHostUsed) return { status: "pass", detail: { tracking: "branded" } };
        return { status: "unknown" };
      }
      case "root_domain_send":
        return { status: isRootDomainSend(input.senderDomain) ? "fail" : "pass" };
      case "insecure_links": {
        if (links.length === 0) return { status: "not_applicable" };
        const httpLinkCount = links.filter((l) => l.protocol === "http:").length;
        if (httpLinkCount > 0) return { status: "fail", detail: { httpLinkCount } };
        return { status: "pass" };
      }
      case "subject_lint": {
        const letters = input.subject.match(/\p{L}/gu) ?? [];
        const upper = input.subject.match(/\p{Lu}/gu) ?? [];
        const shouty = letters.length >= 8 && upper.length / letters.length > 0.6;
        return { status: shouty || /[!?]{3,}/.test(input.subject) ? "fail" : "pass" };
      }
      case "image_alt_text": {
        if (images.length === 0) return { status: "not_applicable" };
        const missing = images.some((i) => i.alt === null || i.alt.trim() === "");
        return { status: missing ? "fail" : "pass" };
      }
      case "images_offsite": {
        if (images.length === 0) return { status: "not_applicable" };
        const offsite = new Set<string>();
        for (const i of images) {
          if (i.src === null || !/^https?:\/\//i.test(i.src)) continue;
          try {
            const reg = registrableDomain(new URL(i.src).hostname);
            if (reg !== senderReg) offsite.add(reg);
          } catch {
            // unparsable src carries no host to compare
          }
        }
        if (offsite.size === 0) return { status: "pass" };
        return { status: "fail", detail: { imageDomains: [...offsite].slice(0, 5) } };
      }
      case "bimi_ready": {
        if (!dmarcKnown || snap === null) return { status: "unknown" };
        if (snap.dmarcPolicy === "quarantine" || snap.dmarcPolicy === "reject") {
          return { status: "pass" };
        }
        if (snap.dmarcPolicy === "none") {
          return { status: "fail", detail: { needs: "p=quarantine or p=reject" } };
        }
        return { status: "fail" };
      }
      case "reply_to_present": {
        // Only meaningful as the mitigation for a failing no_reply_from.
        if (!(marketing && noReplyFrom)) return { status: "not_applicable" };
        return { status: input.replyTo !== null && input.replyTo.length > 0 ? "pass" : "fail" };
      }
    }
  };

  const checks: EmailCheckResult[] = CHECKS.map((meta) => {
    const verdict: Verdict =
      meta.applies === "marketing" && !marketing ? { status: "not_applicable" } : evaluate(meta.id);
    return {
      id: meta.id,
      severity: meta.severity,
      status: verdict.status,
      penaltyHundredths: verdict.status === "fail" ? meta.weightHundredths : 0,
      ...(verdict.detail ? { detail: verdict.detail } : {}),
    };
  });

  let criticalMajor = 0;
  let minor = 0;
  for (const c of checks) {
    if (c.status !== "fail") continue;
    if (c.severity === "minor") minor += c.penaltyHundredths;
    else criticalMajor += c.penaltyHundredths;
  }
  const hundredths = Math.max(0, 1000 - criticalMajor - Math.min(MINOR_CAP_HUNDREDTHS, minor));
  return { checks, scoreTenths: Math.round(hundredths / 10), marketing };
}

export type ScoreBand = "excellent" | "good" | "needs_attention" | "at_risk";

export function scoreBand(scoreTenths: number): ScoreBand {
  if (scoreTenths >= 90) return "excellent";
  if (scoreTenths >= 70) return "good";
  if (scoreTenths >= 50) return "needs_attention";
  return "at_risk";
}
