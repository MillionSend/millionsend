"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AuthShell } from "@/components/auth-shell";
import { authClient } from "@/lib/auth-client";

export default function SignupPage() {
  const t = useTranslations("auth.signup");
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setErrorMessage(null);
    const { error } = await authClient.signUp.email({ name, email, password });
    if (error) {
      // Server messages (e.g. the signup-disabled policy) are shown verbatim;
      // the catalog copy is only the fallback for messageless failures.
      setErrorMessage(error.message || t("error"));
      setPending(false);
      return;
    }
    router.push("/onboarding");
  }

  return (
    <AuthShell>
      <form onSubmit={onSubmit} style={{ display: "grid", gap: 16 }}>
        <h1 className="ms-display" style={{ fontSize: "var(--ms-fs-h2)", margin: 0 }}>
          {t("title")}
        </h1>
        <div className="ms-field">
          <label htmlFor="name">{t("name")}</label>
          <input
            id="name"
            type="text"
            className="ms-input"
            style={{ width: "100%" }}
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="ms-field">
          <label htmlFor="email">{t("email")}</label>
          <input
            id="email"
            type="email"
            className="ms-input"
            style={{ width: "100%" }}
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="ms-field">
          <label htmlFor="password">{t("password")}</label>
          <input
            id="password"
            type="password"
            className="ms-input"
            style={{ width: "100%" }}
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {errorMessage ? (
          <p style={{ margin: 0, color: "var(--ms-danger)", fontSize: "var(--ms-fs-label)" }}>
            {errorMessage}
          </p>
        ) : null}
        <button type="submit" className="ms-btn ms-btn-primary" disabled={pending}>
          {t("submit")}
        </button>
        <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)" }}>
          {t("haveAccount")} <Link href="/login">{t("loginLink")}</Link>
        </p>
      </form>
    </AuthShell>
  );
}
