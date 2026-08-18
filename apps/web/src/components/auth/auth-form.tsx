"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { safeNextPath } from "@/lib/nav";
import { passwordStrength } from "@/lib/password-strength";
import styles from "./auth.module.css";
import { SilkCanvas } from "./silk-canvas";
import { GitHubIcon, GoogleIcon } from "./social-icons";

const STRENGTH_TONES = ["", "var(--ms-danger)", "var(--ms-warn)", "var(--ms-success)"] as const;
const STRENGTH_KEYS = ["", "weak", "fair", "strong"] as const;

/** Three bars + a word under the signup password field; hidden while empty. */
function StrengthMeter({ password }: { password: string }) {
  const t = useTranslations("auth.strength");
  const score = passwordStrength(password);
  if (score === 0) return null;
  return (
    <div className={styles.strength} style={{ color: STRENGTH_TONES[score] }} aria-live="polite">
      <div className={styles.strengthBars}>
        {[1, 2, 3].map((bar) => (
          <span key={bar} className={bar <= score ? styles.strengthBarOn : styles.strengthBar} />
        ))}
      </div>
      <span className={styles.strengthLabel}>{t(STRENGTH_KEYS[score])}</span>
    </div>
  );
}

export type SocialProviderFlags = { google: boolean; github: boolean };
export type LegalLinks = { termsUrl: string | null; privacyUrl: string | null };
type SocialProvider = keyof SocialProviderFlags;

/**
 * The full login/signup screen. Server pages pass the env-derived provider
 * flags; everything else (fields, redirects, errors) lives client-side on
 * better-auth's client, as before the redesign.
 */
export function AuthForm({
  mode,
  providers,
  legal,
}: {
  mode: "login" | "signup";
  providers: SocialProviderFlags;
  legal: LegalLinks;
}) {
  const t = useTranslations(`auth.${mode}`);
  const tSocial = useTranslations("auth.social");
  const tLegal = useTranslations("auth.legal");
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
  // Login is email-first: the password field appears on the first "Sign in",
  // so the common flow starts as a single field. Signup shows everything.
  const [passwordShown, setPasswordShown] = useState(mode === "signup");
  const passwordRef = useRef<HTMLInputElement>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!passwordShown) {
      setPasswordShown(true);
      requestAnimationFrame(() => passwordRef.current?.focus());
      return;
    }
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
      {/* biome-ignore lint/performance/noImgElement: decorative full-bleed backdrop, no optimization needed */}
      <img src="/auth/waves-dark.webp" alt="" className={`ms-dark-only ${styles.backdrop}`} />
      {/* biome-ignore lint/performance/noImgElement: decorative full-bleed backdrop, no optimization needed */}
      <img src="/auth/waves-light.webp" alt="" className={`ms-light-only ${styles.backdrop}`} />
      <SilkCanvas />
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
        {anySocial ? (
          <div className={styles.social}>
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
          </div>
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
                placeholder={t("namePlaceholder")}
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
              placeholder={t("emailPlaceholder")}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {passwordShown ? (
            <div className={`ms-field ${styles.field}`}>
              <label htmlFor="password">{t("password")}</label>
              <input
                ref={passwordRef}
                id="password"
                type="password"
                className={`ms-input ${styles.control}`}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                placeholder={t("passwordPlaceholder")}
                required
                minLength={mode === "signup" ? 8 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {mode === "signup" ? <StrengthMeter password={password} /> : null}
            </div>
          ) : null}
          {errorMessage ? <p className={styles.error}>{errorMessage}</p> : null}
          <button
            type="submit"
            className={`ms-btn ms-btn-primary ${styles.button}`}
            disabled={pending !== null}
          >
            {t("submit")}
          </button>
        </form>
        {legal.termsUrl || legal.privacyUrl ? (
          <p className={styles.legal}>
            {tLegal.rich(
              // The sentence names only the documents that exist.
              `${mode}.${legal.termsUrl && legal.privacyUrl ? "both" : legal.termsUrl ? "terms" : "privacy"}`,
              {
                terms: (chunks) => (
                  <a href={legal.termsUrl ?? "#"} target="_blank" rel="noopener noreferrer">
                    {chunks}
                  </a>
                ),
                privacy: (chunks) => (
                  <a href={legal.privacyUrl ?? "#"} target="_blank" rel="noopener noreferrer">
                    {chunks}
                  </a>
                ),
              },
            )}
          </p>
        ) : null}
      </div>
    </main>
  );
}
