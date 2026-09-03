"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { CodeHighlight } from "@/components/code-highlight";
import { CopyChip } from "@/components/copy-chip";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { Skeleton, SkeletonChip } from "@/components/skeleton";
import { formatDayTime, formatUtcTimestampMs } from "@/lib/format";
import { statusCodeColor } from "@/lib/status-code-color";
import { useTRPC } from "@/lib/trpc";

function Microlabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
      {children}
    </div>
  );
}

/** REQUEST/RESPONSE panel: pretty-printed JSON in a mono pre, scrolls inside. */
function JsonSection({ label, value, noBody }: { label: string; value: unknown; noBody: string }) {
  return (
    <section style={{ marginTop: 26 }}>
      <div className="ms-microlabel">{label}</div>
      <div
        style={{
          marginTop: 10,
          background: "var(--ms-panel)",
          border: "1px solid var(--ms-line)",
          borderRadius: 14,
          overflow: "hidden",
        }}
      >
        {value == null ? (
          <p
            style={{
              margin: 0,
              padding: "14px 16px",
              color: "var(--ms-muted)",
              fontSize: "var(--ms-fs-ui)",
            }}
          >
            {noBody}
          </p>
        ) : (
          <pre
            className="ms-mono ms-hl"
            style={{
              margin: 0,
              padding: "14px 16px",
              fontSize: 12,
              lineHeight: 1.7,
              color: "var(--ms-bone)",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            <CodeHighlight code={JSON.stringify(value, null, 2)} language="json" />
          </pre>
        )}
      </div>
    </section>
  );
}

/** JsonSection's boxes with the pre's lines as bars. */
function JsonSectionSkeleton({ label }: { label: string }) {
  return (
    <section style={{ marginTop: 26 }}>
      <div className="ms-microlabel">{label}</div>
      <div
        style={{
          marginTop: 10,
          background: "var(--ms-panel)",
          border: "1px solid var(--ms-line)",
          borderRadius: 14,
          overflow: "hidden",
        }}
      >
        <div
          className="ms-mono"
          style={{
            padding: "14px 16px",
            fontSize: 12,
            lineHeight: 1.7,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
          }}
        >
          {[64, 220, 180, 96].map((width, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholder lines, position is identity
            <span key={index} style={{ display: "flex" }}>
              <Skeleton width={width} height="1lh" />
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Mirrors the loaded page's boxes (header, meta strip, request/response panels). */
function LogDetailSkeleton() {
  const t = useTranslations("logs");
  return (
    <>
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", fontSize: 13, lineHeight: 1, marginBottom: 10 }}>
          <Skeleton width={180} height="1lh" />
        </div>
        <h1
          className="ms-display"
          style={{ fontSize: "var(--ms-fs-h1)", fontWeight: 600, margin: 0, display: "flex" }}
        >
          <Skeleton width={300} height="1lh" />
        </h1>
      </div>

      <div
        className="ms-meta-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: "22px 28px",
          padding: "22px 0",
          borderTop: "1px solid var(--ms-line)",
          borderBottom: "1px solid var(--ms-line)",
        }}
      >
        <div>
          <Microlabel>{t("detail.status")}</Microlabel>
          <div className="ms-mono" style={{ fontSize: 13, marginTop: 5, display: "flex" }}>
            <Skeleton width={32} height="1lh" />
          </div>
        </div>
        <div>
          <Microlabel>{t("detail.when")}</Microlabel>
          <div className="ms-mono" style={{ fontSize: 13, marginTop: 5, display: "flex" }}>
            <Skeleton width={220} height="1lh" />
          </div>
        </div>
        <div>
          <Microlabel>{t("detail.id")}</Microlabel>
          <div style={{ marginTop: 4 }}>
            <SkeletonChip width={190} />
          </div>
        </div>
      </div>

      <JsonSectionSkeleton label={t("detail.request")} />
      <JsonSectionSkeleton label={t("detail.response")} />
    </>
  );
}

export default function LogDetailPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations("logs");
  const locale = useLocale();
  const trpc = useTRPC();

  const query = useQuery(trpc.logs.get.queryOptions({ id }, { retry: false }));
  const log = query.data;

  if (query.isPending) {
    return <LogDetailSkeleton />;
  }
  if (query.isError || !log) {
    return (
      <>
        <p style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
          {t("detail.notFound")}
        </p>
        <Link href="/logs" style={{ fontSize: "var(--ms-fs-ui)" }}>
          ← {t("list.title")}
        </Link>
      </>
    );
  }

  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Crumb href="/logs" label={t("list.title")} />
            <CrumbEnd label={t("detail.eyebrow")} />
          </>
        }
        title={`${log.method} ${log.path}`}
      />

      <div
        className="ms-meta-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: "22px 28px",
          padding: "22px 0",
          borderTop: "1px solid var(--ms-line)",
          borderBottom: "1px solid var(--ms-line)",
        }}
      >
        <div>
          <Microlabel>{t("detail.status")}</Microlabel>
          <div
            className="ms-mono"
            style={{ fontSize: 13, marginTop: 5, color: statusCodeColor(log.statusCode) }}
          >
            {log.statusCode}
          </div>
        </div>
        <div>
          <Microlabel>{t("detail.when")}</Microlabel>
          <div style={{ fontSize: 13, marginTop: 5 }}>
            <span title={formatUtcTimestampMs(log.createdAt)}>
              {formatDayTime(log.createdAt, locale)}
            </span>
            <span style={{ color: "var(--ms-muted)", marginLeft: 10 }}>
              <RelativeTime date={log.createdAt} />
            </span>
          </div>
        </div>
        <div>
          <Microlabel>{t("detail.id")}</Microlabel>
          <div style={{ marginTop: 4 }}>
            <CopyChip value={log.id} />
          </div>
        </div>
      </div>

      <JsonSection
        label={t("detail.request")}
        value={log.requestBody}
        noBody={t("detail.requestNotStored")}
      />
      <JsonSection
        label={t("detail.response")}
        value={log.responseBody}
        noBody={t("detail.responseNotStored")}
      />
    </>
  );
}
