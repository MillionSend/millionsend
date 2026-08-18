"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AuthShell } from "@/components/auth-shell";
import { BtnSpinner } from "@/components/spinner";
import { useTRPC } from "@/lib/trpc";

export function OnboardingForm() {
  const t = useTranslations("onboarding.team");
  const router = useRouter();
  const trpc = useTRPC();
  const [name, setName] = useState("");
  const createTeam = useMutation(
    trpc.team.createTeam.mutationOptions({
      // Stay on /onboarding: with the membership in place the server
      // re-renders this route as the send-your-first-email stepper.
      onSuccess: () => router.refresh(),
    }),
  );

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    createTeam.mutate({ name });
  }

  return (
    <AuthShell>
      <form onSubmit={onSubmit} style={{ display: "grid", gap: 16 }}>
        <h1 className="ms-display" style={{ fontSize: "var(--ms-fs-h2)", margin: 0 }}>
          {t("title")}
        </h1>
        <div className="ms-field">
          <label htmlFor="team-name">{t("teamName")}</label>
          <input
            id="team-name"
            type="text"
            className="ms-input"
            style={{ width: "100%" }}
            required
            maxLength={80}
            disabled={createTeam.isPending}
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
          disabled={createTeam.isPending}
        >
          <BtnSpinner on={createTeam.isPending} />
          {t("submit")}
        </button>
      </form>
    </AuthShell>
  );
}
