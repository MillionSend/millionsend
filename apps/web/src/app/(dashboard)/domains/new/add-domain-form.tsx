"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useTRPC } from "@/lib/trpc";
import { DOMAIN_REGIONS, type DomainRegion } from "../regions";

// Client-side pre-check only; the router's zod schema is authoritative.
const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const hintStyle: React.CSSProperties = {
  margin: "6px 0 0",
  color: "var(--ms-muted)",
  fontSize: "var(--ms-fs-label)",
};

function isConflict(error: unknown): boolean {
  return (error as { data?: { code?: string } } | null)?.data?.code === "CONFLICT";
}

export function AddDomainForm() {
  const t = useTranslations("domains");
  const router = useRouter();
  const trpc = useTRPC();
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

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!nameValid || create.isPending) return;
    create.mutate({ name, region, mailFromSubdomain: returnPath });
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 340px",
        gap: 24,
        alignItems: "start",
      }}
    >
      <form
        className="ms-card"
        style={{ padding: 24, display: "grid", gap: 20 }}
        onSubmit={onSubmit}
      >
        <div className="ms-field">
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

        <div className="ms-field">
          <label htmlFor="domain-region">{t("new.region")}</label>
          <select
            id="domain-region"
            className="ms-input"
            style={{ width: "100%" }}
            value={region}
            onChange={(e) => setRegion(e.target.value as DomainRegion)}
          >
            {DOMAIN_REGIONS.map((code) => (
              <option key={code} value={code}>
                {`${t(`regions.${code}`)} (${code})`}
              </option>
            ))}
          </select>
          <p style={hintStyle}>
            {t("new.regionHint")} <span className="ms-mono">{region}</span>
          </p>
        </div>

        <details>
          <summary
            style={{ cursor: "pointer", color: "var(--ms-muted)", fontSize: "var(--ms-fs-ui)" }}
          >
            {t("new.advanced")}
          </summary>
          <div className="ms-field" style={{ marginTop: 14 }}>
            <label htmlFor="domain-return-path">{t("new.returnPath")}</label>
            <input
              id="domain-return-path"
              type="text"
              className="ms-input mono"
              style={{ width: "100%" }}
              autoComplete="off"
              spellCheck={false}
              value={returnPath}
              onChange={(e) => setReturnPath(e.target.value.trim().toLowerCase())}
            />
            <p style={hintStyle}>{t("new.returnPathHint")}</p>
          </div>
        </details>

        {create.isError ? (
          <p style={{ margin: 0, color: "var(--ms-danger)", fontSize: "var(--ms-fs-label)" }}>
            {isConflict(create.error) ? t("new.conflict") : t("new.error")}
          </p>
        ) : null}

        <div>
          <button
            type="submit"
            className="ms-btn ms-btn-primary"
            disabled={create.isPending || name.length === 0}
          >
            {t("new.submit")}
          </button>
        </div>
      </form>

      <aside className="ms-card" style={{ padding: 24 }} aria-hidden="true">
        <p className="ms-microlabel" style={{ margin: 0 }}>
          {t("new.preview.title")}
        </p>
        <p style={{ margin: "14px 0 0", color: "var(--ms-bone)", fontSize: "var(--ms-fs-ui)" }}>
          {t("new.preview.fromName")}{" "}
          <span className="ms-mono" style={{ color: "var(--ms-muted)" }}>
            {`<${t("new.preview.user")}@${name || t("new.namePlaceholder")}>`}
          </span>
        </p>
        <p style={{ margin: "4px 0 0", color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)" }}>
          {t("new.preview.toMe")} ⌄
        </p>
      </aside>
    </div>
  );
}
