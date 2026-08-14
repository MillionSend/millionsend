"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { CopyChip, CopyGlyph } from "@/components/copy-chip";
import { Drawer } from "@/components/drawer";
import { CodeGlyph } from "@/components/icons/nav-icons";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { formatDurationShort, formatRelative, formatUtcTimestampMs } from "@/lib/format";
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
function deliveryOf(data: EventData): { smtpResponse?: string } | null {
  const d = data?.delivery;
  return d && typeof d === "object" ? (d as { smtpResponse?: string }) : null;
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
  if (!diagnostic) return null;
  const match = /(\d{3})[ -]+(\d+\.\d+\.\d+)/.exec(diagnostic);
  return match ? `${match[1]} ${match[2]}` : null;
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

const TAB_KEYS = ["preview", "text", "html"] as const;
type Tab = (typeof TAB_KEYS)[number];

export default function EmailDetailPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations("emails");
  const common = useTranslations("common");
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("preview");
  const [drawer, setDrawer] = useState<"bounced" | "suppressed" | null>(null);

  const query = useQuery(trpc.emails.get.queryOptions({ id }, { retry: false }));
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
    return <p style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>{t("loading")}</p>;
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

  const events = email.events;
  const eventLabel = (type: EventType) =>
    type === "rendering_failure" ? t("detail.event.rendering_failure") : common(`status.${type}`);

  const sentEvent = events.find((event) => event.type === "sent");
  const terminalEvent = [...events].reverse().find((event) => event.type === email.latestStatus);
  const lastBounce = [...events].reverse().find((event) => event.type === "bounced");
  const bounce = lastBounce ? bounceOf(lastBounce.data) : null;
  const bounceDiag = bounce?.bouncedRecipients?.[0]?.diagnosticCode;
  const bounceCode = smtpCode(bounceDiag) ?? bounce?.bouncedRecipients?.[0]?.status ?? null;
  const hardBounced = bounce?.bounceType === "Permanent";

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
    if (type === "delivered") return deliveryOf(data)?.smtpResponse ?? null;
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
  };
  const currentContent = tabContent[tab];
  const tabLabels: Record<Tab, string> = {
    preview: t("detail.preview"),
    text: t("detail.plainText"),
    html: t("detail.html"),
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
        subtitle={sublineParts.join(" · ")}
        actions={
          <a className="ms-btn ms-btn-icon" href="#emails-api" aria-label={t("list.apiDocs")}>
            <CodeGlyph size={14} />
          </a>
        }
      />

      {hardBounced ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            backgroundColor: "#050505",
            backgroundImage:
              "radial-gradient(130% 200% at 0% 50%, rgba(224,127,118,.14), rgba(224,127,118,0) 58%)",
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
            <CopyChip value={email.id} display={`${email.id.slice(0, 23)}…`} />
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
              alignItems: "center",
              overflowX: "auto",
            }}
          >
            {events.map((event, index) => {
              const type = event.type as EventType;
              const latest = index === events.length - 1;
              const previous = index > 0 ? events[index - 1] : undefined;
              const delta = previous
                ? new Date(event.occurredAt).getTime() - new Date(previous.occurredAt).getTime()
                : null;
              const detail = eventDetail(type, event.data);
              const opens =
                type === "bounced" && bounceOf(event.data)
                  ? ("bounced" as const)
                  : type === "suppressed"
                    ? ("suppressed" as const)
                    : null;
              const card = (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {latest ? (
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background: "var(--ms-steel)",
                          animation: "ms-pulse 2s infinite",
                          flex: "none",
                        }}
                      />
                    ) : null}
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: EVENT_COLOR[type] }}>
                      {eventLabel(type)}
                    </span>
                    {opens ? (
                      <span style={{ marginLeft: "auto", color: "var(--ms-faint)", fontSize: 12 }}>
                        ›
                      </span>
                    ) : null}
                  </div>
                  <div
                    className="ms-mono"
                    style={{ fontSize: 11.5, color: "var(--ms-muted)", marginTop: 7 }}
                  >
                    {formatUtcTimestampMs(event.occurredAt)}
                  </div>
                  {detail ? (
                    <div
                      className="ms-mono"
                      style={{
                        fontSize: 11.5,
                        color: "var(--ms-muted)",
                        marginTop: 3,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {detail}
                    </div>
                  ) : null}
                </>
              );
              const cardStyle: React.CSSProperties = {
                background: "var(--ms-panel)",
                border: "1px solid var(--ms-line)",
                borderRadius: 12,
                padding: "12px 16px",
                width: 264,
                boxSizing: "border-box",
                flex: "none",
                textAlign: "left",
              };
              return (
                <div key={event.id} style={{ display: "contents" }}>
                  {delta != null ? (
                    <div
                      style={{
                        flex: 1,
                        minWidth: 36,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: 5,
                        padding: "0 4px",
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
                      onClick={() => setDrawer(opens)}
                    >
                      {card}
                    </button>
                  ) : (
                    <div style={cardStyle}>{card}</div>
                  )}
                </div>
              );
            })}
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
        {email.bodyPurgedAt ? (
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
            {tab === "preview" &&
              (email.html ? (
                <div
                  style={{
                    background: "#26262a",
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
        <div style={{ display: "flex", gap: 36, marginTop: 18 }}>
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
        <div style={{ display: "flex", flexDirection: "column" }}>
          <StepRow index={1} text={t("bouncedDrawer.step1")} />
          <StepRow index={2} text={t("bouncedDrawer.step2")} />
          <StepRow index={3} text={t("bouncedDrawer.step3")} />
        </div>
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
        <div style={{ display: "flex", gap: 32, marginTop: 16 }}>
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
          {t("suppressedDrawer.remove")}
        </button>
      </Drawer>
    </>
  );
}
