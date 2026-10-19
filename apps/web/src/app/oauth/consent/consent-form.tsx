"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import styles from "@/components/auth/auth.module.css";
import { AuthScreen } from "@/components/auth/auth-screen";
import { Select } from "@/components/select";
import { BtnSpinner } from "@/components/spinner";
import { authClient } from "@/lib/auth-client";
import { GRANT_LIFETIME_DAYS, type GrantLifetime } from "@/lib/grant-lifetime";
import { useTRPC } from "@/lib/trpc";

/** Sentinel option value for an all-teams grant (core's ALL_TEAMS_GRANT). */
const ALL_TEAMS = "*";
/**
 * What keeps the app connected past the hour-long access token. The server
 * adds it to every MCP authorization, so it is granted with the rest and
 * never offered as a checkbox: unticked, the consent would no longer cover
 * the request and the screen would just come back.
 */
const OFFLINE_ACCESS = "offline_access";
/**
 * Scopes the dashboard reserves for owners/admins (adminProcedure); a member
 * is never offered them, mirroring the API's role check on the tools behind
 * them.
 */
const ADMIN_ONLY_SCOPES = ["domains:write", "webhooks:write", "api-keys:write"];

export function ConsentForm({
  app,
  userEmail,
  scopes,
  teams,
  defaultTeamId,
}: {
  app: {
    clientId: string;
    name: string | null;
    uri: string | null;
    redirectOrigins: string[];
  } | null;
  userEmail: string;
  scopes: string[];
  teams: { teamId: string; teamName: string; role: "owner" | "admin" | "member" }[];
  defaultTeamId: string | null;
}) {
  const t = useTranslations("auth.consent");
  const trpc = useTRPC();
  const grantTeam = useMutation(trpc.team.grantTeam.mutationOptions());
  const [teamId, setTeamId] = useState(defaultTeamId ?? teams[0]?.teamId ?? "");
  const [granted, setGranted] = useState(() => new Set(scopes));
  const [lifetime, setLifetime] = useState<GrantLifetime>("never");
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);
  const [failed, setFailed] = useState(false);
  const appName = app?.name || t("unknownApp");
  // An all-teams grant counts as a member grant only when the user is a
  // member everywhere; the API re-checks the role per team on each call.
  const memberOnly =
    teamId === ALL_TEAMS
      ? teams.every((team) => team.role === "member")
      : (teams.find((team) => team.teamId === teamId)?.role ?? "member") === "member";
  const visible = scopes.filter(
    (scope) => scope !== OFFLINE_ACCESS && !(memberOnly && ADMIN_ONLY_SCOPES.includes(scope)),
  );
  const nothingGranted = visible.every((scope) => !granted.has(scope));

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
      const kept = scopes.filter(
        (scope) => scope === OFFLINE_ACCESS || (visible.includes(scope) && granted.has(scope)),
      );
      // `lifetime` is this app's own field (server/auth hooks), so it is
      // missing from the provider's typed body and passed as a variable.
      const body = {
        accept,
        lifetime,
        // Omitted = everything requested; sent only when the user unticked
        // something, so the provider records exactly the approved subset.
        ...(accept && kept.length < scopes.length ? { scope: kept.join(" ") } : {}),
      };
      const { data, error } = await authClient.oauth2.consent(body);
      if (error) throw error;
      // The auth client's redirect plugin already navigates on `redirect: true`;
      // this covers a response without that flag. Never both: a custom-scheme
      // callback leaves the page loaded, so its app would get the code twice.
      if (data?.url && !data.redirect) window.location.assign(data.url);
    } catch {
      setFailed(true);
      setPending(null);
    }
  }

  return (
    <AuthScreen title={t("title", { app: appName })}>
      <p className={styles.subline}>
        {app?.uri ? (
          <a href={app.uri} target="_blank" rel="noopener noreferrer">
            {appName}
          </a>
        ) : (
          appName
        )}{" "}
        {t("subline", { email: userEmail })}
      </p>
      {app ? (
        <div
          style={{
            display: "grid",
            gap: 2,
            fontSize: "var(--ms-fs-micro)",
            color: "var(--ms-faint)",
            overflowWrap: "anywhere",
          }}
        >
          {app.redirectOrigins.length ? (
            <span>{t("redirectsTo", { origins: app.redirectOrigins.join(", ") })}</span>
          ) : null}
          <span>
            {t("clientId")} <span className="ms-mono">{app.clientId}</span>
          </span>
        </div>
      ) : null}
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
          <span
            style={{
              display: "block",
              lineHeight: 1.45,
              fontSize: "var(--ms-fs-micro)",
              color: "var(--ms-faint)",
            }}
          >
            {teamId === ALL_TEAMS ? t("allTeamsNote") : t("teamNote")}
          </span>
        </div>
        <div className={`ms-field ${styles.field}`}>
          <span className="ms-microlabel">{t("permissions")}</span>
          <div style={{ marginTop: 6, display: "grid", gap: 6 }}>
            {visible.map((scope) => (
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
        </div>
        <div className={`ms-field ${styles.field}`}>
          <label htmlFor="consent-lifetime">{t("stayConnected")}</label>
          <Select
            id="consent-lifetime"
            value={lifetime}
            onChange={(value) => setLifetime(value as GrantLifetime)}
            options={Object.keys(GRANT_LIFETIME_DAYS).map((value) => ({
              value,
              label: t(`lifetimes.${value}`),
            }))}
            ariaLabel={t("stayConnected")}
            width="100%"
            disabled={pending !== null}
          />
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
