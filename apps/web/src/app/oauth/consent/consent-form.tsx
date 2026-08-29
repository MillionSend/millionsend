"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import styles from "@/components/auth/auth.module.css";
import { AuthScreen } from "@/components/auth/recovery-forms";
import { Select } from "@/components/select";
import { BtnSpinner } from "@/components/spinner";
import { authClient } from "@/lib/auth-client";
import { useTRPC } from "@/lib/trpc";

/** Sentinel option value for an all-teams grant (core's ALL_TEAMS_GRANT). */
const ALL_TEAMS = "*";
/** Grantable but not a permission toggle: it only drives refresh-token issuance. */
const OFFLINE_ACCESS = "offline_access";

export function ConsentForm({
  app,
  userEmail,
  scopes,
  teams,
  defaultTeamId,
}: {
  app: { name: string | null; uri: string | null } | null;
  userEmail: string;
  scopes: string[];
  teams: { teamId: string; teamName: string }[];
  defaultTeamId: string | null;
}) {
  const t = useTranslations("auth.consent");
  const trpc = useTRPC();
  const grantTeam = useMutation(trpc.team.grantTeam.mutationOptions());
  const [teamId, setTeamId] = useState(defaultTeamId ?? teams[0]?.teamId ?? "");
  const [granted, setGranted] = useState(() => new Set(scopes));
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);
  const [failed, setFailed] = useState(false);
  const appName = app?.name || t("unknownApp");
  const toggleable = scopes.filter((scope) => scope !== OFFLINE_ACCESS);
  const nothingGranted = toggleable.every((scope) => !granted.has(scope));

  function toggle(scope: string) {
    setGranted((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  async function decide(accept: boolean) {
    setPending(accept ? "allow" : "deny");
    setFailed(false);
    try {
      // The grant binds to session.activeTeamId, so the selection must be
      // persisted (and membership-checked) before consent is recorded.
      if (accept) await grantTeam.mutateAsync({ teamId });
      const kept = scopes.filter((scope) => granted.has(scope));
      const { data, error } = await authClient.oauth2.consent({
        accept,
        // Omitted = everything requested; sent only when the user unticked
        // something, so the provider records exactly the approved subset.
        ...(accept && kept.length < scopes.length ? { scope: kept.join(" ") } : {}),
      });
      if (error) throw error;
      // The auth client's redirect plugin already navigates on `redirect: true`;
      // this covers a response without that flag.
      if (data?.url) window.location.assign(data.url);
    } catch {
      setFailed(true);
      setPending(null);
    }
  }

  return (
    <AuthScreen title={t("title", { app: appName })}>
      <p className={styles.subline}>
        {app?.uri ? <a href={app.uri}>{appName}</a> : appName} {t("subline", { email: userEmail })}
      </p>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          decide(true);
        }}
      >
        <div className={`ms-field ${styles.field}`}>
          <label htmlFor="consent-team">{t("team")}</label>
          {teams.length > 0 ? (
            <Select
              id="consent-team"
              value={teamId}
              onChange={setTeamId}
              options={[
                ...teams.map((team) => ({ value: team.teamId, label: team.teamName })),
                ...(teams.length > 1 ? [{ value: ALL_TEAMS, label: t("allTeams") }] : []),
              ]}
              ariaLabel={t("team")}
              width="100%"
              disabled={pending !== null}
            />
          ) : (
            <p className={styles.notice} style={{ textAlign: "left" }}>
              {t("noTeam")} <Link href="/onboarding">{t("createTeam")}</Link>
            </p>
          )}
          <span style={{ fontSize: "var(--ms-fs-micro)", color: "var(--ms-faint)" }}>
            {teamId === ALL_TEAMS ? t("allTeamsNote") : t("teamNote")}
          </span>
        </div>
        <div className={`ms-field ${styles.field}`}>
          <span className="ms-microlabel">{t("permissions")}</span>
          <div style={{ marginTop: 6, display: "grid", gap: 6 }}>
            {toggleable.map((scope) => (
              <label
                key={scope}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: "var(--ms-fs-label)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  className="ms-checkbox"
                  checked={granted.has(scope)}
                  onChange={() => toggle(scope)}
                  disabled={pending !== null}
                />
                {t(`scopes.${scope.replace(":", "_")}`)}
              </label>
            ))}
          </div>
          {scopes.includes(OFFLINE_ACCESS) ? (
            <span style={{ fontSize: "var(--ms-fs-micro)", color: "var(--ms-faint)" }}>
              {t(`scopes.${OFFLINE_ACCESS}`)}
            </span>
          ) : null}
        </div>
        {failed ? (
          <p className={styles.error} role="alert">
            {t("error")}
          </p>
        ) : null}
        <button
          type="submit"
          className={`ms-btn ms-btn-primary ${styles.button}`}
          disabled={pending !== null || teams.length === 0 || nothingGranted}
        >
          <BtnSpinner on={pending === "allow"} />
          {t("allow")}
        </button>
        <button
          type="button"
          className={`ms-btn ms-btn-secondary ${styles.button}`}
          disabled={pending !== null}
          onClick={() => decide(false)}
        >
          <BtnSpinner on={pending === "deny"} />
          {t("deny")}
        </button>
      </form>
    </AuthScreen>
  );
}
