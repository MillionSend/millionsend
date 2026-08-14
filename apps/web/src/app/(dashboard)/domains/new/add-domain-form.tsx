"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Select } from "@/components/select";
import { useTRPC } from "@/lib/trpc";
import { DOMAIN_REGIONS, type DomainRegion, regionFlag } from "../regions";

// Client-side pre-check only; the router's zod schema is authoritative.
const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const hintStyle: React.CSSProperties = {
  margin: "6px 0 0",
  color: "var(--ms-muted)",
  fontSize: 12,
};

function isConflict(error: unknown): boolean {
  return (error as { data?: { code?: string } } | null)?.data?.code === "CONFLICT";
}

/** The canvas stepper rail: lit 01, hairline, faint 02. */
function StepRail() {
  return (
    <div
      aria-hidden="true"
      style={{
        width: 30,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        alignSelf: "stretch",
      }}
    >
      <span className="ms-mono" style={{ fontSize: 11, color: "var(--ms-bone)" }}>
        01
      </span>
      <span style={{ flex: 1, width: 1, background: "var(--ms-line)", marginTop: 6 }} />
      <span className="ms-mono" style={{ fontSize: 11, color: "var(--ms-faint)", marginTop: 6 }}>
        02
      </span>
    </div>
  );
}

export function AddDomainForm() {
  const t = useTranslations("domains");
  const router = useRouter();
  const trpc = useTRPC();
  const team = useQuery(trpc.settings.team.get.queryOptions());
  const [name, setName] = useState("");
  const [region, setRegion] = useState<DomainRegion>("us-east-1");
  const [returnPath, setReturnPath] = useState("send");
  const [touched, setTouched] = useState(false);

  const create = useMutation(
    trpc.domains.create.mutationOptions({
      onSuccess: ({ id }) => router.push(`/domains/${id}`),
    }),
  );

  const nameValid = HOSTNAME_RE.test(name);
  const showNameError = touched && name.length > 0 && !nameValid;
  const previewDomain = name || t("new.namePlaceholder");
  const teamName = team.data?.name ?? "";

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!nameValid || create.isPending) return;
    create.mutate({ name, region, mailFromSubdomain: returnPath });
  }

  return (
    <div style={{ display: "flex", gap: 44, alignItems: "flex-start" }}>
      <StepRail />

      <form
        onSubmit={onSubmit}
        style={{
          width: 520,
          flex: "none",
          background: "var(--ms-panel)",
          border: "1px solid var(--ms-line-strong)",
          borderRadius: "var(--ms-r-card)",
          padding: 24,
          boxSizing: "border-box",
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ms-bone)" }}>
          {t("new.cardTitle")}
        </div>

        <div className="ms-field" style={{ marginTop: 16 }}>
          <label htmlFor="domain-name">{t("new.name")}</label>
          <input
            id="domain-name"
            type="text"
            className={`ms-input mono${showNameError ? " error" : ""}`}
            style={{ width: "100%" }}
            placeholder={t("new.namePlaceholder")}
            autoComplete="off"
            spellCheck={false}
            value={name}
            onChange={(e) => setName(e.target.value.trim().toLowerCase())}
            onBlur={() => setTouched(true)}
          />
          {showNameError ? (
            <p style={{ ...hintStyle, color: "var(--ms-danger)" }}>{t("new.nameError")}</p>
          ) : (
            <p style={hintStyle}>{t("new.nameHint")}</p>
          )}
        </div>

        <div className="ms-field" style={{ marginTop: 14 }}>
          <label htmlFor="domain-region">{t("new.region")}</label>
          <Select
            id="domain-region"
            width="100%"
            value={region}
            onChange={(value) => setRegion(value as DomainRegion)}
            ariaLabel={t("new.region")}
            options={DOMAIN_REGIONS.map((code) => ({
              value: code,
              label: `${regionFlag(code)} ${t(`regions.${code}`)} (${code})`,
            }))}
          />
        </div>

        <div
          style={{
            background: "var(--ms-inset)",
            border: "1px solid var(--ms-line)",
            borderRadius: "var(--ms-r-input)",
            padding: "10px 13px",
            marginTop: 10,
          }}
        >
          <div className="ms-microlabel" style={{ fontSize: 10 }}>
            {t("new.recommended")}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ms-muted)", marginTop: 3 }}>
            {t("new.regionHint")}
          </div>
        </div>

        <details
          style={{
            marginTop: 18,
            borderTop: "1px solid var(--ms-line)",
            paddingTop: 14,
          }}
        >
          <summary
            style={{
              display: "flex",
              justifyContent: "space-between",
              cursor: "pointer",
              listStyle: "none",
              fontSize: 13.5,
              color: "var(--ms-bone)",
            }}
          >
            <span>{t("new.advanced")}</span>
            <span style={{ color: "var(--ms-muted)" }}>⌄</span>
          </summary>
          <div className="ms-field" style={{ marginTop: 14 }}>
            <label htmlFor="domain-return-path">{t("new.returnPath")}</label>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                id="domain-return-path"
                type="text"
                className="ms-input mono"
                style={{ width: 120 }}
                autoComplete="off"
                spellCheck={false}
                value={returnPath}
                onChange={(e) => setReturnPath(e.target.value.trim().toLowerCase())}
              />
              <span className="ms-mono" style={{ fontSize: 12, color: "var(--ms-muted)" }}>
                .{previewDomain}
              </span>
            </div>
            <p style={hintStyle}>{t("new.returnPathHint")}</p>
          </div>
        </details>

        {create.isError ? (
          <p style={{ margin: "14px 0 0", color: "var(--ms-danger)", fontSize: 13 }}>
            {isConflict(create.error) ? t("new.conflict") : t("new.error")}
          </p>
        ) : null}

        <button
          type="submit"
          className="ms-btn ms-btn-primary"
          style={{ marginTop: 20 }}
          disabled={create.isPending || name.length === 0}
        >
          {t("new.submit")}
        </button>
      </form>

      <div style={{ flex: 1, minWidth: 0 }} aria-hidden="true">
        <p className="ms-microlabel" style={{ margin: "0 0 10px" }}>
          {t("new.preview.title")}
        </p>
        <div
          style={{
            background: "#ffffff",
            borderRadius: 12,
            padding: "18px 20px",
            maxWidth: 460,
          }}
        >
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <span
              style={{
                width: 36,
                height: 36,
                borderRadius: "50%",
                background: "#111",
                color: "#fff",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 15,
                fontWeight: 600,
                flex: "none",
              }}
            >
              {teamName.charAt(0).toUpperCase() || "@"}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, color: "#1c1c1c", fontWeight: 600 }}>
                {teamName}{" "}
                <span style={{ fontWeight: 400, color: "#777" }}>
                  {`<${t("new.preview.user")}@${previewDomain}>`}
                </span>
              </div>
              <div style={{ fontSize: 12.5, color: "#999" }}>{t("new.preview.toMe")} ⌄</div>
            </div>
          </div>
          <div style={{ fontSize: 15, color: "#1c1c1c", fontWeight: 600, marginTop: 14 }}>
            {t("new.preview.subject")}
          </div>
          <div style={{ fontSize: 13, color: "#666", marginTop: 4 }}>
            {t("new.preview.snippet")}
          </div>
        </div>
        <div style={{ fontSize: 12, color: "var(--ms-muted)", marginTop: 10 }}>
          {t("new.preview.caption")}
        </div>
      </div>
    </div>
  );
}
