"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { CopyChip } from "@/components/copy-chip";
import { Skeleton } from "@/components/skeleton";
import { Tooltip } from "@/components/tooltip";
import { WarnCard } from "@/components/warn-card";
import { codeRichTags } from "@/lib/code-rich-tags";
import { SMTP_DOCS_URL } from "@/lib/docs-links";
import { useTRPC } from "@/lib/trpc";

function FieldRow({
  label,
  children,
  note,
}: {
  label: string;
  children: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 16,
        padding: "12px 0",
        borderBottom: "1px solid var(--ms-line)",
      }}
    >
      <div className="ms-microlabel" style={{ width: 96, flex: "none" }}>
        {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        {children}
        {note ? <span style={{ fontSize: 12, color: "var(--ms-muted)" }}>{note}</span> : null}
      </div>
    </div>
  );
}

export function SmtpView() {
  const t = useTranslations("settings.smtp");
  const trpc = useTRPC();
  const { data } = useQuery(trpc.settings.smtp.get.queryOptions());

  return (
    <div style={{ maxWidth: 720, display: "grid", gap: 20 }}>
      {data && !data.tlsConfigured ? (
        data.allowInsecureAuth ? (
          <p
            role="status"
            style={{ margin: 0, fontSize: 13, color: "var(--ms-muted)", lineHeight: 1.55 }}
          >
            {t.rich("insecureNote", codeRichTags)}
          </p>
        ) : (
          <WarnCard>
            <strong style={{ display: "block", marginBottom: 2 }}>{t("tlsWarnTitle")}</strong>
            {t.rich("tlsWarnBody", codeRichTags)}
          </WarnCard>
        )
      ) : null}
      <section className="ms-card" style={{ padding: 24 }}>
        <p style={{ margin: "0 0 4px", fontSize: 14, color: "var(--ms-bone)" }}>{t("intro")}</p>
        <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--ms-muted)" }}>
          {t("subtitle")}
        </p>

        <FieldRow label={t("host")}>
          {data ? (
            <CopyChip value={data.host} />
          ) : (
            <Skeleton width={200} height={26} radius="var(--ms-r-input)" />
          )}
        </FieldRow>

        <FieldRow label={t("port")} note={t("portNote")}>
          {data ? (
            <CopyChip value={String(data.port)} />
          ) : (
            <Skeleton width={72} height={26} radius="var(--ms-r-input)" />
          )}
        </FieldRow>

        <FieldRow label={t("user")}>
          {data ? (
            <CopyChip value={data.user} />
          ) : (
            <Skeleton width={120} height={26} radius="var(--ms-r-input)" />
          )}
        </FieldRow>

        <FieldRow
          label={t("password")}
          note={
            <>
              {t("passwordNote")} <Link href="/api-keys">{t("passwordLink")} →</Link>
            </>
          }
        >
          {data ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span className="ms-mono" style={{ fontSize: 13, color: "var(--ms-bone)" }}>
                {data.passwordPlaceholder}
              </span>
              <Tooltip text={t("passwordTooltip")} />
            </span>
          ) : (
            <Skeleton width={140} height={26} radius="var(--ms-r-input)" />
          )}
        </FieldRow>

        <p style={{ margin: "18px 0 0", fontSize: 13, color: "var(--ms-muted)" }}>
          <a href={SMTP_DOCS_URL} target="_blank" rel="noreferrer">
            {t("docs")} ↗
          </a>
        </p>
      </section>
    </div>
  );
}
