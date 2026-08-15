"use client";

import { resolveBounceGuidance, resolveComplaintGuidance } from "@millionsend/core/bounce-guidance";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CopyGlyph } from "@/components/copy-chip";
import { GuidanceBlock } from "@/components/guidance-block";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { formatUtcMinute } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";

type BounceData = {
  bounceType?: string;
  bounceSubType?: string;
  bouncedRecipients?: Array<{ diagnosticCode?: string }>;
};

/** Recipient domain for provider-keyed bounce guidance. */
function domainOf(address: string | null): string | null {
  const at = address?.lastIndexOf("@") ?? -1;
  return at >= 0 ? (address as string).slice(at + 1) : null;
}

/** Mirrors the loaded page's boxes (header + action button, meta strip). */
function SuppressionDetailSkeleton() {
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
            <Skeleton width={220} height="1lh" />
          </div>
          <h1
            className="ms-display"
            style={{ fontSize: "var(--ms-fs-h1)", fontWeight: 600, margin: 0, display: "flex" }}
          >
            <Skeleton width={280} height="1lh" />
          </h1>
        </div>
        <Skeleton width={110} height={30} radius="var(--ms-r-input)" />
      </div>

      <div
        className="ms-meta-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 22,
          padding: "20px 0",
          borderTop: "1px solid var(--ms-line)",
          borderBottom: "1px solid var(--ms-line)",
          maxWidth: 860,
        }}
      >
        <div>
          <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
            {t("suppressions.detail.origin")}
          </div>
          <div style={{ fontSize: 14, marginTop: 4, display: "flex" }}>
            <Skeleton width={120} height="1lh" />
          </div>
        </div>
        <div>
          <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
            {t("suppressions.detail.recipient")}
          </div>
          <div className="ms-mono" style={{ fontSize: 13, marginTop: 5, display: "flex" }}>
            <Skeleton width={180} height="1lh" />
          </div>
        </div>
        <div>
          <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
            {t("suppressions.detail.added")}
          </div>
          <div style={{ fontSize: 14, marginTop: 4, display: "flex" }}>
            <Skeleton width={140} height="1lh" />
          </div>
        </div>
      </div>
    </>
  );
}

export default function SuppressionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations("emails");
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  const query = useQuery(trpc.emails.suppressions.get.queryOptions({ id }, { retry: false }));
  const removeMutation = useMutation(
    trpc.emails.suppressions.remove.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.emails.suppressions.pathFilter());
        router.push("/emails/suppressions");
      },
    }),
  );

  if (query.isPending) {
    return <SuppressionDetailSkeleton />;
  }
  if (query.isError || !query.data) {
    return (
      <>
        <p style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}>
          {t("suppressions.detail.notFound")}
        </p>
        <Link href="/emails/suppressions" style={{ fontSize: "var(--ms-fs-ui)" }}>
          ← {t("suppressions.title")}
        </Link>
      </>
    );
  }

  const row = query.data;
  const bounce = (row.bounce as BounceData | null) ?? null;
  const diagnostic = bounce?.bouncedRecipients?.[0]?.diagnosticCode ?? null;
  const origin = [
    t(`suppressions.reason.${row.reason}`),
    ...(row.reason === "hard_bounce" && bounce?.bounceType
      ? [bounce.bounceType.toLowerCase()]
      : []),
  ].join(" — ");
  // ponytail: complaint feedbackType isn't fetched here, so complaints resolve
  // to the generic "complaint.other" guidance; pull the complaint event's
  // feedbackType into suppressions.get if per-type complaint copy is needed.
  const guidanceKey =
    row.reason === "hard_bounce"
      ? resolveBounceGuidance({
          bounceType: bounce?.bounceType ?? null,
          bounceSubType: bounce?.bounceSubType ?? null,
          diagnosticCode: diagnostic,
          recipientDomain: domainOf(row.email ?? null),
        }).key
      : row.reason === "complaint"
        ? resolveComplaintGuidance(null).key
        : null;

  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Crumb href="/emails" label={t("list.title")} />
            <Crumb href="/emails/suppressions" label={t("suppressions.title")} />
            <CrumbEnd label={t("suppressions.detail.breadcrumb")} />
          </>
        }
        title={row.email ?? "—"}
        actions={
          <button
            type="button"
            className="ms-btn ms-btn-destructive"
            disabled={removeMutation.isPending}
            onClick={() => removeMutation.mutate({ id: row.id })}
          >
            <BtnSpinner on={removeMutation.isPending} />
            {t("suppressions.remove")}
          </button>
        }
      />

      <div
        className="ms-meta-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 22,
          padding: "20px 0",
          borderTop: "1px solid var(--ms-line)",
          borderBottom: "1px solid var(--ms-line)",
          maxWidth: 860,
        }}
      >
        <div>
          <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
            {t("suppressions.detail.origin")}
          </div>
          <div style={{ fontSize: 14, marginTop: 4 }}>{origin}</div>
        </div>
        <div>
          <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
            {t("suppressions.detail.recipient")}
          </div>
          <div className="ms-mono" style={{ fontSize: 13, marginTop: 5, overflowWrap: "anywhere" }}>
            {row.email ?? "—"}
          </div>
        </div>
        <div>
          <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
            {t("suppressions.detail.added")}
          </div>
          <div style={{ fontSize: 14, marginTop: 4 }}>{formatUtcMinute(row.createdAt)}</div>
        </div>
      </div>

      {diagnostic ? (
        <>
          <div className="ms-microlabel" style={{ margin: "20px 0 8px" }}>
            {t("suppressions.detail.details")}
          </div>
          <div
            style={{
              position: "relative",
              background: "var(--ms-inset)",
              border: "1px solid var(--ms-line)",
              borderRadius: 10,
              padding: "14px 16px",
              maxWidth: 860,
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
              {diagnostic}
            </pre>
            <span style={{ position: "absolute", top: 10, right: 12 }}>
              <CopyGlyph value={diagnostic} />
            </span>
          </div>
        </>
      ) : null}

      {guidanceKey ? (
        <div style={{ maxWidth: 860 }}>
          <div className="ms-microlabel" style={{ margin: "20px 0 8px" }}>
            {t("bouncedDrawer.whatToDo")}
          </div>
          <GuidanceBlock guidanceKey={guidanceKey} />
        </div>
      ) : null}

      {row.reason === "hard_bounce" ? (
        <div style={{ fontSize: 12.5, color: "var(--ms-muted)", marginTop: 12, maxWidth: 860 }}>
          {t("suppressions.detail.removeNote")}
        </div>
      ) : null}
    </>
  );
}
