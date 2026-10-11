"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Breakable } from "@/components/breakable";
import { CopyChip } from "@/components/copy-chip";
import { EmailContentPanel } from "@/components/email-content-panel";
import { LoadError } from "@/components/load-error";
import { MetaItem } from "@/components/meta-item";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { Skeleton, SkeletonBadge, SkeletonChip } from "@/components/skeleton";
import { Table } from "@/components/table";
import { AUTH_CHECKS } from "@/lib/auth-result";
import { formatBytes, formatRelative } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";
import { AuthBadge } from "../../received-list";

const LIST_HREF = "/emails?source=receiving";

const META_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, 1fr)",
  gap: "22px 28px",
  padding: "22px 0",
  borderTop: "1px solid var(--ms-line)",
  borderBottom: "1px solid var(--ms-line)",
};

/** A meta value that is data: mono, breaking between an address's parts. */
function Mono({ text }: { text: string }) {
  return (
    <span className="ms-mono" style={{ fontSize: 13, overflowWrap: "anywhere" }}>
      <Breakable text={text} />
    </span>
  );
}

/** Mirrors the loaded page's boxes (header, meta grid, content panel). */
function ReceivedEmailSkeleton() {
  const t = useTranslations("emails");
  return (
    <>
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", fontSize: 13, lineHeight: 1, marginBottom: 10 }}>
          <Skeleton width={150} height="1lh" />
        </div>
        <h1
          className="ms-display"
          style={{ fontSize: "var(--ms-fs-h1)", margin: 0, display: "flex" }}
        >
          <Skeleton width={260} height="1lh" />
        </h1>
        <div className="ms-mono" style={{ fontSize: 12, marginTop: 8, display: "flex" }}>
          <Skeleton width={180} height="1lh" />
        </div>
      </div>
      <div className="ms-meta-grid" style={META_GRID}>
        <MetaItem label={t("detail.subject")}>
          <Skeleton width={200} height={14} />
        </MetaItem>
        <MetaItem label={t("detail.id")}>
          <SkeletonChip width={190} />
        </MetaItem>
        <MetaItem label={t("receiving.auth")}>
          <SkeletonBadge width={70} />
          <SkeletonBadge width={76} />
          <SkeletonBadge width={84} />
        </MetaItem>
      </div>
      <div
        style={{
          marginTop: 26,
          height: 640,
          border: "1px solid var(--ms-line)",
          borderRadius: 14,
          background: "var(--ms-panel)",
        }}
      />
    </>
  );
}

export default function ReceivedEmailPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations("emails");
  const locale = useLocale();
  const trpc = useTRPC();
  const query = useQuery(
    trpc.receiving.get.queryOptions(
      { id },
      // Each read parses the raw message again (up to 40 MiB), so a refocus
      // reuses it for a while; the download links are signed for an hour, and
      // a page left open re-signs them well before they lapse.
      { retry: false, staleTime: 10 * 60_000, refetchInterval: 30 * 60_000 },
    ),
  );
  const email = query.data;

  if (query.isPending) return <ReceivedEmailSkeleton />;
  if (query.isError || !email) {
    return (
      <LoadError
        error={query.error}
        headline={t("receiving.detail.error")}
        notFoundHeadline={t("receiving.detail.notFound")}
        onRetry={() => query.refetch()}
        backHref={LIST_HREF}
        backLabel={t("list.title")}
      />
    );
  }

  const { envelope } = email;
  const subtitle = [
    formatRelative(email.createdAt, locale),
    formatBytes(email.sizeBytes),
    ...(email.attachmentCount > 0
      ? [t("receiving.detail.attachmentCount", { count: email.attachmentCount })]
      : []),
  ].join(" · ");

  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Crumb href={LIST_HREF} label={t("list.title")} />
            <CrumbEnd label={t("receiving.detail.breadcrumb")} />
          </>
        }
        title={email.from || email.subject || t("receiving.noSubject")}
        subtitle={subtitle}
        actions={
          email.rawUrl ? (
            <a className="ms-btn ms-btn-secondary" href={email.rawUrl}>
              {t("receiving.detail.downloadRaw")}
            </a>
          ) : null
        }
      />

      <div className="ms-meta-grid" style={META_GRID}>
        <MetaItem label={t("detail.subject")}>
          {email.subject || (
            <span style={{ color: "var(--ms-muted)" }}>{t("receiving.noSubject")}</span>
          )}
        </MetaItem>
        <MetaItem label={t("detail.id")}>
          <CopyChip value={email.id} />
        </MetaItem>
        <MetaItem label={t("receiving.auth")}>
          {AUTH_CHECKS.map((check) => (
            <AuthBadge key={check} check={check} result={email.authentication[check]} />
          ))}
        </MetaItem>
        {email.to.length > 0 ? (
          <MetaItem label={t("detail.to")}>
            <Mono text={email.to.join(", ")} />
          </MetaItem>
        ) : null}
        <MetaItem label={t("receiving.detail.receivedFor")}>
          <Mono text={email.receivedFor.join(", ")} />
        </MetaItem>
        {email.cc.length > 0 ? (
          <MetaItem label={t("detail.cc")}>
            <Mono text={email.cc.join(", ")} />
          </MetaItem>
        ) : null}
        {email.replyTo.length > 0 ? (
          <MetaItem label={t("detail.replyTo")}>
            <Mono text={email.replyTo.join(", ")} />
          </MetaItem>
        ) : null}
        <MetaItem label={t("receiving.detail.envelopeFrom")}>
          {/* The null sender <> is how bounces and auto-replies arrive. */}
          <Mono text={envelope.mailFrom || "<>"} />
        </MetaItem>
        <MetaItem label={t("receiving.detail.server")}>
          <Mono
            text={[
              envelope.clientIp,
              envelope.helo,
              envelope.tls?.protocol ?? t("receiving.detail.noTls"),
            ].join(" · ")}
          />
        </MetaItem>
        <MetaItem label={t("receiving.detail.messageId")}>
          <CopyChip value={email.messageId} />
        </MetaItem>
      </div>

      {email.attachments.length > 0 ? (
        <section style={{ marginTop: 26 }}>
          <div className="ms-microlabel">{t("receiving.detail.attachments")}</div>
          <div style={{ marginTop: 10 }}>
            <Table>
              <thead>
                <tr>
                  <th>{t("receiving.detail.file")}</th>
                  <th style={{ width: "24%" }}>{t("receiving.detail.type")}</th>
                  <th className="right" style={{ width: 96 }}>
                    {t("receiving.detail.size")}
                  </th>
                  <th className="right" style={{ width: 96 }} />
                </tr>
              </thead>
              <tbody>
                {email.attachments.map((attachment) => (
                  <tr key={attachment.id}>
                    <td className="ms-mono ms-cell-wrap">
                      <Breakable text={attachment.filename ?? t("receiving.detail.unnamed")} />
                      {attachment.inline ? (
                        <span
                          className="ms-chip"
                          style={{ fontSize: 10.5, padding: "1px 7px", marginLeft: 8 }}
                        >
                          {t("receiving.detail.inline")}
                        </span>
                      ) : null}
                    </td>
                    <td className="ms-mono" style={{ color: "var(--ms-muted)" }}>
                      {attachment.contentType}
                    </td>
                    <td className="right ms-mono">{formatBytes(attachment.size)}</td>
                    <td className="right">
                      <a className="ms-link" href={attachment.downloadUrl}>
                        {t("receiving.detail.download")}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </section>
      ) : null}

      <div style={{ marginTop: 26 }}>
        <EmailContentPanel
          email={{
            id: email.id,
            subject: email.subject,
            html: email.html,
            text: email.text,
            insights: null,
            bodyPurgedAt: email.contentPurgedAt,
            hiddenBySupportView: email.hiddenBySupportView,
          }}
          received={{ headers: email.headers }}
        />
      </div>
    </>
  );
}
