"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Switch } from "@/components/switch";
import { toPreviewTopics, UnsubscribePreview } from "@/components/unsubscribe-preview";
import { isHexColor } from "@/lib/hex-color";
import { isHttpUrl } from "@/lib/http-url";
import { useTRPC } from "@/lib/trpc";

interface Draft {
  brandName: string;
  message: string;
  successMessage: string;
  redirectUrl: string;
  backgroundColor: string;
  textColor: string;
  accentColor: string;
  hideBranding: boolean;
}

/** Trimmed empty strings persist as null, matching the router's clear semantics. */
function toNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Non-empty and not a valid #rrggbb — blocks submit and shows the red note. */
function badHex(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== "" && !isHexColor(trimmed);
}

function fieldLabelStyle(): React.CSSProperties {
  return {
    display: "block",
    fontSize: "var(--ms-fs-label)",
    color: "var(--ms-muted)",
    marginBottom: 6,
  };
}

function UnsubscribeSkeleton() {
  const t = useTranslations("settings.unsubscribe");
  return (
    <section className="ms-card" style={{ padding: 24, maxWidth: 640 }}>
      {[t("brandName"), t("message"), t("redirectUrl")].map((label) => (
        <div key={label} className="ms-field" style={{ marginBottom: 18 }}>
          <span style={fieldLabelStyle()}>{label}</span>
          <Skeleton width="100%" height={30} radius="var(--ms-r-input)" />
        </div>
      ))}
    </section>
  );
}

function ColorField({
  id,
  label,
  value,
  fallback,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  fallback: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("settings.unsubscribe");
  const trimmed = value.trim();
  return (
    <div className="ms-field">
      <label htmlFor={id}>{label}</label>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="color"
          aria-label={label}
          disabled={disabled}
          value={isHexColor(trimmed) ? trimmed : fallback}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: 30,
            height: 30,
            padding: 2,
            border: "1px solid var(--ms-line-strong)",
            borderRadius: "var(--ms-r-input)",
            background: "var(--ms-inset)",
            cursor: disabled ? "default" : "pointer",
          }}
        />
        <input
          id={id}
          type="text"
          className="ms-input ms-mono"
          style={{ width: 110 }}
          maxLength={7}
          disabled={disabled}
          placeholder={t("colorDefault")}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {badHex(value) ? <span className="ms-field-error">{t("colorInvalid")}</span> : null}
    </div>
  );
}

export function UnsubscribeView() {
  const t = useTranslations("settings.unsubscribe");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data } = useQuery(trpc.settings.unsubscribe.get.queryOptions());
  const { data: team } = useQuery(trpc.settings.team.get.queryOptions());
  const { data: topics } = useQuery(trpc.topics.list.queryOptions());
  const { data: teamList } = useQuery(trpc.team.list.queryOptions());
  const role = teamList?.teams.find((m) => m.teamId === teamList.activeTeamId)?.role;
  const canManage = role === "owner" || role === "admin";

  const [draft, setDraft] = useState<Draft | null>(null);
  const [previewState, setPreviewState] = useState<"confirm" | "saved">("confirm");
  const save = useMutation(
    trpc.settings.unsubscribe.update.mutationOptions({
      onSuccess: async () => {
        setDraft(null);
        await queryClient.invalidateQueries(trpc.settings.unsubscribe.get.queryFilter());
      },
    }),
  );

  if (!data) return <UnsubscribeSkeleton />;

  const form: Draft = draft ?? {
    brandName: data.brandName ?? "",
    message: data.message ?? "",
    successMessage: data.successMessage ?? "",
    redirectUrl: data.redirectUrl ?? "",
    backgroundColor: data.backgroundColor ?? "",
    textColor: data.textColor ?? "",
    accentColor: data.accentColor ?? "",
    hideBranding: data.hideBranding,
  };
  const set = (patch: Partial<Draft>) => setDraft({ ...form, ...patch });
  const redirectInvalid = form.redirectUrl.trim() !== "" && !isHttpUrl(form.redirectUrl.trim());
  const colorInvalid =
    badHex(form.backgroundColor) || badHex(form.textColor) || badHex(form.accentColor);
  const disabled = !canManage || save.isPending;
  // settings.team.get already nulls logoUrl when object storage is off.
  const logoAvailable = Boolean(team?.logoUrl);

  return (
    <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>
      <form
        style={{ flex: "1 1 360px", maxWidth: 480 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (redirectInvalid || colorInvalid) return;
          save.mutate({
            brandName: toNull(form.brandName),
            message: toNull(form.message),
            successMessage: toNull(form.successMessage),
            redirectUrl: toNull(form.redirectUrl),
            backgroundColor: toNull(form.backgroundColor),
            textColor: toNull(form.textColor),
            accentColor: toNull(form.accentColor),
            hideBranding: form.hideBranding,
          });
        }}
      >
        <section className="ms-card" style={{ padding: 24 }}>
          <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--ms-muted)" }}>
            {t("subtitle")}
          </p>

          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 16,
              marginBottom: 18,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <span style={fieldLabelStyle()}>{t("showLogo")}</span>
              <span style={{ display: "block", fontSize: 12, color: "var(--ms-muted)" }}>
                {logoAvailable ? t("showLogoNote") : t("showLogoMissing")}
              </span>
            </div>
            <Switch
              checked={form.hideBranding}
              disabled={disabled || !logoAvailable}
              onChange={(checked) => set({ hideBranding: checked })}
              ariaLabel={t("showLogo")}
            />
          </div>

          <p className="ms-microlabel" style={{ margin: "0 0 10px" }}>
            {t("colors")}
          </p>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 18 }}>
            <ColorField
              id="unsub-bg"
              label={t("colorBackground")}
              value={form.backgroundColor}
              fallback="#000000"
              disabled={disabled}
              onChange={(backgroundColor) => set({ backgroundColor })}
            />
            <ColorField
              id="unsub-text"
              label={t("colorText")}
              value={form.textColor}
              fallback="#f4f1ea"
              disabled={disabled}
              onChange={(textColor) => set({ textColor })}
            />
            <ColorField
              id="unsub-accent"
              label={t("colorAccent")}
              value={form.accentColor}
              fallback="#f4f1ea"
              disabled={disabled}
              onChange={(accentColor) => set({ accentColor })}
            />
          </div>

          <div className="ms-field" style={{ marginBottom: 18 }}>
            <label htmlFor="unsub-brand">{t("brandName")}</label>
            <input
              id="unsub-brand"
              type="text"
              className="ms-input"
              style={{ width: "100%" }}
              maxLength={80}
              disabled={disabled}
              placeholder={data?.teamName ?? t("brandNamePlaceholder")}
              value={form.brandName}
              onChange={(e) => set({ brandName: e.target.value })}
            />
          </div>

          <div className="ms-field" style={{ marginBottom: 18 }}>
            <label htmlFor="unsub-message">{t("message")}</label>
            <textarea
              id="unsub-message"
              className="ms-input"
              style={{ width: "100%", minHeight: 80, resize: "vertical" }}
              maxLength={500}
              disabled={disabled}
              placeholder={t("messagePlaceholder")}
              value={form.message}
              onChange={(e) => set({ message: e.target.value })}
            />
          </div>

          <div className="ms-field" style={{ marginBottom: 18 }}>
            <label htmlFor="unsub-success">{t("successMessage")}</label>
            <textarea
              id="unsub-success"
              className="ms-input"
              style={{ width: "100%", minHeight: 60, resize: "vertical" }}
              maxLength={500}
              disabled={disabled}
              placeholder={t("successMessagePlaceholder")}
              value={form.successMessage}
              onChange={(e) => set({ successMessage: e.target.value })}
            />
          </div>

          <div className="ms-field">
            <label htmlFor="unsub-redirect">{t("redirectUrl")}</label>
            <input
              id="unsub-redirect"
              type="url"
              className="ms-input"
              style={{ width: "100%" }}
              disabled={disabled}
              placeholder="https://example.com/goodbye"
              value={form.redirectUrl}
              onChange={(e) => set({ redirectUrl: e.target.value })}
            />
            <span
              style={{ display: "block", marginTop: 6, fontSize: 12, color: "var(--ms-muted)" }}
            >
              {t("redirectUrlNote")}
            </span>
            {redirectInvalid ? (
              <span className="ms-field-error">{t("redirectUrlInvalid")}</span>
            ) : null}
          </div>

          {canManage ? (
            <div
              style={{
                display: "flex",
                gap: 10,
                alignItems: "center",
                justifyContent: "flex-end",
                marginTop: 20,
              }}
            >
              {save.isSuccess && draft === null ? (
                <span style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)" }}>
                  ✓ {t("saved")}
                </span>
              ) : null}
              {save.isError ? (
                <span style={{ color: "var(--ms-danger)", fontSize: "var(--ms-fs-label)" }}>
                  {t("error")}
                </span>
              ) : null}
              <button
                type="submit"
                className="ms-btn ms-btn-secondary"
                disabled={disabled || redirectInvalid || colorInvalid}
              >
                <BtnSpinner on={save.isPending} />
                {t("save")}
              </button>
            </div>
          ) : null}
        </section>
      </form>

      <div style={{ flex: "1 1 380px", minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 10,
          }}
        >
          <p className="ms-microlabel" style={{ margin: 0 }}>
            {t("preview")}
          </p>
          <div className="ms-tabs">
            {(["confirm", "saved"] as const).map((state) => (
              <button
                key={state}
                type="button"
                className={previewState === state ? "active" : ""}
                onClick={() => setPreviewState(state)}
              >
                {state === "confirm" ? t("previewPreferences") : t("previewSuccess")}
              </button>
            ))}
          </div>
        </div>
        <UnsubscribePreview
          state={previewState}
          topics={toPreviewTopics(topics ?? [])}
          customization={{
            brandName: toNull(form.brandName) ?? data?.teamName ?? null,
            message: toNull(form.message),
            successMessage: toNull(form.successMessage),
            logoUrl: form.hideBranding && logoAvailable ? (team?.logoUrl ?? null) : null,
            backgroundColor: toNull(form.backgroundColor),
            textColor: toNull(form.textColor),
            accentColor: toNull(form.accentColor),
          }}
        />
      </div>
    </div>
  );
}
