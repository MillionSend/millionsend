"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import styles from "./auth.module.css";
import { StrengthMeter } from "./auth-form";
import { SilkCanvas } from "./silk-canvas";

/** Same screen chrome as AuthForm, for the recovery and OAuth consent screens. */
export function AuthScreen({ title, children }: { title: string; children: React.ReactNode }) {
  const tCommon = useTranslations("common");
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
        <h1 className={`ms-display ${styles.headline}`}>{title}</h1>
        {children}
      </div>
    </main>
  );
}

/**
 * Email-in, neutral-message-out. The submitted view is identical for known,
 * unknown, and rate-limited addresses so this screen can never be used to
 * probe which emails have accounts; only a 429 adds a "try later" line, which
 * the server returns before touching the database.
 */
export function ForgotPasswordForm({
  minutes,
  initialEmail = "",
}: {
  minutes: number;
  initialEmail?: string;
}) {
  const t = useTranslations("auth.forgot");
  const [email, setEmail] = useState(initialEmail);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    // redirectTo becomes the callbackURL better-auth's emailed link lands on.
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: "/reset-password",
    });
    setRateLimited(error?.status === 429);
    setSent(true);
  }

  return (
    <AuthScreen title={t("title")}>
      {sent ? (
        <>
          <p className={styles.notice} aria-live="polite">
            {t("sent", { minutes })}
          </p>
          {rateLimited ? <p className={styles.notice}>{t("rateLimited")}</p> : null}
          <p className={styles.subline}>
            <Link href="/login">{t("backToLogin")}</Link>
          </p>
        </>
      ) : (
        <>
          <p className={styles.subline}>
            {t("subline")} <Link href="/login">{t("sublineLink")}</Link>
          </p>
          <form onSubmit={onSubmit} className={styles.form}>
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
            <button
              type="submit"
              className={`ms-btn ms-btn-primary ${styles.button}`}
              disabled={pending}
            >
              {t("submit")}
            </button>
          </form>
        </>
      )}
    </AuthScreen>
  );
}

/**
 * New password + confirm behind the emailed token. A null token (missing, or
 * better-auth's ?error=INVALID_TOKEN redirect) and a consumed/expired token on
 * submit both land in the same invalid view with a link to request a new one.
 */
export function ResetPasswordForm({ token }: { token: string | null }) {
  const t = useTranslations("auth.reset");
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<"form" | "done" | "invalid">(token ? "form" : "invalid");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!token) return;
    if (password !== confirm) {
      setErrorMessage(t("mismatch"));
      return;
    }
    setPending(true);
    setErrorMessage(null);
    const { error } = await authClient.resetPassword({ newPassword: password, token });
    if (error) {
      if (error.code === "INVALID_TOKEN") {
        setState("invalid");
      } else {
        setErrorMessage(error.message || t("error"));
        setPending(false);
      }
      return;
    }
    setState("done");
    // Server revoked every session; a beat to read the confirmation, then in.
    setTimeout(() => router.push("/login"), 1500);
  }

  return (
    <AuthScreen title={t("title")}>
      {state === "invalid" ? (
        <>
          <p className={styles.notice}>{t("invalid")}</p>
          <p className={styles.subline}>
            <Link href="/forgot-password">{t("requestNew")}</Link>
          </p>
        </>
      ) : state === "done" ? (
        <p className={styles.notice} aria-live="polite">
          {t("done")}
        </p>
      ) : (
        <form onSubmit={onSubmit} className={styles.form}>
          <div className={`ms-field ${styles.field}`}>
            <label htmlFor="password">{t("password")}</label>
            <input
              id="password"
              type="password"
              className={`ms-input ${styles.control}`}
              autoComplete="new-password"
              placeholder={t("passwordPlaceholder")}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <StrengthMeter password={password} />
          </div>
          <div className={`ms-field ${styles.field}`}>
            <label htmlFor="confirm">{t("confirm")}</label>
            <input
              id="confirm"
              type="password"
              className={`ms-input ${styles.control}`}
              autoComplete="new-password"
              placeholder={t("confirmPlaceholder")}
              required
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          {errorMessage ? <p className={styles.error}>{errorMessage}</p> : null}
          <button
            type="submit"
            className={`ms-btn ms-btn-primary ${styles.button}`}
            disabled={pending}
          >
            {t("submit")}
          </button>
        </form>
      )}
    </AuthScreen>
  );
}
