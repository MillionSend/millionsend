"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { isHttpUrl } from "@/lib/http-url";
import { useTRPC } from "@/lib/trpc";

interface Draft {
  brandName: string;
  message: string;
  redirectUrl: string;
}

/** Trimmed empty strings persist as null, matching the router's clear semantics. */
function toNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function UnsubscribeSkeleton() {
  const t = useTranslations("settings.unsubscribe");
  return (
    <section className="ms-card" style={{ padding: 24, maxWidth: 640 }}>
      {[t("brandName"), t("message"), t("redirectUrl")].map((label) => (
        <div key={label} className="ms-field" style={{ marginBottom: 18 }}>
          <span
            style={{
              display: "block",
              fontSize: "var(--ms-fs-label)",
              color: "var(--ms-muted)",
              marginBottom: 6,
            }}
          >
            {label}
          </span>
          <Skeleton width="100%" height={30} radius="var(--ms-r-input)" />
        </div>
      ))}
    </section>
  );
}

export function UnsubscribeView() {
  const t = useTranslations("settings.unsubscribe");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data } = useQuery(trpc.settings.unsubscribe.get.queryOptions());
  const { data: teamList } = useQuery(trpc.team.list.queryOptions());
  const role = teamList?.teams.find((m) => m.teamId === teamList.activeTeamId)?.role;
  const canManage = role === "owner" || role === "admin";

  const [draft, setDraft] = useState<Draft | null>(null);
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
    redirectUrl: data.redirectUrl ?? "",
  };
  const set = (patch: Partial<Draft>) => setDraft({ ...form, ...patch });
  const redirectInvalid = form.redirectUrl.trim() !== "" && !isHttpUrl(form.redirectUrl.trim());
  const disabled = !canManage || save.isPending;

  return (
    <form
      style={{ maxWidth: 640 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (redirectInvalid) return;
        save.mutate({
          brandName: toNull(form.brandName),
          message: toNull(form.message),
          redirectUrl: toNull(form.redirectUrl),
        });
      }}
    >
      <section className="ms-card" style={{ padding: 24 }}>
        <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--ms-muted)" }}>
          {t("subtitle")}
        </p>

        <div className="ms-field" style={{ marginBottom: 18 }}>
          <label htmlFor="unsub-brand">{t("brandName")}</label>
          <input
            id="unsub-brand"
            type="text"
            className="ms-input"
            style={{ width: "100%" }}
            maxLength={80}
            disabled={disabled}
            placeholder={t("brandNamePlaceholder")}
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
          <span style={{ marginTop: 6, fontSize: 12, color: "var(--ms-muted)" }}>
            {t("redirectUrlNote")}
          </span>
          {redirectInvalid ? (
            <span style={{ marginTop: 6, fontSize: 12, color: "var(--ms-danger)" }}>
              {t("redirectUrlInvalid")}
            </span>
          ) : null}
        </div>

        {canManage ? (
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 20 }}>
            <button
              type="submit"
              className="ms-btn ms-btn-secondary"
              disabled={disabled || redirectInvalid}
            >
              <BtnSpinner on={save.isPending} />
              {t("save")}
            </button>
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
          </div>
        ) : null}
      </section>
    </form>
  );
}
