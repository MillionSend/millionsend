"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { CopyChip } from "@/components/copy-chip";
import { StatusBadge } from "@/components/status-badge";
import { formatUtcTimestamp } from "@/lib/format";
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

/** Ledger word tint — the same status families the badges use. */
const EVENT_TINT: Record<EventType, string> = {
  queued: "neutral",
  queued_quota: "neutral",
  sent: "info",
  delivery_delayed: "warn",
  delivered: "success",
  opened: "info",
  clicked: "info",
  bounced: "danger",
  complained: "danger",
  suppressed: "warn",
  rendering_failure: "danger",
  failed: "danger",
};

const CODE_BLOCK: React.CSSProperties = {
  background: "var(--ms-inset)",
  border: "1px solid var(--ms-line)",
  borderRadius: "var(--ms-r-input)",
  padding: 12,
  overflowX: "auto",
  fontSize: "var(--ms-fs-label)",
  margin: 0,
};

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="ms-microlabel" style={{ marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: "var(--ms-fs-ui)" }}>{children}</div>
    </div>
  );
}

function Dash() {
  return <span style={{ color: "var(--ms-faint)" }}>—</span>;
}

function EventRow({
  timestamp,
  label,
  tint,
  latest,
  expandable,
}: {
  timestamp: string;
  label: string;
  tint: string;
  latest: boolean;
  expandable: boolean;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        gap: 16,
        alignItems: "baseline",
        padding: "7px 0",
        opacity: latest ? 1 : 0.62,
        fontSize: "var(--ms-fs-ui)",
      }}
    >
      <span
        className="ms-mono"
        style={{ color: latest ? "var(--ms-bone)" : "var(--ms-muted)", whiteSpace: "nowrap" }}
      >
        {timestamp}
      </span>
      <span style={{ color: `var(--ms-${tint})`, fontWeight: 500 }}>{label}</span>
      {expandable ? <span style={{ color: "var(--ms-muted)" }}>⌄</span> : null}
    </span>
  );
}

export default function EmailDetailPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations("emails");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const [tab, setTab] = useState<"preview" | "text" | "html">("preview");

  const query = useQuery(trpc.emails.get.queryOptions({ id }, { retry: false }));

  if (query.isPending) {
    return <p style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>{t("loading")}</p>;
  }
  if (query.isError) {
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
  const email = query.data;
  const eventLabel = (type: EventType) =>
    type === "rendering_failure" ? t("detail.event.rendering_failure") : common(`status.${type}`);

  return (
    <>
      <div className="ms-microlabel" style={{ marginBottom: 8 }}>
        {t("detail.eyebrow")}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 28 }}>
        <h1
          className="ms-display"
          style={{ fontSize: "var(--ms-fs-h1)", margin: 0, color: "var(--ms-bone)" }}
        >
          {email.to[0] ?? email.subject}
        </h1>
        <StatusBadge status={email.latestStatus} />
      </div>

      <div
        className="ms-card"
        style={{
          padding: 24,
          marginBottom: 20,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 20,
        }}
      >
        <Meta label={t("detail.from")}>
          <span className="ms-mono">{email.from}</span>
        </Meta>
        <Meta label={t("detail.subject")}>{email.subject}</Meta>
        <Meta label={t("detail.to")}>
          <span className="ms-mono">{email.to.join(", ")}</span>
        </Meta>
        <Meta label={t("detail.id")}>
          <CopyChip value={email.id} />
        </Meta>
        <Meta label={t("detail.replyTo")}>
          {email.replyTo?.length ? (
            <span className="ms-mono">{email.replyTo.join(", ")}</span>
          ) : (
            <Dash />
          )}
        </Meta>
        <Meta label={t("detail.tags")}>
          {email.tags && Object.keys(email.tags).length > 0 ? (
            <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
              {Object.entries(email.tags).map(([key, value]) => (
                <span key={key} className="ms-chip">
                  {key}:{value}
                </span>
              ))}
            </span>
          ) : (
            <Dash />
          )}
        </Meta>
      </div>

      <div className="ms-card" style={{ padding: 24, marginBottom: 20 }}>
        <div className="ms-microlabel" style={{ marginBottom: 14 }}>
          {t("detail.events")}
        </div>
        {email.events.length === 0 ? (
          <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
            {t("detail.noEvents")}
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {email.events.map((event, index) => {
              const latest = index === email.events.length - 1;
              const expandable =
                (event.type === "bounced" || event.type === "complained") && event.data != null;
              const rowProps = {
                timestamp: formatUtcTimestamp(event.occurredAt),
                label: eventLabel(event.type),
                tint: EVENT_TINT[event.type],
                latest,
                expandable,
              };
              return expandable ? (
                <details key={event.id}>
                  <summary style={{ listStyle: "none", cursor: "pointer" }}>
                    <EventRow {...rowProps} />
                  </summary>
                  <pre className="ms-mono" style={{ ...CODE_BLOCK, margin: "4px 0 10px" }}>
                    {JSON.stringify(event.data, null, 2)}
                  </pre>
                </details>
              ) : (
                <div key={event.id}>
                  <EventRow {...rowProps} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="ms-card" style={{ padding: 24 }}>
        {email.bodyPurgedAt ? (
          <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
            {t("detail.bodyPurged")}
          </p>
        ) : (
          <>
            <div className="ms-tabs" style={{ marginBottom: 16 }}>
              <button
                type="button"
                className={tab === "preview" ? "active" : ""}
                onClick={() => setTab("preview")}
              >
                {t("detail.preview")}
              </button>
              <button
                type="button"
                className={tab === "text" ? "active" : ""}
                onClick={() => setTab("text")}
              >
                {t("detail.plainText")}
              </button>
              <button
                type="button"
                className={tab === "html" ? "active" : ""}
                onClick={() => setTab("html")}
              >
                {t("detail.html")}
              </button>
            </div>
            {tab === "preview" &&
              (email.html ? (
                <iframe
                  title={t("detail.preview")}
                  sandbox=""
                  srcDoc={email.html}
                  style={{
                    width: "100%",
                    height: 480,
                    border: "1px solid var(--ms-line)",
                    borderRadius: "var(--ms-r-input)",
                    background: "#ffffff",
                  }}
                />
              ) : (
                <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
                  {t("detail.noHtml")}
                </p>
              ))}
            {tab === "text" &&
              (email.text ? (
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    margin: 0,
                    fontFamily: "var(--ms-font-sans)",
                    fontSize: "var(--ms-fs-body)",
                  }}
                >
                  {email.text}
                </pre>
              ) : (
                <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
                  {t("detail.noText")}
                </p>
              ))}
            {tab === "html" &&
              (email.html ? (
                <>
                  <div style={{ marginBottom: 10 }}>
                    <CopyChip value={email.html} display={t("detail.copyHtml")} />
                  </div>
                  <pre className="ms-mono" style={CODE_BLOCK}>
                    {email.html}
                  </pre>
                </>
              ) : (
                <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
                  {t("detail.noHtml")}
                </p>
              ))}
          </>
        )}
      </div>
    </>
  );
}
