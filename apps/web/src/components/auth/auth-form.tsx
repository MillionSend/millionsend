"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { safeNextPath } from "@/lib/nav";
import styles from "./auth.module.css";
import { GitHubIcon, GoogleIcon } from "./social-icons";

export type SocialProviderFlags = { google: boolean; github: boolean };
type SocialProvider = keyof SocialProviderFlags;

/**
 * The full login/signup screen. Server pages pass the env-derived provider
 * flags; everything else (fields, redirects, errors) lives client-side on
 * better-auth's client, as before the redesign.
 */
export function AuthForm({
  mode,
  providers,
}: {
  mode: "login" | "signup";
  providers: SocialProviderFlags;
}) {
  const t = useTranslations(`auth.${mode}`);
  const tSocial = useTranslations("auth.social");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const params = useSearchParams();
  // An invited user carries ?next=/invite/... — signup sends them to accept
  // the invite rather than /onboarding (which would create a new team).
  const nextParam = params.get("next");
  const next = safeNextPath(nextParam, mode === "login" ? "/emails" : "/onboarding");
  // better-auth bounces failed OAuth callbacks to errorCallbackURL?error=code.
  const socialFailed = params.get("error") !== null;

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(
    socialFailed ? tSocial("error") : null,
  );
  const [pending, setPending] = useState<"email" | SocialProvider | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending("email");
    setErrorMessage(null);
    const { error } =
      mode === "login"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ name, email, password });
    if (error) {
      // Signup shows server messages (e.g. the signup-disabled policy)
      // verbatim; login never echoes the server, only the catalog copy.
      setErrorMessage((mode === "signup" && error.message) || t("error"));
      setPending(null);
      return;
    }
    // The dashboard layout guard bounces team-less users to /onboarding.
    router.push(next);
  }

  async function onSocial(provider: SocialProvider) {
    setPending(provider);
    setErrorMessage(null);
    const { error } = await authClient.signIn.social({
      provider,
      callbackURL: next,
      errorCallbackURL: mode === "login" ? "/login" : "/signup",
    });
    if (error) {
      setErrorMessage(error.message || tSocial("error"));
      setPending(null);
    }
  }

  const otherPage =
    mode === "login"
      ? `/signup?next=${encodeURIComponent(next)}`
      : nextParam
        ? `/login?next=${encodeURIComponent(next)}`
        : "/login";
  const anySocial = providers.google || providers.github;

  return (
    <main className={styles.screen}>
      <div className={styles.column}>
        {/* biome-ignore lint/performance/noImgElement: static SVG logo, nothing for next/image to optimize */}
        <img
          src="/logo/millionsend-wordmark.svg"
          className="ms-wordmark"
          alt={tCommon("appName")}
          height={22}
        />
        <h1 className={`ms-display ${styles.headline}`}>{t("title")}</h1>
        <p className={styles.subline}>
          {t("subline")} <Link href={otherPage}>{t("sublineLink")}</Link>
        </p>
        {providers.google ? (
          <button
            type="button"
            className={`ms-btn ms-btn-secondary ${styles.button}`}
            disabled={pending !== null}
            onClick={() => onSocial("google")}
          >
            <GoogleIcon />
            {tSocial("google")}
          </button>
        ) : null}
        {providers.github ? (
          <button
            type="button"
            className={`ms-btn ms-btn-secondary ${styles.button}`}
            disabled={pending !== null}
            onClick={() => onSocial("github")}
          >
            <GitHubIcon />
            {tSocial("github")}
          </button>
        ) : null}
        {anySocial ? <div className={styles.divider}>{tSocial("or")}</div> : null}
        <form onSubmit={onSubmit} className={styles.form}>
          {mode === "signup" ? (
            <div className={`ms-field ${styles.field}`}>
              <label htmlFor="name">{t("name")}</label>
              <input
                id="name"
                type="text"
                className={`ms-input ${styles.control}`}
                autoComplete="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          ) : null}
          <div className={`ms-field ${styles.field}`}>
            <label htmlFor="email">{t("email")}</label>
            <input
              id="email"
              type="email"
              className={`ms-input ${styles.control}`}
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className={`ms-field ${styles.field}`}>
            <label htmlFor="password">{t("password")}</label>
            <input
              id="password"
              type="password"
              className={`ms-input ${styles.control}`}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              minLength={mode === "signup" ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {errorMessage ? <p className={styles.error}>{errorMessage}</p> : null}
          <button
            type="submit"
            className={`ms-btn ms-btn-primary ${styles.button}`}
            disabled={pending !== null}
          >
            {t("submit")}
          </button>
        </form>
        <p className={styles.footnote}>
          {t(mode === "login" ? "noAccount" : "haveAccount")}{" "}
          <Link href={otherPage}>{t(mode === "login" ? "signupLink" : "loginLink")}</Link>
        </p>
      </div>
    </main>
  );
}
