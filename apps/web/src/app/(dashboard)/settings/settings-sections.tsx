"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Select } from "@/components/select";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import type { AppLocale } from "@/i18n/request";
import { useTRPC } from "@/lib/trpc";

// Mirrors LOCALE_COOKIE in src/i18n/request.ts — that module reads
// next/headers and cannot be imported from client components.
const LOCALE_COOKIE = "NEXT_LOCALE";
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const LOCALE_OPTIONS: readonly AppLocale[] = ["en", "pt-BR"];

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="ms-card" style={{ padding: 24 }}>
      <h2
        className="ms-display"
        style={{ fontSize: "var(--ms-fs-h2)", color: "var(--ms-bone)", margin: "0 0 18px" }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function TeamSection() {
  const t = useTranslations("settings");
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: team } = useQuery(trpc.settings.team.get.queryOptions());
  const [draft, setDraft] = useState<string | null>(null);
  const rename = useMutation(
    trpc.settings.team.rename.mutationOptions({
      onSuccess: async () => {
        setDraft(null);
        await queryClient.invalidateQueries(trpc.settings.team.get.queryFilter());
        // Sidebar shows the team name from the server layout.
        router.refresh();
      },
    }),
  );
  if (!team) return null;

  const name = draft ?? team.name;
  return (
    <SectionCard title={t("team.title")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          rename.mutate({ name });
        }}
      >
        <div className="ms-field">
          <label htmlFor="settings-team-name">{t("team.name")}</label>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              id="settings-team-name"
              type="text"
              className="ms-input"
              style={{ flex: 1, maxWidth: 420 }}
              required
              maxLength={80}
              disabled={rename.isPending}
              value={name}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="submit" className="ms-btn ms-btn-secondary" disabled={rename.isPending}>
              <BtnSpinner on={rename.isPending} />
              {t("team.save")}
            </button>
            {rename.isSuccess && draft === null ? (
              <span style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)" }}>
                ✓ {t("team.saved")}
              </span>
            ) : null}
          </div>
        </div>
        {rename.isError ? (
          <p
            style={{ margin: "8px 0 0", color: "var(--ms-danger)", fontSize: "var(--ms-fs-label)" }}
          >
            {t("team.error")}
          </p>
        ) : null}
      </form>
      <div className="ms-kpi-row" style={{ display: "flex", gap: 48, marginTop: 22 }}>
        <div>
          <div className="ms-microlabel">{t("team.slug")}</div>
          <div className="ms-mono" style={{ marginTop: 4, color: "var(--ms-bone)" }}>
            {team.slug}
          </div>
        </div>
        <div>
          <div className="ms-microlabel">{t("team.plan")}</div>
          <div style={{ marginTop: 4 }}>
            <span className="ms-badge ms-badge-neutral">{t(`plans.${team.plan}`)}</span>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

function MembersSection() {
  const t = useTranslations("settings");
  const trpc = useTRPC();
  const { data: members } = useQuery(trpc.settings.members.list.queryOptions());
  if (!members) return null;

  return (
    <SectionCard title={t("members.title")}>
      <Table>
        <thead>
          <tr>
            <th>{t("members.name")}</th>
            <th>{t("members.email")}</th>
            <th>{t("members.role")}</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.email}>
              <td>{m.name}</td>
              <td className="ms-mono">{m.email}</td>
              <td>{t(`members.roles.${m.role}`)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </SectionCard>
  );
}

function LanguageSection() {
  const t = useTranslations("settings");
  const locale = useLocale();
  const router = useRouter();

  return (
    <SectionCard title={t("language.title")}>
      <div className="ms-field">
        <label htmlFor="settings-locale">{t("language.label")}</label>
        <Select
          id="settings-locale"
          width={260}
          value={locale}
          onChange={(value) => {
            // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API is unavailable in Safari.
            document.cookie = `${LOCALE_COOKIE}=${value}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}`;
            router.refresh();
          }}
          ariaLabel={t("language.label")}
          options={LOCALE_OPTIONS.map((value) => ({ value, label: t(`language.${value}`) }))}
        />
      </div>
    </SectionCard>
  );
}

export function SettingsSections() {
  return (
    <div style={{ display: "grid", gap: 20 }}>
      <TeamSection />
      <MembersSection />
      <LanguageSection />
    </div>
  );
}
