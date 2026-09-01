"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { BtnSpinner } from "@/components/spinner";
import { OPEN_TRACKING_DOCS_URL } from "@/lib/docs-links";
import { useTRPC } from "@/lib/trpc";

// Client-side pre-check only; the router's zod schema is authoritative. A
// single lowercase DNS label — the CNAME host that sits under the domain.
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The branded-tracking onboarding surface, shared by the domain Configuration
 * tab (first setup and "change subdomain") and the add-domain wizard's optional
 * tracking step: pick a subdomain and the click/open options, preview the
 * tracked link, and save them together. Saving arms the CNAME that has to be
 * added and verified; a subdomain is required, so enabling tracking always
 * routes through here instead of a bare toggle flipping on.
 */
export function TrackingSetup({
  id,
  domainName,
  mailFromSubdomain,
  initialSubdomain,
  initialClick,
  initialOpen,
  heading = true,
  onSaved,
  onCancel,
}: {
  id: string;
  domainName: string;
  /** Return-path subdomain (default "send"); the tracking subdomain must differ. */
  mailFromSubdomain: string;
  initialSubdomain: string | null;
  initialClick: boolean;
  initialOpen: boolean;
  /** Off where the surrounding surface already titles the step (the add wizard). */
  heading?: boolean;
  onSaved?: () => void;
  /** When set, a Cancel button returns to the previous view (change mode). */
  onCancel?: (() => void) | undefined;
}) {
  const t = useTranslations("domains");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [subdomain, setSubdomain] = useState(initialSubdomain ?? "");
  const [click, setClick] = useState(initialClick);
  const [open, setOpen] = useState(initialOpen);

  const update = useMutation(
    trpc.domains.updateConfiguration.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.domains.get.queryKey({ id }) });
        void queryClient.invalidateQueries({ queryKey: trpc.domains.records.queryKey({ id }) });
        onSaved?.();
      },
    }),
  );

  const trimmed = subdomain.trim();
  const invalid = trimmed !== "" && !DNS_LABEL_RE.test(trimmed);
  const clashesReturnPath = trimmed !== "" && trimmed === mailFromSubdomain;
  const canSave = trimmed !== "" && !invalid && !clashesReturnPath;
  const previewHost = `${trimmed || t("detail.tracking.subdomainPlaceholder")}.${domainName}`;

  function save() {
    if (!canSave || update.isPending) return;
    update.mutate({ id, trackingSubdomain: trimmed, clickTracking: click, openTracking: open });
  }

  return (
    <div
      style={{
        maxWidth: 560,
        border: "1px solid var(--ms-line-strong)",
        borderRadius: "var(--ms-r-card)",
        background: "var(--ms-panel)",
        boxShadow: "var(--ms-shadow-card)",
        padding: 22,
        boxSizing: "border-box",
      }}
    >
      {heading ? (
        <>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--ms-bone)", margin: 0 }}>
            {t("detail.setup.title")}
          </h3>
          <p
            style={{ fontSize: 12.5, color: "var(--ms-muted)", margin: "6px 0 0", lineHeight: 1.5 }}
          >
            {t("detail.setup.subtitle")}
          </p>
        </>
      ) : null}

      {/* Subdomain / domain pair: <input> . <domain>. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: heading ? 16 : 0 }}>
        <div className="ms-field" style={{ flex: 1 }}>
          <input
            id="tracking-subdomain"
            type="text"
            className={`ms-input mono${invalid || clashesReturnPath ? " error" : ""}`}
            style={{ width: "100%" }}
            aria-label={t("detail.tracking.subdomain")}
            placeholder={t("detail.tracking.subdomainPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            disabled={update.isPending}
            value={subdomain}
            onChange={(e) => setSubdomain(e.target.value.trim().toLowerCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
        </div>
        <span
          className="ms-mono"
          style={{ fontSize: 13, color: "var(--ms-muted)", whiteSpace: "nowrap" }}
        >
          .{domainName}
        </span>
      </div>

      {invalid ? (
        <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ms-danger)" }}>
          {t("detail.tracking.subdomainError")}
        </p>
      ) : clashesReturnPath ? (
        <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ms-danger)" }}>
          {t("detail.tracking.subdomainReturnPathClash")}
        </p>
      ) : null}

      {/* Tracking options carried by the subdomain. */}
      <p className="ms-microlabel" style={{ margin: "18px 0 8px" }}>
        {t("detail.setup.options")}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
          <input
            type="checkbox"
            className="ms-checkbox"
            checked={click}
            disabled={update.isPending}
            onChange={(e) => setClick(e.target.checked)}
          />
          <span style={{ fontSize: 13.5, color: "var(--ms-bone)" }}>
            {t("detail.tracking.click")}
          </span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
          <input
            type="checkbox"
            className="ms-checkbox"
            checked={open}
            disabled={update.isPending}
            onChange={(e) => setOpen(e.target.checked)}
          />
          <span style={{ fontSize: 13.5, color: "var(--ms-bone)" }}>
            {t("detail.tracking.open")}
          </span>
        </label>
        <p
          style={{
            margin: "2px 0 0 28px",
            fontSize: 12,
            color: "var(--ms-muted)",
            lineHeight: 1.5,
          }}
        >
          {t("detail.tracking.openHint")}{" "}
          <a
            href={OPEN_TRACKING_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--ms-bone)", textDecoration: "underline" }}
          >
            {t("detail.tracking.openLearnMore")} ↗
          </a>
        </p>
      </div>

      {/* Live preview of the resulting tracked link. */}
      <div
        style={{
          marginTop: 18,
          border: "1px solid var(--ms-line)",
          borderRadius: "var(--ms-r-input)",
          background: "var(--ms-inset)",
          padding: "10px 12px",
        }}
      >
        <p className="ms-microlabel" style={{ margin: 0 }}>
          {t("detail.setup.preview")}
        </p>
        <p
          className="ms-mono"
          style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ms-bone)" }}
        >
          {t("detail.configuration.linkPreview", { host: previewHost })}
        </p>
      </div>

      {update.isError ? (
        <p style={{ margin: "12px 0 0", fontSize: 12.5, color: "var(--ms-danger)" }}>
          {update.error.message}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap" }}>
        <button
          type="button"
          className="ms-btn ms-btn-primary"
          disabled={!canSave || update.isPending}
          onClick={save}
        >
          <BtnSpinner on={update.isPending} />
          {t("detail.setup.save")}
        </button>
        {onCancel ? (
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            disabled={update.isPending}
            onClick={onCancel}
          >
            {t("detail.setup.cancel")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
