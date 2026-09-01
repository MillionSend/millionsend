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

const optionHint: React.CSSProperties = {
  margin: "4px 0 0 28px",
  fontSize: 12,
  color: "var(--ms-muted)",
  lineHeight: 1.5,
};

/**
 * The branded-tracking onboarding form, shared by the Configuration tab's
 * "change subdomain" flow, the add-domain wizard's optional tracking step and
 * the standalone tracking onboarding: pick a subdomain and the click/open
 * options, then save. Saving arms the CNAME that has to be added and verified;
 * a subdomain is required, so enabling tracking always routes through here
 * rather than a bare toggle flipping on.
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
  // Held across the follow-up records refetch so the button keeps spinning until
  // the DNS record it produces is actually on screen, not just the write.
  const [saving, setSaving] = useState(false);

  const update = useMutation(trpc.domains.updateConfiguration.mutationOptions());

  const trimmed = subdomain.trim();
  const invalid = trimmed !== "" && !DNS_LABEL_RE.test(trimmed);
  const clashesReturnPath = trimmed !== "" && trimmed === mailFromSubdomain;
  const canSave = trimmed !== "" && !invalid && !clashesReturnPath;

  async function save() {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      await update.mutateAsync({
        id,
        trackingSubdomain: trimmed,
        clickTracking: click,
        openTracking: open,
      });
      // Wait for the records to reload so the DNS-record step below is populated
      // the moment the spinner stops.
      await queryClient.refetchQueries({ queryKey: trpc.domains.records.queryKey({ id }) });
      void queryClient.invalidateQueries({ queryKey: trpc.domains.get.queryKey({ id }) });
      onSaved?.();
    } catch {
      // Surfaced below via update.isError.
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="ms-card-glow"
      style={{ width: 520, maxWidth: "100%", padding: 22, boxSizing: "border-box" }}
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
            disabled={saving}
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

      {/* Tracking options, each with its own explainer. */}
      <p className="ms-microlabel" style={{ margin: "18px 0 10px" }}>
        {t("detail.setup.options")}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <input
              type="checkbox"
              className="ms-checkbox"
              checked={click}
              disabled={saving}
              onChange={(e) => setClick(e.target.checked)}
            />
            <span style={{ fontSize: 13.5, color: "var(--ms-bone)" }}>
              {t("detail.tracking.click")}
            </span>
          </label>
          <p style={optionHint}>{t("detail.tracking.clickHint")}</p>
        </div>
        <div>
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <input
              type="checkbox"
              className="ms-checkbox"
              checked={open}
              disabled={saving}
              onChange={(e) => setOpen(e.target.checked)}
            />
            <span style={{ fontSize: 13.5, color: "var(--ms-bone)" }}>
              {t("detail.tracking.open")}
            </span>
          </label>
          <p style={optionHint}>
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
          disabled={!canSave || saving}
          onClick={save}
        >
          <BtnSpinner on={saving} />
          {t("detail.setup.save")}
        </button>
        {onCancel ? (
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            disabled={saving}
            onClick={onCancel}
          >
            {t("detail.setup.cancel")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
