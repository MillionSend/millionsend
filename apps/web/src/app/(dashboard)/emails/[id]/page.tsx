"use client";

import type { EmailCheckResult, ScoreBand } from "@millionsend/core";
import { parseSmtpDiagnostic, resolveBounceGuidance } from "@millionsend/core/bounce-guidance";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ApiDocsButton } from "@/components/api-sheet";
import { CopyChip, CopyGlyph } from "@/components/copy-chip";
import { Drawer } from "@/components/drawer";
import { EmailStatusIcon, EventIconTile } from "@/components/email-status-icon";
import { GuidanceBlock } from "@/components/guidance-block";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { Skeleton, SkeletonChip } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Tooltip } from "@/components/tooltip";
import {
  formatDayTime,
  formatDurationShort,
  formatRelative,
  formatUtcTimestampMs,
} from "@/lib/format";
import { BAND_TONE, checkGlyph, formatScoreTenths } from "@/lib/score-band";
import { statusGlow } from "@/lib/status-glow";
import { useTRPC } from "@/lib/trpc";

type EventType =
  | "queued"
  | "queued_quota"
  | "sent"
  | "delivery_delayed"
  | "delivered"
  | "opened"
  | "clicked"
  | "bounced"
  | "complained"
  | "suppressed"
  | "rendering_failure"
  | "failed";

/**
 * Ledger word color per the canvas: sent stays muted (it's the baseline,
 * not an outcome), delivered succeeds, opens/clicks inform, bounce and
 * suppression are dangers, complaints warn.
 */
const EVENT_COLOR: Record<EventType, string> = {
  queued: "var(--ms-muted)",
  queued_quota: "var(--ms-muted)",
  sent: "var(--ms-muted)",
  delivery_delayed: "var(--ms-neutral)",
  delivered: "var(--ms-success)",
  opened: "var(--ms-info)",
  clicked: "var(--ms-info)",
  bounced: "var(--ms-danger)",
  complained: "var(--ms-warn)",
  suppressed: "var(--ms-danger)",
  rendering_failure: "var(--ms-danger)",
  failed: "var(--ms-danger)",
};

type EventData = Record<string, unknown> | null;

/* SES payload extractors — shapes per packages/ses parseSesEvent's data field. */
type BounceData = {
  bounceType?: string;
  bounceSubType?: string;
  bouncedRecipients?: Array<{ diagnosticCode?: string; status?: string }>;
};
function bounceOf(data: EventData): BounceData | null {
  const b = data?.bounce;
  return b && typeof b === "object" ? (b as BounceData) : null;
}
function clickOf(data: EventData): { link?: string } | null {
  const c = data?.click;
  return c && typeof c === "object" ? (c as { link?: string }) : null;
}
function complaintOf(data: EventData): { complaintFeedbackType?: string } | null {
  const c = data?.complaint;
  return c && typeof c === "object" ? (c as { complaintFeedbackType?: string }) : null;
}
/** "550 5.1.1" out of an SMTP diagnostic string, or null. */
function smtpCode(diagnostic: string | undefined): string | null {
  return parseSmtpDiagnostic(diagnostic).display;
}

/** Recipient domain for provider-keyed bounce guidance. */
function domainOf(address: string | null): string | null {
  const at = address?.lastIndexOf("@") ?? -1;
  return at >= 0 ? (address as string).slice(at + 1) : null;
}

function Microlabel({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div className="ms-microlabel" style={{ fontSize: 10.5, ...style }}>
      {children}
    </div>
  );
}

function Meta({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Microlabel>{label}</Microlabel>
      <div
        className={mono ? "ms-mono" : undefined}
        style={{ fontSize: mono ? 13 : 14, marginTop: 5, overflowWrap: "anywhere" }}
      >
        {children}
      </div>
    </div>
  );
}

/** Numbered remediation row inside a drawer. */
function StepRow({ index, text, last }: { index: number; text: string; last?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "9px 0",
        borderBottom: last ? undefined : "1px solid var(--ms-line)",
      }}
    >
      <span
        className="ms-mono"
        style={{ fontSize: 11, color: "var(--ms-faint)", width: 16, flex: "none" }}
      >
        {index}
      </span>
      <span style={{ fontSize: 13, color: "var(--ms-muted)", lineHeight: 1.55 }}>{text}</span>
    </div>
  );
}

/** Mono code block with a top-right copy glyph (SMTP responses, diagnostics). */
function CodeBlock({ value }: { value: string }) {
  return (
    <div
      style={{
        position: "relative",
        background: "var(--ms-inset)",
        border: "1px solid var(--ms-line)",
        borderRadius: 10,
        padding: "14px 16px",
      }}
    >
      <pre
        className="ms-mono"
        style={{
          margin: 0,
          fontSize: 12,
          lineHeight: 1.7,
          color: "var(--ms-bone)",
          whiteSpace: "pre-wrap",
        }}
      >
        {value}
      </pre>
      <span style={{ position: "absolute", top: 10, right: 12 }}>
        <CopyGlyph value={value} />
      </span>
    </div>
  );
}

const TAB_KEYS = ["preview", "text", "html", "insights"] as const;
type Tab = (typeof TAB_KEYS)[number];

interface EmailInsights {
  scoreTenths: number;
  band: ScoreBand;
  marketing: boolean;
  htmlSizeBytes: number | null;
  computedAt: Date;
  checks: EmailCheckResult[];
}

function InsightsSection({ insights }: { insights: EmailInsights }) {
  const t = useTranslations("emails");
  const common = useTranslations("common");
  const locale = useLocale();
  const [openCheckId, setOpenCheckId] = useState<string | null>(null);
  const [naOpen, setNaOpen] = useState(false);

  const { checks } = insights;
  const groups = [
    {
      key: "attention",
      rows: checks.filter(
        (c) => c.status === "fail" && (c.severity === "critical" || c.severity === "major"),
      ),
    },
    {
      key: "improvements",
      rows: checks.filter(
        (c) => c.status === "fail" && (c.severity === "minor" || c.severity === "info"),
      ),
    },
    {
      key: "great",
      rows: checks.filter((c) => c.status === "pass" || c.status === "passed_by_design"),
    },
    { key: "notChecked", rows: checks.filter((c) => c.status === "unknown") },
  ] as const;
  const notApplicable = checks.filter((c) => c.status === "not_applicable");
  const openCheck = openCheckId ? checks.find((c) => c.id === openCheckId) : undefined;

  /** Mono data line under a check — hostnames, sizes, policies; never URLs. */
  function detailLine(check: EmailCheckResult): string | null {
    const d = check.detail;
    if (!d) return null;
    switch (check.id) {
      case "body_size":
        return typeof d.htmlSizeBytes === "number"
          ? t("insights.kb", { kb: Math.round(d.htmlSizeBytes / 1024) })
          : null;
      case "dmarc_record":
        return typeof d.policy === "string" ? `p=${d.policy}` : null;
      case "link_domains_match":
        return Array.isArray(d.linkDomains) ? d.linkDomains.join(", ") : null;
      case "no_shorteners":
        return Array.isArray(d.shorteners) ? d.shorteners.join(", ") : null;
      case "images_offsite":
        return Array.isArray(d.imageDomains) ? d.imageDomains.join(", ") : null;
      default:
        return null;
    }
  }

  function checkRow(check: EmailCheckResult, greyed = false) {
    const { glyph, color } = checkGlyph(check);
    return (
      <button
        key={check.id}
        type="button"
        onClick={() => setOpenCheckId(check.id)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          background: "none",
          border: 0,
          borderBottom: "1px solid var(--ms-line)",
          padding: "9px 2px",
          font: "inherit",
          color: greyed ? "var(--ms-faint)" : "var(--ms-bone)",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span aria-hidden="true" style={{ color, width: 14, flex: "none", fontSize: 12 }}>
          {glyph}
        </span>
        <span style={{ fontSize: 13.5 }}>{t(`insights.check.${check.id}.title`)}</span>
        {check.status === "passed_by_design" ? (
          <span className="ms-chip" style={{ fontSize: 10.5, padding: "1px 7px" }}>
            {t("insights.byDesign")}
          </span>
        ) : null}
        <span aria-hidden="true" style={{ marginLeft: "auto", color: "var(--ms-faint)" }}>
          ›
        </span>
      </button>
    );
  }

  return (
    <div style={{ padding: "20px 18px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span className="ms-digits" style={{ fontSize: "var(--ms-fs-kpi)", lineHeight: 1.1 }}>
          {formatScoreTenths(insights.scoreTenths, locale)}
        </span>
        <span className="ms-digits" style={{ fontSize: 15, color: "var(--ms-muted)" }}>
          {t("insights.outOfTen")}
        </span>
        <span className={`ms-badge ms-badge-${BAND_TONE[insights.band]}`}>
          {common(`band.${insights.band}`)}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--ms-muted)", marginTop: 6 }}>
        {t("insights.reportFrom", { date: formatDayTime(insights.computedAt, locale) })}
      </div>

      {groups.map((group) =>
        group.rows.length === 0 ? null : (
          <div key={group.key} style={{ marginTop: 20 }}>
            <div className="ms-microlabel">{t(`insights.groups.${group.key}`)}</div>
            {group.key === "notChecked" ? (
              <div style={{ fontSize: 12.5, color: "var(--ms-faint)", marginTop: 3 }}>
                {t("insights.notCheckedWhy")}
              </div>
            ) : null}
            <div style={{ marginTop: 4 }}>{group.rows.map((check) => checkRow(check))}</div>
          </div>
        ),
      )}

      {notApplicable.length > 0 ? (
        <div style={{ marginTop: 20 }}>
          <button
            type="button"
            className="ms-microlabel"
            onClick={() => setNaOpen((v) => !v)}
            style={{
              background: "none",
              border: 0,
              padding: 0,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {t("insights.notApplicableToggle", { count: notApplicable.length })}
            <span aria-hidden="true">{naOpen ? "▾" : "›"}</span>
          </button>
          {naOpen ? (
            <div style={{ marginTop: 4 }}>
              {notApplicable.map((check) => checkRow(check, true))}
            </div>
          ) : null}
        </div>
      ) : null}

      <Drawer
        open={openCheck !== undefined}
        onClose={() => setOpenCheckId(null)}
        title={openCheck ? t(`insights.check.${openCheck.id}.title`) : ""}
      >
        {openCheck ? (
          <>
            <p style={{ fontSize: 13.5, color: "var(--ms-muted)", lineHeight: 1.6, marginTop: 16 }}>
              {t(`insights.check.${openCheck.id}.description`)}
            </p>
            {openCheck.status === "passed_by_design" ? (
              <p style={{ fontSize: 13, color: "var(--ms-muted)", lineHeight: 1.6 }}>
                {t("insights.byDesignNote")}
              </p>
            ) : null}
            {openCheck.status === "unknown" ? (
              <p style={{ fontSize: 13, color: "var(--ms-muted)", lineHeight: 1.6 }}>
                {t("insights.notCheckedWhy")}
              </p>
            ) : null}
            <div className="ms-microlabel" style={{ margin: "18px 0 6px" }}>
              {t("insights.adviceLabel")}
            </div>
            <p style={{ margin: 0, fontSize: 13.5, color: "var(--ms-bone)", lineHeight: 1.6 }}>
              {t(`insights.check.${openCheck.id}.advice`)}
            </p>
            {detailLine(openCheck) ? (
              <>
                <div className="ms-microlabel" style={{ margin: "18px 0 6px" }}>
                  {t("insights.detailLabel")}
                </div>
                <div
                  className="ms-mono"
                  style={{ fontSize: 12.5, color: "var(--ms-bone)", overflowWrap: "anywhere" }}
                >
                  {detailLine(openCheck)}
                </div>
              </>
            ) : null}
          </>
        ) : null}
      </Drawer>
    </div>
  );
}

/** Mirrors the loaded page's boxes (header, meta grid, events strip, body panel). */
function EmailDetailSkeleton() {
  const t = useTranslations("emails");
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 28,
        }}
      >
        <div>
          <div style={{ display: "flex", fontSize: 13, lineHeight: 1, marginBottom: 10 }}>
            <Skeleton width={150} height="1lh" />
          </div>
          <h1
            className="ms-display"
            style={{ fontSize: "var(--ms-fs-h1)", fontWeight: 600, margin: 0, display: "flex" }}
          >
            <Skeleton width={260} height="1lh" />
          </h1>
          <div className="ms-mono" style={{ fontSize: 12, marginTop: 8, display: "flex" }}>
            <Skeleton width={220} height="1lh" />
          </div>
        </div>
        <Skeleton width={30} height={30} radius="var(--ms-r-input)" />
      </div>

      <div
        className="ms-meta-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: "22px 28px",
          padding: "22px 0",
          borderTop: "1px solid var(--ms-line)",
          borderBottom: "1px solid var(--ms-line)",
        }}
      >
        <Meta label={t("detail.from")} mono>
          <span style={{ display: "flex" }}>
            <Skeleton width={180} height="1lh" />
          </span>
        </Meta>
        <Meta label={t("detail.subject")}>
          <span style={{ display: "flex" }}>
            <Skeleton width={200} height="1lh" />
          </span>
        </Meta>
        <div>
          <Microlabel>{t("detail.id")}</Microlabel>
          <div style={{ marginTop: 4 }}>
            <SkeletonChip width={190} />
          </div>
        </div>
      </div>

      <div style={{ marginTop: 26 }}>
        <div className="ms-microlabel">{t("detail.events")}</div>
        <div
          style={{
            marginTop: 12,
            border: "1px solid var(--ms-line)",
            borderRadius: 14,
            padding: "30px 26px",
            backgroundImage: "radial-gradient(var(--ms-line) 1px, transparent 1px)",
            backgroundSize: "18px 18px",
            backgroundPosition: "center",
            display: "flex",
            alignItems: "center",
            overflowX: "auto",
          }}
        >
          {[0, 1, 2].map((index) => (
            <div key={index} style={{ display: "contents" }}>
              {index > 0 ? (
                <div
                  style={{
                    flex: "none",
                    minWidth: 56,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 5,
                    padding: "0 4px",
                  }}
                >
                  <span className="ms-mono" style={{ fontSize: 10.5, display: "flex" }}>
                    <Skeleton width={32} height="1lh" />
                  </span>
                  <span style={{ height: 1, background: "var(--ms-line-strong)", width: "100%" }} />
                </div>
              ) : null}
              <div
                style={{
                  background: "var(--ms-panel)",
                  border: "1px solid var(--ms-line)",
                  borderRadius: 12,
                  padding: "12px 16px",
                  width: 264,
                  boxSizing: "border-box",
                  flex: "none",
                }}
              >
                <div style={{ fontSize: 13.5, fontWeight: 600, display: "flex" }}>
                  <Skeleton width={70} height="1lh" />
                </div>
                <div className="ms-mono" style={{ fontSize: 11.5, marginTop: 7, display: "flex" }}>
                  <Skeleton width={168} height="1lh" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          marginTop: 26,
          background: "var(--ms-panel)",
          border: "1px solid var(--ms-line)",
          borderRadius: 14,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "10px 12px",
            borderBottom: "1px solid var(--ms-line)",
          }}
        >
          {[52, 64, 44, 58].map((width) => (
            <span key={width} style={{ fontSize: 13, padding: "5px 11px", display: "flex" }}>
              <Skeleton width={width} height="1lh" />
            </span>
          ))}
        </div>
        <div
          style={{
            background: "var(--ms-inset)",
            padding: 28,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <Skeleton width={560} height={480} radius={8} />
        </div>
      </div>
    </>
  );
}

export default function EmailDetailPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations("emails");
  const common = useTranslations("common");
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("preview");
  const [drawer, setDrawer] = useState<"bounced" | "suppressed" | null>(null);
  // Identifies an occurrence group by its first event's id — type alone is
  // ambiguous now that each local day gets its own node per type.
  const [groupDrawer, setGroupDrawer] = useState<string | null>(null);

  const query = useQuery(trpc.emails.get.queryOptions({ id }, { retry: false }));
  const sesEnv = useQuery(trpc.system.sesEnv.queryOptions());
  const email = query.data;
  const recipient = email?.to[0] ?? null;

  // The suppression row backing the "Suppressed details" drawer (and its
  // destructive remove) — fetched only when that drawer opens.
  const suppressionQuery = useQuery(
    trpc.emails.suppressions.list.queryOptions(
      { search: recipient ?? "", limit: 50 },
      { enabled: drawer === "suppressed" && recipient != null },
    ),
  );
  const suppressionRow =
    suppressionQuery.data?.items.find((item) => item.email === recipient) ?? null;
  const removeMutation = useMutation(
    trpc.emails.suppressions.remove.mutationOptions({
      onSuccess: () => {
        setDrawer(null);
        queryClient.invalidateQueries(trpc.emails.suppressions.pathFilter());
      },
    }),
  );

  if (query.isPending) {
    return <EmailDetailSkeleton />;
  }
  if (query.isError || !email) {
    return (
      <>
        <p style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
          {t("detail.notFound")}
        </p>
        <Link href="/emails" style={{ fontSize: "var(--ms-fs-ui)" }}>
          ← {t("list.title")}
        </Link>
      </>
    );
  }

  // One node per (event type, viewer-local day), ordered by first occurrence:
  // multi-recipient emails get one SES Delivery per recipient, and app-layer
  // tracking repeats opened/clicked — same-day repeats collapse into the node
  // (×N chip, latest timestamp, occurrences drawer), while a repeat on a
  // later day starts a fresh node so long-lived engagement stays visible.
  type EmailEvent = (typeof email.events)[number];
  const localDay = (at: string | Date) => new Date(at).toDateString();
  const groups: { type: EventType; first: EmailEvent; occurrences: EmailEvent[] }[] = [];
  for (const event of email.events) {
    const group = groups.find(
      (g) => g.type === event.type && localDay(g.first.occurredAt) === localDay(event.occurredAt),
    );
    if (group) group.occurrences.push(event);
    else groups.push({ type: event.type as EventType, first: event, occurrences: [event] });
  }
  // First occurrence per group — the masthead/stall derivations read these.
  const events = groups.map((group) => group.first);
  // Ingestion off (no SNS topics) means nothing after the locally-recorded
  // "sent" can ever arrive — the timeline says so instead of silently stalling.
  const eventsStalled =
    sesEnv.data?.snsTopicsConfigured === false && events[events.length - 1]?.type === "sent";
  const eventLabel = (type: EventType) =>
    type === "rendering_failure" ? t("detail.event.rendering_failure") : common(`status.${type}`);

  const sentEvent = events.find((event) => event.type === "sent");
  // Anchor for the occurrences drawer's "+42 min" offsets — the actual send
  // moment when known, else creation (an email is never engaged before either).
  const sendAt = sentEvent?.occurredAt ?? email.sentAt ?? email.createdAt;
  const openGroup = groupDrawer
    ? groups.find((group) => group.first.id === groupDrawer)
    : undefined;
  const groupOccurrences = openGroup?.occurrences ?? [];
  const terminalEvent = [...events].reverse().find((event) => event.type === email.latestStatus);
  const lastBounce = [...events].reverse().find((event) => event.type === "bounced");
  const bounce = lastBounce ? bounceOf(lastBounce.data) : null;
  const bounceDiag = bounce?.bouncedRecipients?.[0]?.diagnosticCode;
  const bounceCode = smtpCode(bounceDiag) ?? bounce?.bouncedRecipients?.[0]?.status ?? null;
  const hardBounced = bounce?.bounceType === "Permanent";
  const bounceGuidance = resolveBounceGuidance({
    bounceType: bounce?.bounceType ?? null,
    bounceSubType: bounce?.bounceSubType ?? null,
    diagnosticCode: bounceDiag ?? null,
    recipientDomain: domainOf(recipient),
  });

  // Masthead proof strip: "delivered in 1.92 s · 2min ago · permanent · 550 5.1.1"
  const sublineParts: string[] = [];
  if (sentEvent && terminalEvent && terminalEvent.id !== sentEvent.id) {
    const delta =
      new Date(terminalEvent.occurredAt).getTime() - new Date(sentEvent.occurredAt).getTime();
    if (delta >= 0) {
      sublineParts.push(
        t("detail.statusIn", {
          status: common(`status.${email.latestStatus}`).toLowerCase(),
          duration: formatDurationShort(delta),
        }),
      );
    }
  }
  sublineParts.push(formatRelative(email.createdAt, locale));
  if ((email.latestStatus === "bounced" || email.latestStatus === "suppressed") && bounce) {
    if (bounce.bounceType) sublineParts.push(bounce.bounceType.toLowerCase());
    if (bounceCode) sublineParts.push(bounceCode);
  }

  /** Second mono line inside an event card — real payload data only. */
  function eventDetail(type: EventType, data: EventData): string | null {
    if (type === "bounced") {
      const b = bounceOf(data);
      if (!b) return null;
      const code = smtpCode(b.bouncedRecipients?.[0]?.diagnosticCode);
      const parts = [code ?? b.bounceSubType, b.bounceType?.toLowerCase()].filter(Boolean);
      return parts.length > 0 ? parts.join(" · ") : null;
    }
    if (type === "clicked") return clickOf(data)?.link ?? null;
    if (type === "complained") return complaintOf(data)?.complaintFeedbackType ?? null;
    if (type === "suppressed") return t("detail.suppressedLine");
    return null;
  }

  const tabContent: Record<Tab, string | null> = {
    preview: email.html,
    text: email.text,
    html: email.html,
    insights: null,
  };
  const currentContent = tabContent[tab];
  const tabLabels: Record<Tab, string> = {
    preview: t("detail.preview"),
    text: t("detail.plainText"),
    html: t("detail.html"),
    insights: t("detail.insights"),
  };

  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Crumb href="/emails" label={t("list.title")} />
            <CrumbEnd label={t("detail.breadcrumb")} />
          </>
        }
        title={recipient ?? email.subject}
        leading={<EmailStatusIcon status={email.latestStatus} size={42} />}
        subtitle={sublineParts.join(" · ")}
        actions={<ApiDocsButton />}
      />

      {hardBounced ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            backgroundColor: "var(--ms-ground)",
            backgroundImage: statusGlow("danger"),
            border: "1px solid var(--ms-danger-border)",
            borderRadius: 12,
            padding: "12px 16px",
            marginBottom: 24,
          }}
        >
          <span style={{ fontSize: 13.5, color: "var(--ms-danger)" }}>
            {t("detail.bounceBanner.hard")}
          </span>
          <span style={{ fontSize: 13.5, color: "var(--ms-bone)" }}>
            {t("detail.bounceBanner.suppressed")}
          </span>
        </div>
      ) : null}

      <div
        className="ms-meta-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: "22px 28px",
          padding: "22px 0",
          borderTop: "1px solid var(--ms-line)",
          borderBottom: "1px solid var(--ms-line)",
        }}
      >
        <Meta label={t("detail.from")} mono>
          {email.from}
        </Meta>
        <Meta label={t("detail.subject")}>{email.subject}</Meta>
        <div>
          <Microlabel>{t("detail.id")}</Microlabel>
          <div style={{ marginTop: 4 }}>
            <CopyChip value={email.id} />
          </div>
        </div>
        {email.to.length > 1 ? (
          <Meta label={t("detail.to")} mono>
            {email.to.join(", ")}
          </Meta>
        ) : null}
        {email.cc?.length ? (
          <Meta label={t("detail.cc")} mono>
            {email.cc.join(", ")}
          </Meta>
        ) : null}
        {email.bcc?.length ? (
          <Meta label={t("detail.bcc")} mono>
            {email.bcc.join(", ")}
          </Meta>
        ) : null}
        {email.replyTo?.length ? (
          <Meta label={t("detail.replyTo")} mono>
            {email.replyTo.join(", ")}
          </Meta>
        ) : null}
        {email.tags && Object.keys(email.tags).length > 0 ? (
          <div>
            <Microlabel>{t("detail.tags")}</Microlabel>
            <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" }}>
              {Object.entries(email.tags).map(([key, value]) => (
                <span key={key} className="ms-chip" style={{ fontSize: 11.5, padding: "3px 8px" }}>
                  {key}:{value}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {email.apiKeyName ? (
          <Meta label={t("detail.apiKey")} mono>
            {email.apiKeyName}
          </Meta>
        ) : null}
      </div>

      <div style={{ marginTop: 26 }}>
        <div className="ms-microlabel">{t("detail.events")}</div>
        {events.length === 0 ? (
          <p style={{ margin: "12px 0 0", color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
            {t("detail.noEvents")}
          </p>
        ) : (
          <div
            style={{
              marginTop: 12,
              border: "1px solid var(--ms-line)",
              borderRadius: 14,
              padding: "30px 26px",
              backgroundImage: "radial-gradient(var(--ms-line) 1px, transparent 1px)",
              backgroundSize: "18px 18px",
              backgroundPosition: "center",
              display: "flex",
              alignItems: "flex-start",
              gap: 6,
              overflowX: "auto",
            }}
          >
            {groups.map((group, index) => {
              const { type, first } = group;
              const count = group.occurrences.length;
              const latest = index === groups.length - 1;
              const previous = index > 0 ? groups[index - 1] : undefined;
              // Connector deltas run between first occurrences — the group's
              // anchor — so the strip stays chronological even when a later
              // repeat outlives the next type's start.
              const delta = previous
                ? new Date(first.occurredAt).getTime() -
                  new Date(previous.first.occurredAt).getTime()
                : null;
              // Bounced/suppressed keep their first-occurrence framing (their
              // dedicated drawers explain the terminal fact); repeat-prone
              // types stamp the node with the group's latest occurrence.
              const stamped =
                type === "bounced" || type === "suppressed"
                  ? first
                  : (group.occurrences[count - 1] ?? first);
              const detail = eventDetail(type, first.data);
              const opens =
                type === "bounced" && bounceOf(first.data)
                  ? ("bounced" as const)
                  : type === "suppressed"
                    ? ("suppressed" as const)
                    : count > 1
                      ? ("group" as const)
                      : null;
              // Icon-tile node: glyph tile, status pill, timestamp, detail —
              // the connector line meets the tiles at their vertical center.
              const card = (
                <>
                  <span style={{ position: "relative", display: "inline-flex" }}>
                    <EventIconTile type={type} />
                    {latest ? (
                      <span
                        style={{
                          position: "absolute",
                          top: -3,
                          right: -3,
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          background: EVENT_COLOR[type],
                          animation: "ms-pulse 2s infinite",
                        }}
                      />
                    ) : null}
                  </span>
                  <span
                    style={{
                      marginTop: 10,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      padding: "3px 9px",
                      borderRadius: "var(--ms-r-chip)",
                      border: `1px solid color-mix(in srgb, ${EVENT_COLOR[type]} 35%, var(--ms-line))`,
                      background: `color-mix(in srgb, ${EVENT_COLOR[type]} 10%, var(--ms-panel))`,
                      fontSize: 12,
                      fontWeight: 600,
                      color: EVENT_COLOR[type],
                      whiteSpace: "nowrap",
                    }}
                  >
                    {eventLabel(type)}
                    {count > 1 ? (
                      <span className="ms-mono" style={{ fontSize: 10, fontWeight: 500 }}>
                        ×{count}
                      </span>
                    ) : null}
                    {opens ? <span aria-hidden="true">›</span> : null}
                  </span>
                  <span
                    title={formatUtcTimestampMs(stamped.occurredAt)}
                    style={{ fontSize: 12, color: "var(--ms-muted)", marginTop: 7 }}
                  >
                    {formatDayTime(stamped.occurredAt, locale)}
                  </span>
                  {detail ? (
                    <span
                      className="ms-mono"
                      style={{
                        fontSize: 11,
                        color: "var(--ms-muted)",
                        marginTop: 3,
                        maxWidth: 220,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {detail}
                    </span>
                  ) : null}
                </>
              );
              const cardStyle: React.CSSProperties = {
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                textAlign: "center",
                background: "none",
                border: 0,
                padding: 0,
                flex: "none",
              };
              return (
                <div key={first.id} style={{ display: "contents" }}>
                  {delta != null ? (
                    <div
                      style={{
                        flex: "none",
                        minWidth: 56,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: 4,
                        padding: "0 6px",
                        alignSelf: "flex-start",
                        marginTop: 0,
                      }}
                    >
                      <span
                        className="ms-mono"
                        style={{ fontSize: 10.5, color: "var(--ms-muted)" }}
                      >
                        +{formatDurationShort(delta)}
                      </span>
                      <span
                        style={{ height: 1, background: "var(--ms-line-strong)", width: "100%" }}
                      />
                    </div>
                  ) : null}
                  {opens ? (
                    <button
                      type="button"
                      style={{ ...cardStyle, color: "inherit", font: "inherit", cursor: "pointer" }}
                      onClick={() =>
                        opens === "group" ? setGroupDrawer(first.id) : setDrawer(opens)
                      }
                    >
                      {card}
                    </button>
                  ) : (
                    <div style={cardStyle}>{card}</div>
                  )}
                </div>
              );
            })}
            {eventsStalled ? (
              <>
                <div
                  style={{
                    flex: "none",
                    minWidth: 56,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 4,
                    padding: "0 6px",
                    alignSelf: "flex-start",
                  }}
                >
                  <span className="ms-mono" style={{ fontSize: 10.5 }}>
                    &nbsp;
                  </span>
                  <span
                    style={{
                      height: 0,
                      borderTop: "1px dashed var(--ms-line-strong)",
                      width: "100%",
                    }}
                  />
                </div>
                <div style={{ flex: "none" }}>
                  <Tooltip text={t("detail.eventsStalled")}>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 34,
                        height: 34,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderRadius: 10,
                        border: "1px dashed var(--ms-line-strong)",
                        fontSize: 15,
                        fontWeight: 600,
                      }}
                    >
                      ?
                    </span>
                  </Tooltip>
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>

      <div
        style={{
          marginTop: 26,
          background: "var(--ms-panel)",
          border: "1px solid var(--ms-line)",
          borderRadius: 14,
          overflow: "hidden",
        }}
      >
        {/* The tab bar outlives the body purge: insights are content-derived
            metadata and deliberately survive it, so the purge message replaces
            only the preview/text/html panels. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "10px 12px",
            borderBottom: "1px solid var(--ms-line)",
          }}
        >
          {TAB_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              style={{
                fontSize: 13,
                padding: "5px 11px",
                borderRadius: 8,
                border: 0,
                cursor: "pointer",
                background: tab === key ? "var(--ms-panel-raised)" : "none",
                color: tab === key ? "var(--ms-bone)" : "var(--ms-muted)",
                font: "inherit",
              }}
              onClick={() => setTab(key)}
            >
              {tabLabels[key]}
            </button>
          ))}
          {currentContent ? (
            <span style={{ marginLeft: "auto", padding: "0 6px" }}>
              <CopyGlyph value={currentContent} />
            </span>
          ) : null}
        </div>
        {tab === "insights" ? (
          email.insights ? (
            <InsightsSection insights={email.insights} />
          ) : (
            <div style={{ padding: "16px 18px" }}>
              <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
                {t("insights.empty")}
              </p>
              <p style={{ margin: "6px 0 0", color: "var(--ms-faint)", fontSize: 13 }}>
                {t("insights.emptyHint")}
              </p>
            </div>
          )
        ) : email.bodyPurgedAt ? (
          <p
            style={{
              margin: 0,
              padding: "16px 18px",
              color: "var(--ms-muted)",
              fontSize: "var(--ms-fs-ui)",
            }}
          >
            {t("detail.bodyPurged")}
          </p>
        ) : (
          <>
            {tab === "preview" &&
              (email.html ? (
                <div
                  style={{
                    background: "var(--ms-inset)",
                    padding: 28,
                    display: "flex",
                    justifyContent: "center",
                  }}
                >
                  <iframe
                    title={t("detail.preview")}
                    sandbox=""
                    srcDoc={email.html}
                    style={{
                      width: 560,
                      maxWidth: "100%",
                      height: 480,
                      border: 0,
                      borderRadius: 8,
                      background: "#ffffff",
                    }}
                  />
                </div>
              ) : (
                <p
                  style={{
                    margin: 0,
                    padding: "16px 18px",
                    color: "var(--ms-muted)",
                    fontSize: "var(--ms-fs-ui)",
                  }}
                >
                  {t("detail.noHtml")}
                </p>
              ))}
            {tab === "text" &&
              (email.text ? (
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    margin: 0,
                    padding: "16px 18px",
                    fontFamily: "var(--ms-font-sans)",
                    fontSize: "var(--ms-fs-ui)",
                    lineHeight: 1.7,
                  }}
                >
                  {email.text}
                </pre>
              ) : (
                <p
                  style={{
                    margin: 0,
                    padding: "16px 18px",
                    color: "var(--ms-muted)",
                    fontSize: "var(--ms-fs-ui)",
                  }}
                >
                  {t("detail.noText")}
                </p>
              ))}
            {tab === "html" &&
              (email.html ? (
                <pre
                  className="ms-mono"
                  style={{
                    margin: 0,
                    padding: "16px 18px",
                    fontSize: 12,
                    lineHeight: 1.7,
                    color: "var(--ms-bone)",
                    overflowX: "auto",
                  }}
                >
                  {email.html}
                </pre>
              ) : (
                <p
                  style={{
                    margin: 0,
                    padding: "16px 18px",
                    color: "var(--ms-muted)",
                    fontSize: "var(--ms-fs-ui)",
                  }}
                >
                  {t("detail.noHtml")}
                </p>
              ))}
          </>
        )}
      </div>

      <Drawer
        open={drawer === "bounced"}
        onClose={() => setDrawer(null)}
        title={t("bouncedDrawer.title")}
      >
        <div className="ms-wrap-row" style={{ display: "flex", gap: 36, marginTop: 18 }}>
          <div>
            <Microlabel>{t("bouncedDrawer.type")}</Microlabel>
            <div style={{ fontSize: 14, marginTop: 4 }}>{bounce?.bounceType ?? "—"}</div>
          </div>
          <div>
            <Microlabel>{t("bouncedDrawer.subtype")}</Microlabel>
            <div style={{ fontSize: 14, marginTop: 4 }}>{bounce?.bounceSubType ?? "—"}</div>
          </div>
          <div>
            <Microlabel>{t("bouncedDrawer.code")}</Microlabel>
            <div className="ms-mono" style={{ fontSize: 13, marginTop: 5 }}>
              {bounceCode ?? "—"}
            </div>
          </div>
        </div>
        {bounceDiag ? (
          <>
            <div className="ms-microlabel" style={{ margin: "20px 0 8px" }}>
              {t("bouncedDrawer.smtpResponse")}
            </div>
            <CodeBlock value={bounceDiag} />
          </>
        ) : null}
        <div className="ms-microlabel" style={{ margin: "20px 0 8px" }}>
          {t("bouncedDrawer.whatToDo")}
        </div>
        <GuidanceBlock guidanceKey={bounceGuidance.key} />
        {recipient ? (
          <>
            <div className="ms-microlabel" style={{ margin: "20px 0 8px" }}>
              {t("bouncedDrawer.copyReady")}
            </div>
            <CopyChip value={recipient} />
          </>
        ) : null}
      </Drawer>

      <Drawer
        open={drawer === "suppressed"}
        onClose={() => setDrawer(null)}
        title={t("suppressedDrawer.title")}
      >
        <div className="ms-wrap-row" style={{ display: "flex", gap: 32, marginTop: 16 }}>
          <div>
            <Microlabel>{t("suppressedDrawer.origin")}</Microlabel>
            <div style={{ fontSize: 14, marginTop: 4 }}>
              {suppressionRow
                ? [
                    t(`suppressions.reason.${suppressionRow.reason}`),
                    ...(suppressionRow.reason === "hard_bounce" && bounce?.bounceType
                      ? [bounce.bounceType.toLowerCase()]
                      : []),
                  ].join(" — ")
                : "—"}
            </div>
          </div>
          <div>
            <Microlabel>{t("suppressedDrawer.added")}</Microlabel>
            <div style={{ fontSize: 14, marginTop: 4 }}>
              {suppressionRow ? formatRelative(suppressionRow.createdAt, locale) : "—"}
            </div>
          </div>
        </div>
        {recipient ? (
          <div style={{ marginTop: 12 }}>
            <Microlabel>{t("suppressedDrawer.recipient")}</Microlabel>
            <div className="ms-mono" style={{ fontSize: 13, marginTop: 5 }}>
              {recipient}
            </div>
          </div>
        ) : null}
        <div style={{ fontSize: 13, color: "var(--ms-muted)", lineHeight: 1.6, marginTop: 14 }}>
          {t.rich("suppressedDrawer.blocked", {
            code: (chunks) => (
              <span className="ms-mono" style={{ fontSize: 12, color: "var(--ms-bone)" }}>
                {chunks}
              </span>
            ),
          })}
        </div>
        <div className="ms-microlabel" style={{ margin: "16px 0 6px" }}>
          {t("suppressedDrawer.suggestedActions")}
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <StepRow index={1} text={t("suppressedDrawer.step1")} />
          <StepRow index={2} text={t("suppressedDrawer.step2")} last />
        </div>
        <button
          type="button"
          className="ms-btn ms-btn-destructive"
          style={{ width: "100%", justifyContent: "center", marginTop: 16 }}
          disabled={!suppressionRow || removeMutation.isPending}
          onClick={() => {
            if (suppressionRow) removeMutation.mutate({ id: suppressionRow.id });
          }}
        >
          <BtnSpinner on={removeMutation.isPending} />
          {t("suppressedDrawer.remove")}
        </button>
      </Drawer>

      <Drawer
        open={groupDrawer != null}
        onClose={() => setGroupDrawer(null)}
        title={
          openGroup
            ? t("occurrencesDrawer.title", {
                label: eventLabel(openGroup.type),
                count: groupOccurrences.length,
              })
            : ""
        }
      >
        <div className="ms-microlabel" style={{ margin: "18px 0 4px" }}>
          {t("occurrencesDrawer.subtitle")}
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {[...groupOccurrences].reverse().map((event, index) => {
            const sinceSend = new Date(event.occurredAt).getTime() - new Date(sendAt).getTime();
            const link = openGroup?.type === "clicked" ? clickOf(event.data)?.link : undefined;
            return (
              <div
                key={event.id}
                style={{
                  padding: "10px 0",
                  borderBottom:
                    index === groupOccurrences.length - 1 ? undefined : "1px solid var(--ms-line)",
                }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                  <span style={{ fontSize: 13.5 }} title={formatUtcTimestampMs(event.occurredAt)}>
                    {formatDayTime(event.occurredAt, locale)}
                  </span>
                  {sinceSend >= 0 ? (
                    <span
                      className="ms-mono"
                      style={{ fontSize: 11, color: "var(--ms-muted)", marginLeft: "auto" }}
                    >
                      +{formatDurationShort(sinceSend)}
                    </span>
                  ) : null}
                </div>
                {link ? (
                  <div
                    className="ms-mono"
                    style={{
                      fontSize: 11,
                      color: "var(--ms-muted)",
                      marginTop: 3,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {link}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </Drawer>
    </>
  );
}
