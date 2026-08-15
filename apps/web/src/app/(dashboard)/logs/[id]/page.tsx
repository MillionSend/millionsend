"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { CopyChip } from "@/components/copy-chip";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { formatUtcTimestampMs } from "@/lib/format";
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
function JsonSection({
  label,
  value,
  note,
  noBody,
}: {
  label: string;
  value: unknown;
  note?: string | undefined;
  noBody: string;
}) {
  return (
    <section style={{ marginTop: 26 }}>
      <div className="ms-microlabel">{label}</div>
      {note ? (
        <div style={{ fontSize: 12.5, color: "var(--ms-muted)", marginTop: 6 }}>{note}</div>
      ) : null}
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
            className="ms-mono"
            style={{
              margin: 0,
              padding: "14px 16px",
              fontSize: 12,
              lineHeight: 1.7,
              color: "var(--ms-bone)",
              overflowX: "auto",
            }}
          >
            {JSON.stringify(value, null, 2)}
          </pre>
        )}
      </div>
    </section>
  );
}

export default function LogDetailPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations("logs");
  const trpc = useTRPC();

  const query = useQuery(trpc.logs.get.queryOptions({ id }, { retry: false }));
  const log = query.data;

  if (query.isPending) {
    return <p style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>{t("loading")}</p>;
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

  const redacted = JSON.stringify(log.requestBody ?? null).includes('"[redacted]"');

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
          <div className="ms-mono" style={{ fontSize: 13, marginTop: 5 }}>
            {formatUtcTimestampMs(log.createdAt)}
            <span style={{ color: "var(--ms-muted)", marginLeft: 10 }}>
              <RelativeTime date={log.createdAt} />
            </span>
          </div>
        </div>
        <div>
          <Microlabel>{t("detail.id")}</Microlabel>
          <div style={{ marginTop: 4 }}>
            <CopyChip value={log.id} display={`${log.id.slice(0, 23)}…`} />
          </div>
        </div>
      </div>

      <JsonSection
        label={t("detail.request")}
        value={log.requestBody}
        note={redacted ? t("detail.redacted") : undefined}
        noBody={t("detail.noBody")}
      />
      <JsonSection
        label={t("detail.response")}
        value={log.responseBody}
        noBody={t("detail.noBody")}
      />
    </>
  );
}
