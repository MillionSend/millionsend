"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { AuthShell } from "@/components/auth-shell";
import { PlusGlyph } from "@/components/icons/nav-icons";
import { BtnSpinner } from "@/components/spinner";
import { TEAM_LOGO_ACCEPT } from "@/lib/image-type";
import { uploadTeamLogo } from "@/lib/team-logo-api";
import { useTRPC } from "@/lib/trpc";

export function OnboardingForm({ logoUploadsEnabled = false }: { logoUploadsEnabled?: boolean }) {
  const t = useTranslations("onboarding.team");
  const router = useRouter();
  const trpc = useTRPC();
  const [name, setName] = useState("");
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const createTeam = useMutation(
    trpc.team.createTeam.mutationOptions({
      // Stay on /onboarding: with the membership in place the server
      // re-renders this route as the send-your-first-email stepper.
      onSuccess: async ({ teamId }) => {
        // The team exists before the logo uploads; a failed upload must never
        // block onboarding — settings offers the retry.
        if (logoFile) await uploadTeamLogo(teamId, logoFile).catch(() => {});
        router.refresh();
      },
    }),
  );
  // isSuccess keeps the form locked through the logo upload and refresh.
  const busy = createTeam.isPending || createTeam.isSuccess;

  function pickLogo(file: File) {
    if (logoPreview) URL.revokeObjectURL(logoPreview);
    setLogoFile(file);
    setLogoPreview(URL.createObjectURL(file));
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    createTeam.mutate({ name });
  }

  return (
    <AuthShell>
      <form onSubmit={onSubmit} style={{ display: "grid", gap: 16 }}>
        <h1 className="ms-display" style={{ fontSize: "var(--ms-fs-h2)", margin: 0 }}>
          {t("title")}
        </h1>
        {logoUploadsEnabled ? (
          <div className="ms-field">
            {/* span, not label: the picker is a button, not a labelable input. Metrics mirror .ms-field label. */}
            <span
              style={{
                display: "block",
                fontSize: "var(--ms-fs-label)",
                color: "var(--ms-muted)",
                marginBottom: 6,
              }}
            >
              {t("logoLabel")}
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept={TEAM_LOGO_ACCEPT}
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) pickLogo(file);
                // Re-selecting the same file must fire change again.
                event.target.value = "";
              }}
            />
            <button
              type="button"
              aria-label={logoFile ? t("logoChange") : t("logoAdd")}
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
              style={{
                width: 56,
                height: 56,
                borderRadius: 17,
                padding: 0,
                overflow: "hidden",
                background: "var(--ms-panel-raised)",
                border: `1px ${logoPreview ? "solid" : "dashed"} var(--ms-line)`,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--ms-muted)",
              }}
            >
              {logoPreview ? (
                // biome-ignore lint/performance/noImgElement: local object-URL preview, nothing for next/image to optimize
                <img
                  src={logoPreview}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                />
              ) : (
                <PlusGlyph size={16} />
              )}
            </button>
          </div>
        ) : null}
        <div className="ms-field">
          <label htmlFor="team-name">{t("teamName")}</label>
          <input
            id="team-name"
            type="text"
            className="ms-input"
            style={{ width: "100%" }}
            required
            maxLength={80}
            disabled={busy}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {createTeam.isError ? (
          <p style={{ margin: 0, color: "var(--ms-danger)", fontSize: "var(--ms-fs-label)" }}>
            {t("error")}
          </p>
        ) : null}
        <button
          type="submit"
          className="ms-btn ms-btn-primary"
          style={{ justifyContent: "center" }}
          disabled={busy}
        >
          <BtnSpinner on={busy} />
          {t("submit")}
        </button>
      </form>
    </AuthShell>
  );
}
